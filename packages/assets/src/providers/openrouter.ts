import { AssetError } from "../error";
import { sanitizeEndpointIdentity } from "../endpoint";
import { assetOutputMediaForFormat } from "../media";
import { resolveAssetTarget } from "../resolve";
import type {
  AssetGenerationOptions,
  AssetGenerationRequest,
  AssetGenerationResult,
  AssetProvider,
  ImageModelTarget,
  ImageOutputFormat,
  ImageSize,
  ResolvedAssetGenerationRequest,
  ResolvedImageGenerationRequest,
} from "../types";
import { assetErrorFromResponse, retryAssetFetch } from "./retry";
import type { AssetRetryOptions } from "./retry";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const OPENROUTER_IMAGE_MODELS_ENDPOINT = `${OPENROUTER_ORIGIN}/api/v1/images/models`;
const OPENROUTER_IMAGE_ENDPOINT = sanitizeEndpointIdentity(`${OPENROUTER_ORIGIN}/api/v1/images`);

export interface OpenRouterAssetProviderOptions {
  /** BYOK credential kept exclusively in the closure that dispatches provider requests. */
  readonly apiKey: string;
  /** Required injectable generation transport. The portable package never uses global fetch. */
  readonly fetchImpl: typeof fetch;
  /** Optional separately injected discovery transport; defaults to the injected generation transport. */
  readonly discoveryFetchImpl?: typeof fetch;
  /**
   * Automatic target preference. Discovered matching IDs come first in this order; all other
   * supported targets use a deterministic lexical fallback. No catalog slug is implicit.
   */
  readonly modelPreference?: readonly string[];
  readonly retry?: AssetRetryOptions;
  readonly appUrl?: string;
  readonly appName?: string;
  readonly now?: () => Date;
}

/**
 * Rejects only an explicit unsupported modality before a host constructs this discovery-backed
 * image provider. Automatic audio resolution must omit OpenRouter and continue to later providers.
 */
export function assertOpenRouterRequestSupported(
  request: Pick<AssetGenerationRequest, "kind" | "providerId">,
): void {
  if (request.providerId === "openrouter" && request.kind === "audio") {
    throw new AssetError("unsupported-capability", {
      context: { providerId: "openrouter", kind: "audio" },
    });
  }
}

interface DiscoveredModel {
  readonly id: string;
}

interface OpenRouterImageSizeTransport {
  readonly parameter: "size" | "resolution";
  readonly sizes: readonly ImageSize[];
  readonly declaredValueBySize: ReadonlyMap<string, string>;
}

interface DiscoveredOpenRouterImageTarget {
  readonly target: ImageModelTarget;
  readonly sizeTransport?: OpenRouterImageSizeTransport;
}

interface OpenRouterImageTargetDiscovery {
  readonly targets: readonly ImageModelTarget[];
  readonly sizeTransportByTarget: ReadonlyMap<string, OpenRouterImageSizeTransport>;
}

/**
 * Builds an image-only OpenRouter provider from its declared endpoint capability data. Discovery
 * deliberately emits no target when a capability is absent instead of inferring vendor defaults.
 */
export async function openRouterAssetProvider(
  options: OpenRouterAssetProviderOptions,
): Promise<AssetProvider> {
  assertConstructionOptions(options);
  const discovery = await discoverOpenRouterImageTargetsWithTransport(options);

  const provider: AssetProvider = {
    id: "openrouter",
    capabilities: { kinds: ["image"] },
    targets: discovery.targets,
    async generate(request, generationOptions) {
      const resolved = resolveOpenRouterRequest(provider, request);
      return generateImage(resolved, options, generationOptions, discovery.sizeTransportByTarget);
    },
  };
  return provider;
}

/** Fetches model-specific endpoint declarations and converts only explicit capabilities to targets. */
export async function discoverOpenRouterImageTargets(
  options: OpenRouterAssetProviderOptions,
): Promise<readonly ImageModelTarget[]> {
  return (await discoverOpenRouterImageTargetsWithTransport(options)).targets;
}

