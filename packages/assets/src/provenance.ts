import { AssetError } from "./error";
import { assetOutputMediaForFormat } from "./media";
import {
  isCanonicalEndpointIdentity,
  sameCanonicalEndpointIdentity,
  sanitizeEndpointIdentity,
} from "./endpoint";
import type {
  AssetCost,
  AssetGenerationMetadata,
  CanonicalValue,
  ImageSize,
  PostProcessingRecipe,
  ResolvedAssetGenerationRequest,
} from "./types";

export const ASSET_PROVENANCE_SCHEMA_VERSION = 1 as const;

export interface AssetProvenanceTarget {
  readonly providerId: string;
  readonly modelId: string;
  readonly kind: "image" | "audio";
  readonly endpoint: string;
}

export interface RedactedImageRequest {
  readonly kind: "image";
  readonly role: "background" | "sprite";
  readonly outputFormat: "png" | "jpeg" | "webp";
  readonly parameters: {
    readonly background: "opaque" | "transparent";
    readonly size?: ImageSize;
    readonly seed?: number;
    readonly quality?: string;
  };
}

export interface RedactedAudioRequest {
  readonly kind: "audio";
  readonly role: "music" | "sfx" | "voice";
  readonly outputFormat: "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
  readonly parameters: {
    readonly voice?: string;
    readonly speed?: number;
  };
}

/** Safe request metadata: it intentionally excludes the prompt, credentials, headers, and raw responses. */
export type RedactedAssetRequest = RedactedImageRequest | RedactedAudioRequest;

/** Private, persisted provenance. This is still deliberately redacted and safe to parse. */
export interface AssetProvenanceSidecar {
  readonly schemaVersion: typeof ASSET_PROVENANCE_SCHEMA_VERSION;
  readonly requestHash: string;
  /** SHA-256 of the exact prompt in its versioned hash payload; plaintext is never persisted. */
  readonly promptHash: string;
  readonly contentHash: string;
  readonly target: AssetProvenanceTarget;
  readonly request: RedactedAssetRequest;
  readonly mimeType: string;
  readonly extension: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly postProcessing: PostProcessingRecipe;
  readonly cost: AssetCost;
}

export interface AssetProvenanceBuildInput {
  readonly requestHash: string;
  readonly promptHash: string;
  readonly contentHash: string;
  readonly request: ResolvedAssetGenerationRequest;
  readonly metadata: AssetGenerationMetadata;
  readonly byteSize: number;
  readonly postProcessing: PostProcessingRecipe;
}

/**
 * Safe builder input for hosts that never receive a plaintext prompt. The endpoint and request
 * are parsed through the exact persisted-sidecar validation path before a sidecar is returned.
 */
export interface RedactedAssetProvenanceBuildInput {
  readonly requestHash: string;
  readonly promptHash: string;
  readonly contentHash: string;
  readonly target: AssetProvenanceTarget;
  readonly request: RedactedAssetRequest;
  readonly metadata: AssetGenerationMetadata;
  readonly byteSize: number;
  readonly postProcessing: PostProcessingRecipe;
}

export type ProvenanceParseResult =
  | { readonly success: true; readonly data: AssetProvenanceSidecar }
  | { readonly success: false; readonly issues: readonly [string] };

/**
 * Creates a sidecar with an allow-listed redacted request. Prompts and any provider response data
 * cannot enter this model because the builder does not accept them.
 */
export function buildAssetProvenanceSidecar(input: AssetProvenanceBuildInput): AssetProvenanceSidecar {
  return buildRedactedAssetProvenanceSidecar({
    requestHash: input.requestHash,
    promptHash: input.promptHash,
    contentHash: input.contentHash,
    target: {
      providerId: input.request.target.providerId,
      modelId: input.request.target.modelId,
      kind: input.request.target.kind,
      endpoint: sanitizeEndpointIdentity(input.request.target.endpoint),
    },
    request: redactResolvedAssetRequest(input.request),
    metadata: input.metadata,
    byteSize: input.byteSize,
    postProcessing: input.postProcessing,
  });
}

/**
 * Builds provenance from pre-redacted request data, for transports deliberately denied plaintext
 * prompts. It accepts only data the strict sidecar parser can persist.
 */
