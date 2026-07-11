import { AssetError } from "../error";
import { sanitizeEndpointIdentity } from "../endpoint";
import { assetOutputMediaForFormat } from "../media";
import { resolveAssetTarget } from "../resolve";
import type {
  AssetGenerationOptions,
  AssetGenerationResult,
  AssetProvider,
  AudioModelTarget,
  ImageModelTarget,
  ResolvedAssetGenerationRequest,
  ResolvedAudioGenerationRequest,
  ResolvedImageGenerationRequest,
} from "../types";
import { assetErrorFromResponse, retryAssetFetch } from "./retry";
import type { AssetRetryOptions } from "./retry";

const OPENAI_IMAGE_ENDPOINT = sanitizeEndpointIdentity("https://api.openai.com/v1/images/generations");
const OPENAI_SPEECH_ENDPOINT = sanitizeEndpointIdentity("https://api.openai.com/v1/audio/speech");
const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export interface OpenAiAssetProviderOptions {
  /** BYOK credential kept exclusively in the closure that dispatches provider requests. */
  readonly apiKey: string;
  /** Required injectable transport. The portable package never reads or uses global fetch. */
  readonly fetchImpl: typeof fetch;
  /** Defaults to the current opaque GPT Image target. */
  readonly imageModel?: string;
  /** Defaults to gpt-image-1.5; it is explicit-only because OpenAI retires it in 2026. */
  readonly legacyTransparentImageModel?: string;
  /** Defaults to the current OpenAI TTS target. */
  readonly speechModel?: string;
  readonly retry?: AssetRetryOptions;
  /** Injectable timestamp source; response timestamps are intentionally not persisted. */
  readonly now?: () => Date;
}

/**
 * Direct OpenAI provider with fixed vendor endpoints. Target selection and capability validation
 * stays in the portable resolver; only a resolver-produced request can reach the vendor transport.
 */
export function openAiAssetProvider(options: OpenAiAssetProviderOptions): AssetProvider {
  assertConstructionOptions(options);
  const imageModel = options.imageModel ?? "gpt-image-2";
  const legacyTransparentImageModel = options.legacyTransparentImageModel ?? "gpt-image-1.5";
  const speechModel = options.speechModel ?? "gpt-4o-mini-tts";
  const targets: readonly (ImageModelTarget | AudioModelTarget)[] = [
    {
      providerId: "openai",
      modelId: imageModel,
      kind: "image",
      endpoint: OPENAI_IMAGE_ENDPOINT,
      capabilities: {
        outputFormats: ["png", "jpeg", "webp"],
        backgrounds: ["opaque"],
        sizes: standardImageSizes,
        qualities: ["low", "medium", "high", "auto"],
      },
      defaultParameters: {
        background: "opaque",
        size: { width: 1024, height: 1024 },
        quality: "auto",
      },
    },
    {
      providerId: "openai",
      modelId: legacyTransparentImageModel,
      kind: "image",
      endpoint: OPENAI_IMAGE_ENDPOINT,
      capabilities: {
        outputFormats: ["png", "jpeg", "webp"],
        backgrounds: ["opaque", "transparent"],
        sizes: standardImageSizes,
        qualities: ["low", "medium", "high", "auto"],
      },
      defaultParameters: {
        background: "opaque",
        size: { width: 1024, height: 1024 },
        quality: "auto",
      },
      deprecated: true,
    },
    {
      providerId: "openai",
      modelId: speechModel,
      kind: "audio",
      endpoint: OPENAI_SPEECH_ENDPOINT,
      capabilities: {
        outputFormats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
        voices: OPENAI_VOICES,
        speed: { min: 0.25, max: 4 },
      },
      defaultParameters: { voice: "alloy", speed: 1 },
    },
  ];

  const provider: AssetProvider = {
    id: "openai",
    capabilities: { kinds: ["image", "audio"] },
    targets,
    async generate(request, generationOptions) {
      const resolved = resolveOpenAiRequest(provider, request);
      if (resolved.kind === "image") return generateImage(resolved, options, generationOptions);
      return generateSpeech(resolved, options, generationOptions);
    },
  };
  return provider;
}