async function discoverOpenRouterImageTargetsWithTransport(
  options: OpenRouterAssetProviderOptions,
): Promise<OpenRouterImageTargetDiscovery> {
  assertConstructionOptions(options);
  const fetchImpl = options.discoveryFetchImpl ?? options.fetchImpl;
  const indexResponse = await retryAssetFetch(
    fetchImpl,
    OPENROUTER_IMAGE_MODELS_ENDPOINT,
    { method: "GET", headers: openRouterHeaders(options.apiKey, options) },
    { ...options.retry, operation: "discovery" },
  );
  if (!indexResponse.ok) {
    throw await assetErrorFromResponse(indexResponse, { providerId: "openrouter", kind: "image" });
  }

  let indexPayload: unknown;
  try {
    indexPayload = await indexResponse.json();
  } catch {
    throw new AssetError("invalid-provider-response", {
      context: { providerId: "openrouter", kind: "image" },
    });
  }
  const models = parseModelIndex(indexPayload);
  if (models === undefined) {
    throw new AssetError("invalid-provider-response", {
      context: { providerId: "openrouter", kind: "image" },
    });
  }

  const targets: ImageModelTarget[] = [];
  const sizeTransportByTarget = new Map<string, OpenRouterImageSizeTransport>();
  for (const model of models) {
    const endpointDeclarations = await loadEndpointDeclarations(model, fetchImpl, options);
    for (const declaration of endpointDeclarations) {
      const discoveredTarget = targetFromDeclaration(model.id, declaration);
      if (discoveredTarget !== undefined) {
        targets.push(discoveredTarget.target);
        if (discoveredTarget.sizeTransport !== undefined) {
          sizeTransportByTarget.set(
            openRouterTargetIdentity(discoveredTarget.target),
            discoveredTarget.sizeTransport,
          );
        }
        break;
      }
    }
  }
  return {
    targets: sortDiscoveredTargets(targets, options.modelPreference),
    sizeTransportByTarget,
  };
}

async function loadEndpointDeclarations(
  model: DiscoveredModel,
  fetchImpl: typeof fetch,
  options: OpenRouterAssetProviderOptions,
): Promise<readonly unknown[]> {
  const endpointUrl = modelEndpointUrl(model.id);
  if (endpointUrl === undefined) return [];
  const response = await retryAssetFetch(
    fetchImpl,
    endpointUrl,
    { method: "GET", headers: openRouterHeaders(options.apiKey, options) },
    { ...options.retry, operation: "discovery" },
  );
  if (!response.ok) {
    throw await assetErrorFromResponse(response, {
      providerId: "openrouter",
      modelId: model.id,
      kind: "image",
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AssetError("invalid-provider-response", {
      context: { providerId: "openrouter", modelId: model.id, kind: "image" },
    });
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("endpoints" in payload) ||
    !Array.isArray(payload.endpoints)
  ) {
    throw new AssetError("invalid-provider-response", {
      context: { providerId: "openrouter", modelId: model.id, kind: "image" },
    });
  }
  return payload.endpoints;
}

function parseModelIndex(payload: unknown): readonly DiscoveredModel[] | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    return undefined;
  }

  const models = new Map<string, DiscoveredModel>();
  for (const value of payload.data) {
    if (value === null || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
      continue;
    if (modelEndpointUrl(value.id) === undefined) continue;
    models.set(value.id, { id: value.id });
  }
  return [...models.values()];
}

function modelEndpointUrl(modelId: string): string | undefined {
  const segments = modelId.split("/");
  if (
    segments.length !== 2 ||
    segments[0] === undefined ||
    segments[1] === undefined ||
    segments[0].length === 0 ||
    segments[1].length === 0 ||
    [...modelId].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    return undefined;
  }
  const url = new URL(
    `/api/v1/images/models/${encodeURIComponent(segments[0])}/${encodeURIComponent(segments[1])}/endpoints`,
    OPENROUTER_ORIGIN,
  );
  return url.origin === OPENROUTER_ORIGIN && url.search.length === 0 && url.hash.length === 0
    ? url.toString()
    : undefined;
}

function sortDiscoveredTargets(
  targets: readonly ImageModelTarget[],
  modelPreference: readonly string[] | undefined,
): readonly ImageModelTarget[] {
  const ranks = new Map<string, number>();
  for (const modelId of modelPreference ?? []) {
    if (!ranks.has(modelId)) ranks.set(modelId, ranks.size);
  }

  const byIdentity = new Map<string, ImageModelTarget>();
  for (const target of targets) {
    const identity = openRouterTargetIdentity(target);
    if (!byIdentity.has(identity)) byIdentity.set(identity, target);
  }

  return [...byIdentity.values()].sort((left, right) => {
    const leftRank = ranks.get(left.modelId);
    const rightRank = ranks.get(right.modelId);
    if (leftRank !== rightRank) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }

    const modelOrder = compareLexically(left.modelId, right.modelId);
    return modelOrder === 0
      ? compareLexically(sanitizeEndpointIdentity(left.endpoint), sanitizeEndpointIdentity(right.endpoint))
      : modelOrder;
  });
}

