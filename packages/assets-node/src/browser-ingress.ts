import {
  assetOutputMediaForFormat,
  buildRedactedAssetProvenanceSidecar,
  classifyAssetError,
  hashAssetContent,
  sameCanonicalEndpointIdentity,
  sanitizeEndpointIdentity,
} from "@ludelier/assets";
import type {
  AssetBilling,
  AssetCost,
  AssetGenerationMetadata,
  AssetGenerationResult,
  AssetProvenanceTarget,
  AssetUsage,
  ImageSize,
  PostProcessingRecipe,
  RedactedAssetRequest,
  RedactedAudioRequest,
  RedactedImageRequest,
} from "@ludelier/assets";
import { AssetNodeProcessError, processGeneratedAsset, postProcessingRecipe } from "./process";
import type { ProcessedAsset } from "./process";
import { AssetNodePathError, AssetNodeReservationError, AssetNodeStore, AssetNodeWriteError } from "./store";
import type {
  AssetNodeCacheMissReason,
  AssetNodeCacheRequest,
  AssetNodeDestination,
  AssetNodeFilePaths,
  AssetNodePersistedAsset,
} from "./store";

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const OPENAI_AUDIO_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const OPENROUTER_IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";

export type BrowserGeneratedAssetFailureCode =
  | "invalid-request"
  | "crypto-unavailable"
  | "invalid-path"
  | "destination-conflict"
  | "invalid-output"
  | "processing-failed"
  | "write-failed";

/** Redacted failure data. Prompts, bytes, provider responses, headers, and credentials never escape. */
export interface BrowserGeneratedAssetFailure {
  readonly phase: "preflight" | "processing" | "write";
  readonly code: BrowserGeneratedAssetFailureCode;
  readonly retryable: boolean;
  readonly mayHaveCharged: boolean;
}

/** A validated P3 vendor identity that is safe to return to a browser. */
export interface BrowserGeneratedAssetTarget extends AssetProvenanceTarget {
  readonly providerId: "openai" | "openrouter";
}

/** A controlled destination reference with no filesystem root or absolute paths. */
export interface BrowserGeneratedAssetDestination {
  readonly storyId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly publicUrl: string;
}

/**
 * Process-local proof of a validated cache miss. Its public fields are safe to return to a browser,
 * but persistence requires this exact object identity and keeps store roots private.
 */
export interface BrowserGeneratedAssetReadyPreflight {
  readonly target: BrowserGeneratedAssetTarget;
  readonly request: RedactedAssetRequest;
  readonly destination: BrowserGeneratedAssetDestination;
  readonly requestHash: string;
}

/**
 * The browser payload contains only a redacted resolved request and its versioned hashes. Prompt
 * hashing happens before this call; plaintext prompts cannot be accepted by this ingress.
 */
export interface BrowserGeneratedAssetPreflightInput {
  readonly store: AssetNodeStore;
  readonly target: AssetProvenanceTarget;
  readonly request: RedactedAssetRequest;
  readonly requestHash: string;
  readonly promptHash: string;
  readonly destination: AssetNodeDestination;
}

export type BrowserGeneratedAssetPreflightResult =
  | { readonly status: "cache-hit"; readonly asset: AssetNodePersistedAsset }
  | { readonly status: "ready"; readonly preflight: BrowserGeneratedAssetReadyPreflight }
  | {
      readonly status: "failed";
      readonly failure: BrowserGeneratedAssetFailure;
      readonly cache?: AssetNodeCacheMissReason;
    };

/** Strict allow-list of metadata for processing and safe browser accounting. */
export interface BrowserGeneratedAssetGenerationMetadata
  extends Omit<AssetGenerationMetadata, "contentTypeValidated"> {
  readonly usage?: AssetUsage;
  readonly billing?: AssetBilling;
}

export interface BrowserGeneratedAssetPersistInput {
  readonly preflight: BrowserGeneratedAssetReadyPreflight;
  readonly bytes: Uint8Array;
  readonly metadata: BrowserGeneratedAssetGenerationMetadata;
}

export type BrowserGeneratedAssetPersistResult =
  | {
      readonly status: "stored";
      readonly asset: AssetNodePersistedAsset;
      readonly metadata: Pick<BrowserGeneratedAssetGenerationMetadata, "usage" | "billing">;
    }
  | { readonly status: "cache-hit"; readonly asset: AssetNodePersistedAsset }
  | { readonly status: "failed"; readonly failure: BrowserGeneratedAssetFailure };

