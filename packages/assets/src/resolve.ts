import { AssetError } from "./error";
import { sanitizeEndpointIdentity } from "./endpoint";
import type {
  AssetGenerationRequest,
  AssetProvider,
  AudioGenerationRequest,
  AudioModelTarget,
  AudioOutputFormat,
  ImageGenerationRequest,
  ImageModelTarget,
  ImageOutputFormat,
  ImageSize,
  ResolvedAssetGenerationRequest,
  ResolvedAudioGenerationRequest,
  ResolvedImageGenerationRequest,
} from "./types";

const imageOutputFormats: readonly ImageOutputFormat[] = ["png", "jpeg", "webp"];
const audioOutputFormats: readonly AudioOutputFormat[] = ["mp3", "wav", "opus", "aac", "flac", "pcm"];
const imageRoles: Readonly<Record<string, true>> = { background: true, sprite: true };
const audioRoles: Readonly<Record<string, true>> = { music: true, sfx: true, voice: true };

type CapabilityName = "background" | "output-format" | "quality" | "seed" | "size" | "speed" | "voice";

/**
 * Resolve against the caller's ordered provider array. The array order is part of the public
 * configuration contract: automatic requests use its first compatible non-deprecated target.
 */
export function resolveAssetTarget(
  providers: readonly AssetProvider[],
  request: AssetGenerationRequest,
): ResolvedAssetGenerationRequest {
  validateRequest(request);

  const candidates = selectProviders(providers, request);
  const modelWasRequested = request.modelId !== undefined;
  let modelWasFound = false;
  let firstCapabilityFailure: CapabilityName | undefined;

  for (const provider of candidates) {
    if (!provider.capabilities.kinds.includes(request.kind)) {
      if (request.providerId === provider.id) firstCapabilityFailure ??= "output-format";
      continue;
    }

    for (const target of provider.targets) {
      if (target.providerId !== provider.id) continue;
      if (request.modelId !== undefined && target.modelId !== request.modelId) continue;
      if (request.modelId !== undefined) modelWasFound = true;
      if (target.kind !== request.kind) continue;

      // A model id is an explicit opt-in. Provider/model defaults must never silently choose one.
      if (target.deprecated && !modelWasRequested) continue;

      if (target.kind === "image" && request.kind === "image") {
        const failure = incompatibleImageCapability(target, request);
        if (failure) {
          firstCapabilityFailure ??= failure;
          continue;
        }
        return resolveImageRequest(target, request);
      }

      if (target.kind === "audio" && request.kind === "audio") {
        const failure = incompatibleAudioCapability(target, request);
        if (failure) {
          firstCapabilityFailure ??= failure;
          continue;
        }
        return resolveAudioRequest(target, request);
      }
    }
  }

  if (request.modelId !== undefined && !modelWasFound) {
    throw new AssetError("unknown-model", {
      context: { providerId: request.providerId, modelId: request.modelId, kind: request.kind },
    });
  }

  if (request.providerId !== undefined && firstCapabilityFailure !== undefined) {
    throw new AssetError("unsupported-capability", {
      context: {
        providerId: request.providerId,
        modelId: request.modelId,
        kind: request.kind,
        capability: firstCapabilityFailure,
      },
    });
  }

  throw new AssetError("no-compatible-target", {
    context: { providerId: request.providerId, modelId: request.modelId, kind: request.kind },
  });
}

function selectProviders(
  providers: readonly AssetProvider[],
  request: AssetGenerationRequest,
): readonly AssetProvider[] {
  if (request.providerId === undefined) return providers;

  const provider = providers.find((candidate) => candidate.id === request.providerId);
  if (!provider) {
    throw new AssetError("unknown-provider", {
      context: { providerId: request.providerId, modelId: request.modelId, kind: request.kind },
    });
  }
  return [provider];
}

