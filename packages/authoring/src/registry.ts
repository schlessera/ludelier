import type { LLMProvider } from "./provider";
import { openAiProvider } from "./providers/openai";
import { openRouterProvider } from "./providers/openrouter";

/** BYOK config — one key + default model per provider. Extend as providers are added. */
export interface ProvidersConfig {
  openai?: { apiKey: string; model: string; baseUrl?: string };
  openrouter?: { apiKey: string; model: string; baseUrl?: string; appUrl?: string; appName?: string };
}

/** Build the configured providers, keyed by id. */
export function createProviders(cfg: ProvidersConfig): Record<string, LLMProvider> {
  const providers: Record<string, LLMProvider> = {};
  if (cfg.openai) providers.openai = openAiProvider(cfg.openai);
  if (cfg.openrouter) providers.openrouter = openRouterProvider(cfg.openrouter);
  return providers;
}

/**
 * Convenience: build providers from environment variables (BYOK per provider).
 * `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`) and `OPENROUTER_API_KEY`
 * (+ optional `OPENROUTER_MODEL`). Model envs should be set to a current slug.
 */
export function providersFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, LLMProvider> {
  const cfg: ProvidersConfig = {};
  if (env.OPENAI_API_KEY) {
    cfg.openai = { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? "gpt-5-mini" };
  }
  if (env.OPENROUTER_API_KEY) {
    cfg.openrouter = { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL ?? "openai/gpt-5-mini" };
  }
  return createProviders(cfg);
}
