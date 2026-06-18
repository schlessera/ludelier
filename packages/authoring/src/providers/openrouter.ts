import type { LLMProvider } from "../provider";
import { openAiCompatibleProvider } from "./openai-compatible";

export interface OpenRouterOptions {
  apiKey: string;
  /** An OpenRouter model slug, e.g. "openai/gpt-5-mini" or "anthropic/claude-…". */
  model: string;
  baseUrl?: string;
  /** Optional attribution headers OpenRouter surfaces in its dashboards. */
  appUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

/** OpenRouter provider — OpenAI-compatible API; one BYOK key fans out to many models. */
export function openRouterProvider(opts: OpenRouterOptions): LLMProvider {
  const headers: Record<string, string> = {};
  if (opts.appUrl) headers["HTTP-Referer"] = opts.appUrl;
  if (opts.appName) headers["X-Title"] = opts.appName;

  return openAiCompatibleProvider({
    id: "openrouter",
    baseUrl: opts.baseUrl ?? "https://openrouter.ai/api/v1",
    apiKey: opts.apiKey,
    model: opts.model,
    jsonSchema: true,
    headers,
    fetchImpl: opts.fetchImpl,
  });
}