function compareLexically(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function targetFromDeclaration(
  modelId: string,
  declaration: unknown,
): DiscoveredOpenRouterImageTarget | undefined {
  if (declaration === null || typeof declaration !== "object") return undefined;
  const parameters = declaredParameters(declaration);
  if (parameters === undefined) return undefined;

  const outputFormats = declaredImageFormats(parameters);
  const backgrounds = declaredBackgrounds(parameters);
  // An alpha request is sound only when both the background and byte format say it is safe.
  const safeBackgrounds =
    backgrounds.includes("transparent") &&
    !outputFormats.some((format) => format === "png" || format === "webp")
      ? backgrounds.filter((background) => background !== "transparent")
      : backgrounds;
  if (outputFormats.length === 0 || safeBackgrounds.length === 0) return undefined;

  const sizeTransport = declaredImageSizeTransport(parameters);
  const sizes = sizeTransport?.sizes ?? [];
  const qualities = declaredStringValues(parameters, ["quality"]);
  return {
    target: {
      providerId: "openrouter",
      modelId,
      kind: "image",
      endpoint: OPENROUTER_IMAGE_ENDPOINT,
      capabilities: {
        outputFormats,
        backgrounds: safeBackgrounds,
        ...(sizes.length === 0 ? {} : { sizes }),
        ...(parameterIsExplicit(parameters, "seed") ? { supportsSeed: true } : {}),
        ...(qualities.length === 0 ? {} : { qualities }),
      },
      defaultParameters: {
        background: safeBackgrounds.includes("opaque") ? "opaque" : safeBackgrounds[0],
        ...(sizes[0] === undefined ? {} : { size: sizes[0] }),
        ...(qualities[0] === undefined ? {} : { quality: qualities[0] }),
      },
    },
    ...(sizeTransport === undefined ? {} : { sizeTransport }),
  };
}

function declaredParameters(declaration: object): Record<string, unknown> | undefined {
  if ("supported_parameters" in declaration && isRecord(declaration.supported_parameters)) {
    return declaration.supported_parameters;
  }
  if ("options" in declaration && isRecord(declaration.options)) return declaration.options;
  return undefined;
}

function declaredImageFormats(parameters: Record<string, unknown>): ImageOutputFormat[] {
  const formats = declaredStringValues(parameters, [
    "output_format",
    "output_formats",
    "image_format",
    "image_formats",
  ]);
  const result: ImageOutputFormat[] = [];
  for (const format of formats) {
    const normalized = format === "jpg" ? "jpeg" : format;
    if (
      (normalized === "png" || normalized === "jpeg" || normalized === "webp") &&
      !result.includes(normalized)
    ) {
      result.push(normalized);
    }
  }
  return result;
}

function declaredBackgrounds(parameters: Record<string, unknown>): ("opaque" | "transparent")[] {
  const values = declaredStringValues(parameters, ["background", "backgrounds"]);
  const result: ("opaque" | "transparent")[] = [];
  for (const value of values) {
    if ((value === "opaque" || value === "transparent") && !result.includes(value)) result.push(value);
  }
  return result;
}

function declaredImageSizeTransport(
  parameters: Record<string, unknown>,
): OpenRouterImageSizeTransport | undefined {
  const declarations = [
    { parameter: "size" as const, names: ["size", "sizes"] },
    { parameter: "resolution" as const, names: ["resolution", "resolutions"] },
  ];
  for (const declaration of declarations) {
    const sizes: ImageSize[] = [];
    const declaredValueBySize = new Map<string, string>();
    for (const value of declaredStringValues(parameters, declaration.names)) {
      const size = imageSizeFromDeclaredValue(value, declaration.parameter);
      if (size === undefined) continue;
      const canonicalSize = formatSize(size);
      if (declaredValueBySize.has(canonicalSize)) continue;
      sizes.push(size);
      declaredValueBySize.set(canonicalSize, value);
    }
    if (sizes.length > 0) return { parameter: declaration.parameter, sizes, declaredValueBySize };
  }
  return undefined;
}

function imageSizeFromDeclaredValue(
  value: string,
  parameter: OpenRouterImageSizeTransport["parameter"],
): ImageSize | undefined {
  const dimensionMatch = /^(\d+)x(\d+)$/.exec(value);
  if (dimensionMatch !== null) {
    const width = Number(dimensionMatch[1]);
    const height = Number(dimensionMatch[2]);
    if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
      return { width, height };
    }
  }

  if (parameter !== "resolution") return undefined;
  const kiloMatch = /^([1-9]\d*)K$/.exec(value);
  if (kiloMatch === null) return undefined;
  const kilopixels = Number(kiloMatch[1]);
  const dimension = kilopixels * 1024;
  return Number.isSafeInteger(kilopixels) && Number.isSafeInteger(dimension)
    ? { width: dimension, height: dimension }
    : undefined;
}

