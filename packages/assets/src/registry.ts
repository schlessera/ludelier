import { AssetError } from "./error";
import { resolveAssetTarget } from "./resolve";
import type {
  AssetGenerationOptions,
  AssetGenerationRequest,
  AssetGenerationResult,
  AssetProvider,
  ResolvedAssetGenerationRequest,
} from "./types";
import { openAiAssetProvider } from "./providers/openai";
import { openRouterAssetProvider } from "./providers/openrouter";
import type { OpenAiAssetProviderOptions } from "./providers/openai";
import type { OpenRouterAssetProviderOptions } from "./providers/openrouter";

/** Explicit BYOK provider construction; this portable module never reads environment variables. */
export type AssetProviderConfiguration =
  | { readonly type: "openai"; readonly options: OpenAiAssetProviderOptions }
  | { readonly type: "openrouter"; readonly options: OpenRouterAssetProviderOptions };

/**
 * Configuration order is resolver preference order. OpenRouter discovery is awaited in that same
 * order so the resulting target list is deterministic for a given injected discovery response.
 */
export async function createAssetProviders(
  configurations: readonly AssetProviderConfiguration[],
): Promise<readonly AssetProvider[]> {
  const providers: AssetProvider[] = [];
  for (const configuration of configurations) {
    const provider =
      configuration.type === "openai"
        ? openAiAssetProvider(configuration.options)
        : await openRouterAssetProvider(configuration.options);
    if (providers.some((candidate) => candidate.id === provider.id)) throw new AssetError("invalid-request");
    providers.push(provider);
  }
  return providers;
}

export interface AssetProviderRegistry {
  /** An immutable snapshot whose order determines automatic resolution preference. */
  readonly providers: readonly AssetProvider[];
  resolve(request: AssetGenerationRequest): ResolvedAssetGenerationRequest;
  generate(request: AssetGenerationRequest, options?: AssetGenerationOptions): Promise<AssetGenerationResult>;
}

/** Creates a deterministic resolution/execution facade over already configured providers. */
export function createAssetProviderRegistry(providers: readonly AssetProvider[]): AssetProviderRegistry {
  const ordered = [...providers];
  if (new Set(ordered.map((provider) => provider.id)).size !== ordered.length)
    throw new AssetError("invalid-request");

  return {
    providers: ordered,
    resolve(request) {
      return resolveAssetTarget(ordered, request);
    },
    async generate(request, options) {
      const resolved = resolveAssetTarget(ordered, request);
      const provider = ordered.find((candidate) => candidate.id === resolved.target.providerId);
      if (provider === undefined)
        throw new AssetError("unknown-provider", { context: { kind: request.kind } });
      return provider.generate(resolved, options);
    },
  };
}

/** Convenience factory for hosts that want a registry directly from explicit provider config. */
export async function createConfiguredAssetProviderRegistry(
  configurations: readonly AssetProviderConfiguration[],
): Promise<AssetProviderRegistry> {
  return createAssetProviderRegistry(await createAssetProviders(configurations));
}