export function buildRedactedAssetProvenanceSidecar(
  input: RedactedAssetProvenanceBuildInput,
): AssetProvenanceSidecar {
  const sidecar: AssetProvenanceSidecar = {
    schemaVersion: ASSET_PROVENANCE_SCHEMA_VERSION,
    requestHash: input.requestHash,
    promptHash: input.promptHash,
    contentHash: input.contentHash,
    target: input.target,
    request: input.request,
    mimeType: input.metadata.mimeType,
    extension: input.metadata.extension,
    byteSize: input.byteSize,
    createdAt: input.metadata.createdAt,
    postProcessing: input.postProcessing,
    cost: input.metadata.billing?.cost ?? { kind: "unavailable" },
  };

  const parsed = parseAssetProvenanceSidecar(sidecar);
  if (!parsed.success) throw new AssetError("invalid-request");
  return parsed.data;
}

/**
 * Parses only the versioned, allow-listed sidecar shape. Unknown fields are rejected so persisted
 * credentials, raw provider responses, and unredacted prompts cannot be accepted accidentally.
 */
export function parseAssetProvenanceSidecar(value: unknown): ProvenanceParseResult {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, sidecarKeys)) return invalidSidecar();
  if (value.schemaVersion !== ASSET_PROVENANCE_SCHEMA_VERSION) return invalidSidecar();

  const requestHash = parseHash(value.requestHash);
  const promptHash = parseHash(value.promptHash);
  const contentHash = parseHash(value.contentHash);
  const target = parseTarget(value.target);
  const request = parseRedactedRequest(value.request);
  const mimeType = parseNonEmptyString(value.mimeType);
  const extension = parseExtension(value.extension);
  const byteSize = parseByteSize(value.byteSize);
  const createdAt = parseCreatedAt(value.createdAt);
  const postProcessing = parsePostProcessing(value.postProcessing);
  const cost = parseCost(value.cost);

  if (
    requestHash === undefined ||
    promptHash === undefined ||
    contentHash === undefined ||
    target === undefined ||
    request === undefined ||
    mimeType === undefined ||
    extension === undefined ||
    byteSize === undefined ||
    createdAt === undefined ||
    postProcessing === undefined ||
    cost === undefined
  ) {
    return invalidSidecar();
  }
  if (target.kind !== request.kind || !matchesCanonicalOutputMedia(request, mimeType, extension)) {
    return invalidSidecar();
  }

  return {
    success: true,
    data: {
      schemaVersion: ASSET_PROVENANCE_SCHEMA_VERSION,
      requestHash,
      promptHash,
      contentHash,
      target,
      request,
      mimeType,
      extension,
      byteSize,
      createdAt,
      postProcessing,
      cost,
    },
  };
}

/** A cache hit is valid only after the host has independently verified final persisted bytes. */
export function isVerifiedAssetCacheHit(
  sidecar: AssetProvenanceSidecar,
  requestHash: string,
  verifiedContentHash: string | undefined,
): boolean {
  return (
    verifiedContentHash !== undefined &&
    sidecar.requestHash === requestHash &&
    sidecar.contentHash === verifiedContentHash
  );
}

/**
 * Compares persisted, redacted provenance with a currently resolved request without retaining or
 * exposing its prompt. Hosts can use this alongside hash/content verification to reject tampered
 * target or request metadata before treating a cache entry as valid.
 */
export function matchesAssetProvenanceRequest(
  value: unknown,
  request: ResolvedAssetGenerationRequest,
): boolean {
  const parsed = parseAssetProvenanceSidecar(value);
  if (!parsed.success) return false;

  const { target, request: redacted } = parsed.data;
  const expected = redactResolvedAssetRequest(request);
  if (
    target.providerId !== request.target.providerId ||
    target.modelId !== request.target.modelId ||
    target.kind !== request.target.kind ||
    !sameCanonicalEndpointIdentity(target.endpoint, request.target.endpoint) ||
    redacted.kind !== expected.kind ||
    redacted.role !== expected.role ||
    redacted.outputFormat !== expected.outputFormat
  ) {
    return false;
  }

  if (!matchesCanonicalOutputMedia(expected, parsed.data.mimeType, parsed.data.extension)) return false;

  if (redacted.kind === "image" && expected.kind === "image") {
    return (
      redacted.parameters.background === expected.parameters.background &&
      redacted.parameters.size?.width === expected.parameters.size?.width &&
      redacted.parameters.size?.height === expected.parameters.size?.height &&
      redacted.parameters.seed === expected.parameters.seed &&
      redacted.parameters.quality === expected.parameters.quality
    );
  }
  if (redacted.kind === "audio" && expected.kind === "audio") {
    return (
      redacted.parameters.voice === expected.parameters.voice &&
      redacted.parameters.speed === expected.parameters.speed
    );
  }
  return false;
}

