import type { LLMProvider } from "../provider";
import { openAiCompatibleProvider } from "./openai-compatible";

export interface OpenAiOptions {
  apiKey: string;
  /** e.g. a current OpenAI chat model id — pass explicitly to avoid stale defaults. */
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** OpenAI provider (direct). Supports structured outputs + transparent-capable image gen elsewhere. */
export function openAiProvider(opts: OpenAiOptions): LLMProvider {
  return openAiCompatibleProvider({
    id: "openai",
    baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
    apiKey: opts.apiKey,
    model: opts.model,
    jsonSchema: true,
    fetchImpl: opts.fetchImpl,
  });
}