function declaredStringValues(parameters: Record<string, unknown>, names: readonly string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const declaration = parameters[name];
    const candidateValues = Array.isArray(declaration)
      ? declaration
      : isRecord(declaration) && Array.isArray(declaration.values)
        ? declaration.values
        : [];
    for (const value of candidateValues) {
      if (typeof value === "string" && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

function parameterIsExplicit(parameters: Record<string, unknown>, name: string): boolean {
  const declaration = parameters[name];
  return declaration !== undefined && declaration !== false;
}

async function generateImage(
  request: ResolvedImageGenerationRequest,
  providerOptions: OpenRouterAssetProviderOptions,
  generationOptions: AssetGenerationOptions | undefined,
  sizeTransportByTarget: ReadonlyMap<string, OpenRouterImageSizeTransport>,
): Promise<AssetGenerationResult> {
  const response = await retryAssetFetch(
    providerOptions.fetchImpl,
    OPENROUTER_IMAGE_ENDPOINT,
    {
      method: "POST",
      headers: openRouterHeaders(providerOptions.apiKey, providerOptions),
      body: JSON.stringify({
        model: request.target.modelId,
        prompt: request.prompt,
        n: 1,
        ...(request.parameters.size === undefined
          ? {}
          : openRouterSizeParameter(request.target, request.parameters.size, sizeTransportByTarget)),
        ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
        ...(request.parameters.seed === undefined ? {} : { seed: request.parameters.seed }),
        background: request.parameters.background,
        output_format: request.outputFormat,
        response_format: "b64_json",
      }),
      signal: generationOptions?.signal,
    },
    { ...providerOptions.retry, operation: "generation", retryStatuses: [] },
  );
  if (!response.ok) throw await assetErrorFromResponse(response, assetContext(request));

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AssetError("invalid-provider-response", { context: assetContext(request) });
  }
  const decoded = decodeOpenRouterImage(payload, request.outputFormat);
  if (decoded === undefined)
    throw new AssetError("invalid-provider-response", { context: assetContext(request) });

  const billing = reportedBilling(payload);
  return {
    bytes: decoded.bytes,
    mimeType: decoded.mimeType,
    extension: decoded.extension,
    createdAt: (providerOptions.now?.() ?? new Date()).toISOString(),
    ...(billing === undefined ? {} : { billing }),
  };
}

function openRouterSizeParameter(
  target: ResolvedImageGenerationRequest["target"],
  size: ImageSize,
  sizeTransportByTarget: ReadonlyMap<string, OpenRouterImageSizeTransport>,
): { readonly size: string } | { readonly resolution: string } {
  const canonicalSize = formatSize(size);
  const transport = sizeTransportByTarget.get(openRouterTargetIdentity(target));
  const declaredValue = transport?.declaredValueBySize.get(canonicalSize) ?? canonicalSize;
  return transport?.parameter === "resolution" ? { resolution: declaredValue } : { size: declaredValue };
}

function resolveOpenRouterRequest(
  provider: AssetProvider,
  request: ResolvedAssetGenerationRequest,
): ResolvedImageGenerationRequest {
  if (
    request.kind !== "image" ||
    request.target.providerId !== provider.id ||
    request.target.kind !== "image" ||
    sanitizeEndpointIdentity(request.target.endpoint) !== OPENROUTER_IMAGE_ENDPOINT
  ) {
    throw new AssetError("invalid-request", { context: { kind: request.kind } });
  }

  return resolveAssetTarget([provider], {
    kind: "image",
    providerId: provider.id,
    modelId: request.target.modelId,
    prompt: request.prompt,
    role: request.role,
    outputFormat: request.outputFormat,
    background: request.parameters.background,
    ...(request.parameters.size === undefined ? {} : { size: request.parameters.size }),
    ...(request.parameters.seed === undefined ? {} : { seed: request.parameters.seed }),
    ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
  }) as ResolvedImageGenerationRequest;
}

function decodeOpenRouterImage(
  payload: unknown,
  expectedFormat: ResolvedImageGenerationRequest["outputFormat"],
): { readonly bytes: Uint8Array; readonly mimeType: string; readonly extension: string } | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !Array.isArray(payload.data) ||
    payload.data.length !== 1 ||
    payload.data[0] === null ||
    typeof payload.data[0] !== "object" ||
    !("b64_json" in payload.data[0]) ||
    typeof payload.data[0].b64_json !== "string"
  ) {
    return undefined;
  }
  const expected = assetOutputMediaForFormat(expectedFormat);
  if (expected === undefined || expected.kind !== "image") return undefined;

  const encoded = payload.data[0].b64_json;
  if (
    encoded.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return undefined;
  }
  try {
    const binary = atob(encoded);
    return { bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)), ...expected };
  } catch {
    return undefined;
  }
}