async function generateImage(
  request: ResolvedImageGenerationRequest,
  providerOptions: OpenAiAssetProviderOptions,
  generationOptions: AssetGenerationOptions | undefined,
): Promise<AssetGenerationResult> {
  const response = await retryAssetFetch(
    providerOptions.fetchImpl,
    OPENAI_IMAGE_ENDPOINT,
    {
      method: "POST",
      headers: openAiHeaders(providerOptions.apiKey),
      body: JSON.stringify({
        model: request.target.modelId,
        prompt: request.prompt,
        n: 1,
        ...(request.parameters.size === undefined ? {} : { size: formatSize(request.parameters.size) }),
        ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
        background: request.parameters.background,
        output_format: request.outputFormat,
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
  const bytes = decodeExpectedBase64(payload);
  if (bytes === undefined)
    throw new AssetError("invalid-provider-response", { context: assetContext(request) });

  const output = assetOutputMediaForFormat(request.outputFormat);
  if (output === undefined || output.kind !== "image") {
    throw new AssetError("invalid-request", { context: assetContext(request) });
  }
  return {
    bytes,
    mimeType: output.mimeType,
    extension: output.extension,
    createdAt: (providerOptions.now?.() ?? new Date()).toISOString(),
  };
}

async function generateSpeech(
  request: ResolvedAudioGenerationRequest,
  providerOptions: OpenAiAssetProviderOptions,
  generationOptions: AssetGenerationOptions | undefined,
): Promise<AssetGenerationResult> {
  if (
    request.prompt.length === 0 ||
    request.prompt.length > 4_096 ||
    request.parameters.voice === undefined
  ) {
    throw new AssetError("invalid-request", { context: assetContext(request) });
  }

  const output = assetOutputMediaForFormat(request.outputFormat);
  if (output === undefined || output.kind !== "audio") {
    throw new AssetError("invalid-request", { context: assetContext(request) });
  }

  const response = await retryAssetFetch(
    providerOptions.fetchImpl,
    OPENAI_SPEECH_ENDPOINT,
    {
      method: "POST",
      headers: openAiHeaders(providerOptions.apiKey),
      body: JSON.stringify({
        model: request.target.modelId,
        input: request.prompt,
        voice: request.parameters.voice,
        response_format: request.outputFormat,
        ...(request.parameters.speed === undefined ? {} : { speed: request.parameters.speed }),
        // Force a complete binary payload rather than an event stream so content can be hashed.
        stream_format: "audio",
      }),
      signal: generationOptions?.signal,
    },
    { ...providerOptions.retry, operation: "generation", retryStatuses: [] },
  );
  if (!response.ok) throw await assetErrorFromResponse(response, assetContext(request));
  const contentType = response.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== output.mimeType) {
    throw new AssetError("invalid-provider-response", { context: assetContext(request) });
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new AssetError("invalid-provider-response", { context: assetContext(request) });
  }
  if (bytes.byteLength === 0)
    throw new AssetError("invalid-provider-response", { context: assetContext(request) });

  return {
    bytes,
    mimeType: output.mimeType,
    extension: output.extension,
    contentTypeValidated: true,
    createdAt: (providerOptions.now?.() ?? new Date()).toISOString(),
  };
}

function resolveOpenAiRequest(
  provider: AssetProvider,
  request: ResolvedAssetGenerationRequest,
): ResolvedAssetGenerationRequest {
  const expectedEndpoint = request.kind === "image" ? OPENAI_IMAGE_ENDPOINT : OPENAI_SPEECH_ENDPOINT;
  if (
    request.target.providerId !== provider.id ||
    request.target.kind !== request.kind ||
    sanitizeEndpointIdentity(request.target.endpoint) !== expectedEndpoint
  ) {
    throw new AssetError("invalid-request", { context: { kind: request.kind } });
  }

  return request.kind === "image"
    ? resolveAssetTarget([provider], {
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
      })
    : resolveAssetTarget([provider], {
        kind: "audio",
        providerId: provider.id,
        modelId: request.target.modelId,
        prompt: request.prompt,
        role: request.role,
        outputFormat: request.outputFormat,
        ...(request.parameters.voice === undefined ? {} : { voice: request.parameters.voice }),
        ...(request.parameters.speed === undefined ? {} : { speed: request.parameters.speed }),
      });
}

function assertConstructionOptions(options: OpenAiAssetProviderOptions): void {
  if (
    typeof options.apiKey !== "string" ||
    options.apiKey.length === 0 ||
    typeof options.fetchImpl !== "function" ||
    (options.imageModel !== undefined && options.imageModel.length === 0) ||
    (options.legacyTransparentImageModel !== undefined && options.legacyTransparentImageModel.length === 0) ||
    (options.speechModel !== undefined && options.speechModel.length === 0)
  ) {
    throw new AssetError("invalid-request");
  }
}

function openAiHeaders(apiKey: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

function decodeExpectedBase64(payload: unknown): Uint8Array | undefined {
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

  const encoded = payload.data[0].b64_json;
  if (
    encoded.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return undefined;
  }
  try {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function formatSize(size: { readonly width: number; readonly height: number }): string {
  return `${size.width}x${size.height}`;
}

function assetContext(request: ResolvedAssetGenerationRequest) {
  return {
    providerId: request.target.providerId,
    modelId: request.target.modelId,
    kind: request.kind,
  } as const;
}

const standardImageSizes = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
] as const;