function matchesCanonicalOutputMedia(
  request: RedactedAssetRequest,
  mimeType: string,
  extension: string,
): boolean {
  const media = assetOutputMediaForFormat(request.outputFormat);
  return (
    media !== undefined &&
    media.kind === request.kind &&
    media.mimeType === mimeType &&
    media.extension === extension
  );
}

export function redactResolvedAssetRequest(request: ResolvedAssetGenerationRequest): RedactedAssetRequest {
  if (request.kind === "image") {
    const parameters: RedactedImageRequest["parameters"] = {
      background: request.parameters.background,
      ...(request.parameters.size === undefined ? {} : { size: copySize(request.parameters.size) }),
      ...(request.parameters.seed === undefined ? {} : { seed: request.parameters.seed }),
      ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
    };
    return {
      kind: request.kind,
      role: request.role,
      outputFormat: request.outputFormat,
      parameters,
    };
  }

  const parameters: RedactedAudioRequest["parameters"] = {
    ...(request.parameters.voice === undefined ? {} : { voice: request.parameters.voice }),
    ...(request.parameters.speed === undefined ? {} : { speed: request.parameters.speed }),
  };
  return {
    kind: request.kind,
    role: request.role,
    outputFormat: request.outputFormat,
    parameters,
  };
}

const sidecarKeys: readonly string[] = [
  "schemaVersion",
  "requestHash",
  "promptHash",
  "contentHash",
  "target",
  "request",
  "mimeType",
  "extension",
  "byteSize",
  "createdAt",
  "postProcessing",
  "cost",
];

function parseTarget(value: unknown): AssetProvenanceTarget | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["providerId", "modelId", "kind", "endpoint"])) {
    return undefined;
  }
  const providerId = parseNonEmptyString(value.providerId);
  const modelId = parseNonEmptyString(value.modelId);
  const endpoint = parseNonEmptyString(value.endpoint);
  const kind = value.kind;
  if (
    providerId === undefined ||
    modelId === undefined ||
    endpoint === undefined ||
    !isCanonicalEndpointIdentity(endpoint)
  ) {
    return undefined;
  }
  if (kind !== "image" && kind !== "audio") return undefined;
  return { providerId, modelId, kind, endpoint };
}

function parseRedactedRequest(value: unknown): RedactedAssetRequest | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (value.kind === "image") return parseRedactedImageRequest(value);
  if (value.kind === "audio") return parseRedactedAudioRequest(value);
  return undefined;
}

function parseRedactedImageRequest(value: Record<string, unknown>): RedactedImageRequest | undefined {
  if (!hasOnlyKeys(value, ["kind", "role", "outputFormat", "parameters"])) return undefined;
  const role = value.role;
  const outputFormat = value.outputFormat;
  const parameters = parseImageParameters(value.parameters);
  if (role !== "background" && role !== "sprite") return undefined;
  if (outputFormat !== "png" && outputFormat !== "jpeg" && outputFormat !== "webp") return undefined;
  if (parameters === undefined) return undefined;
  return { kind: "image", role, outputFormat, parameters };
}

function parseRedactedAudioRequest(value: Record<string, unknown>): RedactedAudioRequest | undefined {
  if (!hasOnlyKeys(value, ["kind", "role", "outputFormat", "parameters"])) return undefined;
  const role = value.role;
  const outputFormat = value.outputFormat;
  const parameters = parseAudioParameters(value.parameters);
  if (role !== "music" && role !== "sfx" && role !== "voice") return undefined;
  if (
    outputFormat !== "mp3" &&
    outputFormat !== "wav" &&
    outputFormat !== "opus" &&
    outputFormat !== "aac" &&
    outputFormat !== "flac" &&
    outputFormat !== "pcm"
  ) {
    return undefined;
  }
  if (parameters === undefined) return undefined;
  return { kind: "audio", role, outputFormat, parameters };
}