function reportedBilling(payload: unknown): AssetGenerationResult["billing"] | undefined {
  if (payload === null || typeof payload !== "object" || !("usage" in payload) || !isRecord(payload.usage))
    return undefined;
  const amount = payload.usage.cost;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
  const currency = payload.usage.currency;
  // OpenRouter documents usage.cost in USD; accept a provider-supplied ISO currency when present.
  const safeCurrency = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return { chargeStatus: "charged", cost: { kind: "reported", amount, currency: safeCurrency } };
}

function openRouterHeaders(apiKey: string, options: OpenRouterAssetProviderOptions): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(options.appUrl === undefined ? {} : { "HTTP-Referer": options.appUrl }),
    ...(options.appName === undefined ? {} : { "X-Title": options.appName }),
  };
}

function assertConstructionOptions(options: OpenRouterAssetProviderOptions): void {
  if (
    typeof options.apiKey !== "string" ||
    options.apiKey.length === 0 ||
    typeof options.fetchImpl !== "function" ||
    !validModelPreference(options.modelPreference)
  ) {
    throw new AssetError("invalid-request");
  }
}

function validModelPreference(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((modelId) => typeof modelId === "string" && modelEndpointUrl(modelId) !== undefined))
  );
}

function formatSize(size: { readonly width: number; readonly height: number }): string {
  return `${size.width}x${size.height}`;
}

function openRouterTargetIdentity(target: Pick<ImageModelTarget, "modelId" | "endpoint">): string {
  return `${target.modelId}\u0000${sanitizeEndpointIdentity(target.endpoint)}`;
}

function assetContext(request: ResolvedImageGenerationRequest) {
  return { providerId: request.target.providerId, modelId: request.target.modelId, kind: "image" } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