interface PreparedBrowserGeneratedAsset {
  readonly store: AssetNodeStore;
  /** Contains only target identity and effective redacted request fields. */
  readonly request: AssetNodeCacheRequest;
  readonly paths: AssetNodeFilePaths;
  readonly postProcessing: PostProcessingRecipe;
  readonly target: BrowserGeneratedAssetTarget;
  readonly redactedRequest: RedactedAssetRequest;
  readonly requestHash: string;
  readonly promptHash: string;
}

const preparedBrowserAssets = new WeakMap<object, PreparedBrowserGeneratedAsset>();

/**
 * Validates the prompt-free browser payload and checks the controlled byte-verified cache before
 * provider spend. It never dispatches a provider and returns only redacted data.
 */
export async function preflightBrowserGeneratedAsset(
  input: BrowserGeneratedAssetPreflightInput,
): Promise<BrowserGeneratedAssetPreflightResult> {
  const rawInput: unknown = input;
  if (
    !isPlainRecord(rawInput) ||
    !hasOnlyKeys(rawInput, ["store", "target", "request", "requestHash", "promptHash", "destination"]) ||
    !(rawInput.store instanceof AssetNodeStore) ||
    !isHash(rawInput.requestHash) ||
    !isHash(rawInput.promptHash)
  ) {
    return failedPreflight("invalid-request");
  }

  const target = parseTarget(rawInput.target);
  const request = parseRedactedRequest(rawInput.request);
  const destination = parseDestination(rawInput.destination);
  if (
    target === undefined ||
    request === undefined ||
    destination === undefined ||
    target.kind !== request.kind ||
    (request.kind === "audio" && request.outputFormat === "pcm")
  ) {
    return failedPreflight("invalid-request");
  }

  const hostRequest = requestForHost(target, request);
  let postProcessing: PostProcessingRecipe;
  let paths: AssetNodeFilePaths;
  try {
    postProcessing = postProcessingRecipe(hostRequest);
    paths = await rawInput.store.prepareDestination(destination, hostRequest.outputFormat);
  } catch (error) {
    return { status: "failed", failure: preflightFailure(error) };
  }

  try {
    const cache = await rawInput.store.lookupCache(paths, hostRequest, rawInput.requestHash, postProcessing);
    if (cache.status === "hit") return { status: "cache-hit", asset: cache.asset };
    if (cache.occupied) {
      return {
        status: "failed",
        failure: {
          phase: "preflight",
          code: "destination-conflict",
          retryable: false,
          mayHaveCharged: false,
        },
        cache: cache.reason,
      };
    }

    const preflight: BrowserGeneratedAssetReadyPreflight = {
      target,
      request,
      destination: {
        storyId: paths.destination.storyId,
        assetId: paths.destination.assetId,
        relativePath: paths.destination.relativePath,
        publicUrl: paths.publicUrl,
      },
      requestHash: rawInput.requestHash,
    };
    preparedBrowserAssets.set(preflight, {
      store: rawInput.store,
      request: hostRequest,
      paths,
      postProcessing,
      target,
      redactedRequest: request,
      requestHash: rawInput.requestHash,
      promptHash: rawInput.promptHash,
    });
    return { status: "ready", preflight };
  } catch {
    return {
      status: "failed",
      failure: { phase: "preflight", code: "write-failed", retryable: true, mayHaveCharged: false },
    };
  }
}

/**
 * Validates browser-generated bytes, applies the Node recipe, and atomically stages final media and
 * redacted provenance. It performs no provider I/O and does not mutate Story metadata.
 */