function validateRequest(request: AssetGenerationRequest): void {
  if (
    typeof request.prompt !== "string" ||
    (typeof request.providerId === "string" && request.providerId.length === 0)
  ) {
    throw new AssetError("invalid-request", { context: { kind: request.kind } });
  }
  if (typeof request.modelId === "string" && request.modelId.length === 0) {
    throw new AssetError("invalid-request", { context: { kind: request.kind } });
  }

  if (request.kind === "image") {
    if (!(request.role in imageRoles) || !imageOutputFormats.includes(request.outputFormat)) {
      throw new AssetError("invalid-request", { context: { kind: request.kind } });
    }
    if (request.background === "transparent" && request.outputFormat === "jpeg") {
      throw new AssetError("unsupported-capability", {
        context: { kind: request.kind, capability: "output-format" },
      });
    }
    if (request.size !== undefined && !isValidSize(request.size)) {
      throw new AssetError("invalid-request", { context: { kind: request.kind, capability: "size" } });
    }
    if (request.seed !== undefined && !Number.isInteger(request.seed)) {
      throw new AssetError("invalid-request", { context: { kind: request.kind, capability: "seed" } });
    }
    return;
  }

  if (!(request.role in audioRoles) || !audioOutputFormats.includes(request.outputFormat)) {
    throw new AssetError("invalid-request", { context: { kind: request.kind } });
  }
  if (request.voice !== undefined && request.voice.length === 0) {
    throw new AssetError("invalid-request", { context: { kind: request.kind, capability: "voice" } });
  }
  if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed <= 0)) {
    throw new AssetError("invalid-request", { context: { kind: request.kind, capability: "speed" } });
  }
}

function incompatibleImageCapability(
  target: ImageModelTarget,
  request: ImageGenerationRequest,
): CapabilityName | undefined {
  const background = request.background ?? target.defaultParameters?.background ?? "opaque";
  const size = request.size ?? target.defaultParameters?.size;
  const quality = request.quality ?? target.defaultParameters?.quality;

  if (!target.capabilities.outputFormats.includes(request.outputFormat)) return "output-format";
  if (!target.capabilities.backgrounds.includes(background)) return "background";
  if (background === "transparent" && request.outputFormat === "jpeg") return "output-format";
  if (size !== undefined && !supportsSize(target.capabilities.sizes, size)) return "size";
  if (request.seed !== undefined && target.capabilities.supportsSeed !== true) return "seed";
  if (quality !== undefined && !target.capabilities.qualities?.includes(quality)) return "quality";
  return undefined;
}

function incompatibleAudioCapability(
  target: AudioModelTarget,
  request: AudioGenerationRequest,
): CapabilityName | undefined {
  const voice = request.voice ?? target.defaultParameters?.voice;
  const speed = request.speed ?? target.defaultParameters?.speed;

  if (!target.capabilities.outputFormats.includes(request.outputFormat)) return "output-format";
  if (voice !== undefined && !target.capabilities.voices?.includes(voice)) return "voice";
  if (
    speed !== undefined &&
    (target.capabilities.speed === undefined ||
      speed < target.capabilities.speed.min ||
      speed > target.capabilities.speed.max)
  ) {
    return "speed";
  }
  return undefined;
}

function resolveImageRequest(
  target: ImageModelTarget,
  request: ImageGenerationRequest,
): ResolvedImageGenerationRequest {
  const size = request.size ?? target.defaultParameters?.size;
  const quality = request.quality ?? target.defaultParameters?.quality;
  const parameters: ResolvedImageGenerationRequest["parameters"] = {
    background: request.background ?? target.defaultParameters?.background ?? "opaque",
    ...(size === undefined ? {} : { size: copySize(size) }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(quality === undefined ? {} : { quality }),
  };

  return {
    target: {
      providerId: target.providerId,
      modelId: target.modelId,
      kind: target.kind,
      endpoint: sanitizeEndpointIdentity(target.endpoint),
      capabilities: target.capabilities,
    },
    kind: request.kind,
    prompt: request.prompt,
    role: request.role,
    outputFormat: request.outputFormat,
    parameters,
  };
}

function resolveAudioRequest(
  target: AudioModelTarget,
  request: AudioGenerationRequest,
): ResolvedAudioGenerationRequest {
  const voice = request.voice ?? target.defaultParameters?.voice;
  const speed = request.speed ?? target.defaultParameters?.speed;
  const parameters: ResolvedAudioGenerationRequest["parameters"] = {
    ...(voice === undefined ? {} : { voice }),
    ...(speed === undefined ? {} : { speed }),
  };

  return {
    target: {
      providerId: target.providerId,
      modelId: target.modelId,
      kind: target.kind,
      endpoint: sanitizeEndpointIdentity(target.endpoint),
      capabilities: target.capabilities,
    },
    kind: request.kind,
    prompt: request.prompt,
    role: request.role,
    outputFormat: request.outputFormat,
    parameters,
  };
}

function supportsSize(sizes: readonly ImageSize[] | undefined, requested: ImageSize): boolean {
  return (
    sizes?.some(
      (candidate) => candidate.width === requested.width && candidate.height === requested.height,
    ) ?? false
  );
}

function isValidSize(size: ImageSize): boolean {
  return (
    Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0
  );
}

function copySize(size: ImageSize): ImageSize {
  return { width: size.width, height: size.height };
}
