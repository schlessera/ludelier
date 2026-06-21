import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  LLMCapabilities,
  LLMProvider,
  ToolCall,
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
  tools?: boolean;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface ApiToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: ApiToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** JSON-parse tool-call arguments, falling back to the raw string (never throws). */
function parseArguments(raw: string | undefined): unknown {
  if (raw == null) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Map a `ChatMessage` to the OpenAI wire shape, including tool roles + assistant echoes. */
function toApiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
        },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

export function openAiCompatibleProvider(cfg: OpenAiCompatibleConfig): LLMProvider {
  const capabilities: LLMCapabilities = { jsonSchema: cfg.jsonSchema ?? true, tools: cfg.tools ?? true };
  const doFetch = cfg.fetchImpl ?? fetch;

  return {
    id: cfg.id,
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = req.model ?? cfg.model;
      const body: Record<string, unknown> = {
        model,
        messages: req.messages.map(toApiMessage),
        temperature: req.temperature ?? 0.7,
      };
      if (req.maxTokens != null) body.max_tokens = req.maxTokens;
      if (req.jsonSchema && capabilities.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: false },
        };
      }
      if (req.tools && req.tools.length > 0 && capabilities.tools) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });

      const json = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!res.ok) {
        throw new Error(
          `${cfg.id} completion failed (${res.status}): ${json.error?.message ?? "unknown error"}`,
        );
      }
      const message = json.choices?.[0]?.message;
      const toolCalls: ToolCall[] | undefined = message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function?.name ?? "",
        arguments: parseArguments(tc.function?.arguments),
      }));
      return {
        text: message?.content ?? "",
        model: json.model ?? model,
        usage: json.usage
          ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
          : undefined,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        raw: json,
      };
    },
  };
}