export async function persistBrowserGeneratedAsset(
  input: BrowserGeneratedAssetPersistInput,
): Promise<BrowserGeneratedAssetPersistResult> {
  const rawInput: unknown = input;
  if (!isPlainRecord(rawInput) || !hasOnlyKeys(rawInput, ["preflight", "bytes", "metadata"])) {
    return failedPersist("invalid-request", "preflight", false);
  }
  if (!isReadyPreflight(rawInput.preflight)) return failedPersist("invalid-request", "preflight", false);

  const prepared = preparedBrowserAssets.get(rawInput.preflight);
  if (prepared === undefined) return failedPersist("invalid-request", "preflight", false);

  try {
    return await prepared.store.withDestinationReservation(prepared.paths, async () => {
      const cache = await prepared.store.lookupCache(
        prepared.paths,
        prepared.request,
        prepared.requestHash,
        prepared.postProcessing,
      );
      if (cache.status === "hit") return { status: "cache-hit", asset: cache.asset };
      if (cache.occupied) {
        return failedPersist("destination-conflict", "preflight", false);
      }
      if (!(rawInput.bytes instanceof Uint8Array)) return failedPersist("invalid-output", "processing", true);

      const metadata = parseGenerationMetadata(rawInput.metadata);
      if (metadata === undefined) return failedPersist("invalid-output", "processing", true);

      let processed: ProcessedAsset;
      try {
        const generated: AssetGenerationResult = { bytes: rawInput.bytes, ...metadata };
        processed = await processGeneratedAsset(prepared.request, generated);
      } catch (error) {
        return { status: "failed", failure: processingFailure(error) };
      }

      try {
        const contentHash = await hashAssetContent(processed.bytes);
        const provenance = buildRedactedAssetProvenanceSidecar({
          requestHash: prepared.requestHash,
          promptHash: prepared.promptHash,
          contentHash,
          target: prepared.target,
          request: prepared.redactedRequest,
          metadata: {
            ...metadata,
            mimeType: processed.mimeType,
            extension: processed.extension,
          },
          byteSize: processed.bytes.byteLength,
          postProcessing: prepared.postProcessing,
        });
        await prepared.store.stageAndCommit(prepared.paths, processed.bytes, provenance);
        return {
          status: "stored",
          asset: {
            storyId: prepared.paths.destination.storyId,
            assetId: prepared.paths.destination.assetId,
            relativePath: prepared.paths.destination.relativePath,
            publicUrl: prepared.paths.publicUrl,
            mimeType: provenance.mimeType,
            extension: provenance.extension,
            byteSize: provenance.byteSize,
            requestHash: provenance.requestHash,
            contentHash: provenance.contentHash,
            provenance,
          },
          metadata: {
            ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
            ...(metadata.billing === undefined ? {} : { billing: metadata.billing }),
          },
        };
      } catch (error) {
        if (error instanceof AssetNodeWriteError || error instanceof AssetNodePathError) {
          return failedPersist("write-failed", "write", true);
        }
        return { status: "failed", failure: processingFailure(error) };
      }
    });
  } catch (error) {
    if (error instanceof AssetNodeReservationError) {
      return {
        status: "failed",
        failure: { phase: "preflight", code: "write-failed", retryable: true, mayHaveCharged: false },
      };
    }
    return {
      status: "failed",
      failure: { phase: "write", code: "write-failed", retryable: true, mayHaveCharged: true },
    };
  }
}

function parseTarget(value: unknown): BrowserGeneratedAssetTarget | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["providerId", "modelId", "kind", "endpoint"]))
    return undefined;
  if (
    (value.providerId !== "openai" && value.providerId !== "openrouter") ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    (value.kind !== "image" && value.kind !== "audio") ||
    typeof value.endpoint !== "string"
  ) {
    return undefined;
  }

  let endpoint: string;
  try {
    endpoint = sanitizeEndpointIdentity(value.endpoint);
  } catch {
    return undefined;
  }
  const supported =
    (value.providerId === "openai" &&
      value.kind === "image" &&
      sameCanonicalEndpointIdentity(endpoint, OPENAI_IMAGE_ENDPOINT)) ||
    (value.providerId === "openai" &&
      value.kind === "audio" &&
      sameCanonicalEndpointIdentity(endpoint, OPENAI_AUDIO_ENDPOINT)) ||
    (value.providerId === "openrouter" &&
      value.kind === "image" &&
      sameCanonicalEndpointIdentity(endpoint, OPENROUTER_IMAGE_ENDPOINT));
  return supported
    ? { providerId: value.providerId, modelId: value.modelId, kind: value.kind, endpoint }
    : undefined;
}

