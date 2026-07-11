import { AssetError } from "./error";
import type {
  PostProcessingRecipe,
  ResolvedAudioGenerationRequest,
  ResolvedImageGenerationRequest,
} from "./types";

/**
 * The resolved fields that determine final host post-processing and request-cache identity.
 * This projection deliberately excludes prompt text, credentials, provider response data, and I/O.
 */
export type AssetPostProcessingRequest =
  | Pick<ResolvedImageGenerationRequest, "kind" | "role" | "outputFormat" | "parameters">
  | Pick<ResolvedAudioGenerationRequest, "kind" | "role" | "outputFormat" | "parameters">;

const AUDIO_NOOP_RECIPE = {
  recipe: "ludelier.audio.noop",
  version: 1,
} as const satisfies PostProcessingRecipe;

const BACKGROUND_COVER_RECIPE = {
  recipe: "ludelier.image.background-cover",
  version: 1,
} as const satisfies PostProcessingRecipe;

const SPRITE_ALPHA_TRIM_RECIPE = {
  recipe: "ludelier.image.sprite-alpha-trim",
  version: 1,
} as const satisfies PostProcessingRecipe;

/**
 * Selects the complete, versioned recipe for the effective output request without importing a
 * host processor. Node and browser callers must hash this exact result before persistence.
 */
export function selectAssetPostProcessingRecipe(request: AssetPostProcessingRequest): PostProcessingRecipe {
  if (request.kind === "audio") return AUDIO_NOOP_RECIPE;

  if (request.role === "background") {
    const size = request.parameters.size;
    if (size === undefined) {
      throw new AssetError("invalid-request", { context: { kind: "image", capability: "size" } });
    }
    return {
      ...BACKGROUND_COVER_RECIPE,
      parameters: {
        width: size.width,
        height: size.height,
        fit: "cover",
        position: "centre",
        outputFormat: request.outputFormat,
      },
    };
  }

  if (request.outputFormat === "jpeg") {
    throw new AssetError("unsupported-capability", {
      context: { kind: "image", capability: "output-format" },
    });
  }
  return {
    ...SPRITE_ALPHA_TRIM_RECIPE,
    parameters: { alpha: "preserve", trim: "transparent-margin", outputFormat: request.outputFormat },
  };
}
