import type {
  CompletionRequest,
  CompletionResult,
  LLMCapabilities,
  LLMProvider,
} from "../provider";

/**
 * Shared implementation for any OpenAI-compatible `/chat/completions` endpoint.
 * OpenAI and OpenRouter differ only in base URL + headers, so both are thin
 * wrappers over this. `fetchImpl` is injectable so tests stay hermetic.
 */
export interface OpenAiCompatibleConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  /** Default model id when a request omits `model`. */
  model: string;
  jsonSchema?: boolean;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export function openAiCompatibleProvider(cfg: OpenAiCompatibleConfig): LLMProvider {
  const capabilities: LLMCapabilities = { jsonSchema: cfg.jsonSchema ?? true };
  const doFetch = cfg.fetchImpl ?? fetch;

  return {
    id: cfg.id,
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = req.model ?? cfg.model;
      const body: Record<string, unknown> = {
        model,
        messages: req.messages,
        temperature: req.temperature ?? 0.7,
      };
      if (req.maxTokens != null) body.max_tokens = req.maxTokens;
      if (req.jsonSchema && capabilities.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false },
        };
      }

      const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.headers ?? {}),
        },
        body: JSON.stringify(body),
      });

      const json = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!res.ok) {
        throw new Error(
          `${cfg.id} completion failed (${res.status}): ${json.error?.message ?? "unknown error"}`,
        );
      }
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        model: json.model ?? model,
        usage: json.usage
          ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
          : undefined,
        raw: json,
      };
    },
  };
}