function parseRedactedRequest(value: unknown): RedactedAssetRequest | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["kind", "role", "outputFormat", "parameters"]))
    return undefined;
  if (value.kind === "image") {
    if (
      (value.role !== "background" && value.role !== "sprite") ||
      !isImageOutputFormat(value.outputFormat) ||
      assetOutputMediaForFormat(value.outputFormat)?.kind !== "image"
    ) {
      return undefined;
    }
    const parameters = parseImageParameters(value.parameters);
    if (
      parameters === undefined ||
      (parameters.background === "transparent" && value.outputFormat === "jpeg") ||
      (value.role === "background" && parameters.size === undefined)
    ) {
      return undefined;
    }
    return { kind: "image", role: value.role, outputFormat: value.outputFormat, parameters };
  }
  if (value.kind === "audio") {
    if (
      (value.role !== "music" && value.role !== "sfx" && value.role !== "voice") ||
      !isAudioOutputFormat(value.outputFormat) ||
      assetOutputMediaForFormat(value.outputFormat)?.kind !== "audio"
    ) {
      return undefined;
    }
    const parameters = parseAudioParameters(value.parameters);
    return parameters === undefined
      ? undefined
      : { kind: "audio", role: value.role, outputFormat: value.outputFormat, parameters };
  }
  return undefined;
}

function parseImageParameters(value: unknown): RedactedImageRequest["parameters"] | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["background", "size", "seed", "quality"]))
    return undefined;
  const size = value.size === undefined ? undefined : parseSize(value.size);
  if (
    (value.background !== "opaque" && value.background !== "transparent") ||
    (value.size !== undefined && size === undefined) ||
    (value.seed !== undefined && !isSafeInteger(value.seed)) ||
    (value.quality !== undefined && (typeof value.quality !== "string" || value.quality.length === 0))
  ) {
    return undefined;
  }
  return {
    background: value.background,
    ...(size === undefined ? {} : { size }),
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(typeof value.quality === "string" ? { quality: value.quality } : {}),
  };
}

function parseAudioParameters(value: unknown): RedactedAudioRequest["parameters"] | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["voice", "speed"])) return undefined;
  if (
    (value.voice !== undefined && (typeof value.voice !== "string" || value.voice.length === 0)) ||
    (value.speed !== undefined && !isPositiveFiniteNumber(value.speed))
  ) {
    return undefined;
  }
  return {
    ...(typeof value.voice === "string" ? { voice: value.voice } : {}),
    ...(typeof value.speed === "number" ? { speed: value.speed } : {}),
  };
}

function parseDestination(value: unknown): AssetNodeDestination | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["storyId", "assetId", "relativePath"])) return undefined;
  if (
    typeof value.storyId !== "string" ||
    typeof value.assetId !== "string" ||
    typeof value.relativePath !== "string"
  ) {
    return undefined;
  }
  return { storyId: value.storyId, assetId: value.assetId, relativePath: value.relativePath };
}

function parseGenerationMetadata(value: unknown): BrowserGeneratedAssetGenerationMetadata | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["mimeType", "extension", "createdAt", "usage", "billing"])
  ) {
    return undefined;
  }
  if (
    typeof value.mimeType !== "string" ||
    value.mimeType.length === 0 ||
    typeof value.extension !== "string" ||
    value.extension.length === 0 ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0 ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    return undefined;
  }
  const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
  const billing = value.billing === undefined ? undefined : parseBilling(value.billing);
  if (
    (value.usage !== undefined && usage === undefined) ||
    (value.billing !== undefined && billing === undefined)
  ) {
    return undefined;
  }
  return {
    mimeType: value.mimeType,
    extension: value.extension,
    createdAt: value.createdAt,
    ...(usage === undefined ? {} : { usage }),
    ...(billing === undefined ? {} : { billing }),
  };
}

function parseUsage(value: unknown): AssetUsage | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["inputUnits", "outputUnits"])) return undefined;
  if (
    (value.inputUnits !== undefined && !isNonnegativeSafeInteger(value.inputUnits)) ||
    (value.outputUnits !== undefined && !isNonnegativeSafeInteger(value.outputUnits))
  ) {
    return undefined;
  }
  return {
    ...(typeof value.inputUnits === "number" ? { inputUnits: value.inputUnits } : {}),
    ...(typeof value.outputUnits === "number" ? { outputUnits: value.outputUnits } : {}),
  };
}

function parseBilling(value: unknown): AssetBilling | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["chargeStatus", "cost"])) return undefined;
  if (
    value.chargeStatus !== "not-charged" &&
    value.chargeStatus !== "charged" &&
    value.chargeStatus !== "unknown"
  ) {
    return undefined;
  }
  const cost = value.cost === undefined ? undefined : parseCost(value.cost);
  if (value.cost !== undefined && cost === undefined) return undefined;
  return { chargeStatus: value.chargeStatus, ...(cost === undefined ? {} : { cost }) };
}