function parseImageParameters(value: unknown): RedactedImageRequest["parameters"] | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["background", "size", "seed", "quality"])) {
    return undefined;
  }
  const background = value.background;
  if (background !== "opaque" && background !== "transparent") return undefined;

  const size = value.size === undefined ? undefined : parseImageSize(value.size);
  const seed = value.seed === undefined ? undefined : parseInteger(value.seed);
  const quality = value.quality;
  if (value.size !== undefined && size === undefined) return undefined;
  if (value.seed !== undefined && seed === undefined) return undefined;
  if (quality !== undefined && (typeof quality !== "string" || quality.length === 0)) return undefined;

  return {
    background,
    ...(size === undefined ? {} : { size }),
    ...(seed === undefined ? {} : { seed }),
    ...(quality === undefined ? {} : { quality }),
  };
}

function parseAudioParameters(value: unknown): RedactedAudioRequest["parameters"] | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["voice", "speed"])) return undefined;
  const voice = value.voice;
  const speed = value.speed === undefined ? undefined : parsePositiveFiniteNumber(value.speed);
  if (voice !== undefined && (typeof voice !== "string" || voice.length === 0)) return undefined;
  if (value.speed !== undefined && speed === undefined) return undefined;
  return {
    ...(voice === undefined ? {} : { voice }),
    ...(speed === undefined ? {} : { speed }),
  };
}

function parseImageSize(value: unknown): ImageSize | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["width", "height"])) return undefined;
  const width = parsePositiveInteger(value.width);
  const height = parsePositiveInteger(value.height);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

function parsePostProcessing(value: unknown): PostProcessingRecipe | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["recipe", "version", "parameters"])) return undefined;
  const recipe = parseNonEmptyString(value.recipe);
  const version = parsePositiveInteger(value.version);
  const parameters = value.parameters === undefined ? undefined : parseCanonicalValue(value.parameters);
  if (recipe === undefined || version === undefined) return undefined;
  if (value.parameters !== undefined && parameters === undefined) return undefined;
  return { recipe, version, ...(parameters === undefined ? {} : { parameters }) };
}

function parseCost(value: unknown): AssetCost | undefined {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "unavailable") {
    return hasOnlyKeys(value, ["kind"]) ? { kind: "unavailable" } : undefined;
  }

  const amount = parseNonnegativeFiniteNumber(value.amount);
  const currency = value.currency;
  if (amount === undefined || !isCurrency(currency)) return undefined;

  if (value.kind === "reported") {
    return hasOnlyKeys(value, ["kind", "amount", "currency"])
      ? { kind: "reported", amount, currency }
      : undefined;
  }
  if (value.kind === "estimated") {
    const basis = parseNonEmptyString(value.basis);
    return hasOnlyKeys(value, ["kind", "amount", "currency", "basis"]) && basis !== undefined
      ? { kind: "estimated", amount, currency, basis }
      : undefined;
  }
  return undefined;
}

function parseCanonicalValue(value: unknown): CanonicalValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const parsed: CanonicalValue[] = [];
    for (const item of value) {
      const result = parseCanonicalValue(item);
      if (result === undefined) return undefined;
      parsed.push(result);
    }
    return parsed;
  }
  if (!isPlainRecord(value)) return undefined;

  const parsed: Record<string, CanonicalValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = parseCanonicalValue(item);
    if (result === undefined) return undefined;
    parsed[key] = result;
  }
  return parsed;
}

function parseHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function parseExtension(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9]+$/.test(value) ? value : undefined;
}

function parseInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parsePositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseNonnegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseByteSize(value: unknown): number | undefined {
  const byteSize = parseNonnegativeFiniteNumber(value);
  return byteSize !== undefined && Number.isSafeInteger(byteSize) ? byteSize : undefined;
}

function parseCreatedAt(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function copySize(size: ImageSize): ImageSize {
  return { width: size.width, height: size.height };
}

function invalidSidecar(): ProvenanceParseResult {
  return { success: false, issues: ["Invalid asset provenance sidecar."] };
}