function parseCost(value: unknown): AssetCost | undefined {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "unavailable") return hasOnlyKeys(value, ["kind"]) ? { kind: "unavailable" } : undefined;
  if (
    typeof value.amount !== "number" ||
    !Number.isFinite(value.amount) ||
    value.amount < 0 ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency)
  ) {
    return undefined;
  }
  if (value.kind === "reported") {
    return hasOnlyKeys(value, ["kind", "amount", "currency"])
      ? { kind: "reported", amount: value.amount, currency: value.currency }
      : undefined;
  }
  if (value.kind === "estimated") {
    return hasOnlyKeys(value, ["kind", "amount", "currency", "basis"]) &&
      typeof value.basis === "string" &&
      value.basis.length > 0
      ? { kind: "estimated", amount: value.amount, currency: value.currency, basis: value.basis }
      : undefined;
  }
  return undefined;
}

function requestForHost(
  target: BrowserGeneratedAssetTarget,
  request: RedactedAssetRequest,
): AssetNodeCacheRequest {
  if (request.kind === "image") {
    return {
      target: { ...target, kind: "image" },
      kind: "image",
      role: request.role,
      outputFormat: request.outputFormat,
      parameters: {
        background: request.parameters.background,
        ...(request.parameters.size === undefined ? {} : { size: { ...request.parameters.size } }),
        ...(request.parameters.seed === undefined ? {} : { seed: request.parameters.seed }),
        ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
      },
    };
  }
  return {
    target: { ...target, kind: "audio" },
    kind: "audio",
    role: request.role,
    outputFormat: request.outputFormat,
    parameters: {
      ...(request.parameters.voice === undefined ? {} : { voice: request.parameters.voice }),
      ...(request.parameters.speed === undefined ? {} : { speed: request.parameters.speed }),
    },
  };
}

function failedPreflight(code: BrowserGeneratedAssetFailureCode): BrowserGeneratedAssetPreflightResult {
  return {
    status: "failed",
    failure: { phase: "preflight", code, retryable: false, mayHaveCharged: false },
  };
}

function failedPersist(
  code: BrowserGeneratedAssetFailureCode,
  phase: BrowserGeneratedAssetFailure["phase"],
  mayHaveCharged: boolean,
): BrowserGeneratedAssetPersistResult {
  return { status: "failed", failure: { phase, code, retryable: false, mayHaveCharged } };
}

function preflightFailure(error: unknown): BrowserGeneratedAssetFailure {
  if (error instanceof AssetNodePathError) {
    return { phase: "preflight", code: "invalid-path", retryable: false, mayHaveCharged: false };
  }
  if (error instanceof AssetNodeProcessError) {
    return { phase: "preflight", code: error.code, retryable: false, mayHaveCharged: false };
  }
  const failure = classifyAssetError(error);
  return {
    phase: "preflight",
    code: failure.code === "crypto-unavailable" ? "crypto-unavailable" : "invalid-request",
    retryable: failure.retryable,
    mayHaveCharged: false,
  };
}

function processingFailure(error: unknown): BrowserGeneratedAssetFailure {
  if (error instanceof AssetNodeProcessError) {
    return { phase: "processing", code: error.code, retryable: false, mayHaveCharged: true };
  }
  return { phase: "processing", code: "processing-failed", retryable: false, mayHaveCharged: true };
}

function isReadyPreflight(value: unknown): value is BrowserGeneratedAssetReadyPreflight {
  return isPlainRecord(value) && preparedBrowserAssets.has(value);
}

function parseSize(value: unknown): ImageSize | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["width", "height"])) return undefined;
  if (!isPositiveSafeInteger(value.width) || !isPositiveSafeInteger(value.height)) return undefined;
  return { width: value.width, height: value.height };
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isImageOutputFormat(value: unknown): value is RedactedImageRequest["outputFormat"] {
  return value === "png" || value === "jpeg" || value === "webp";
}

function isAudioOutputFormat(value: unknown): value is RedactedAudioRequest["outputFormat"] {
  return (
    value === "mp3" ||
    value === "wav" ||
    value === "opus" ||
    value === "aac" ||
    value === "flac" ||
    value === "pcm"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
