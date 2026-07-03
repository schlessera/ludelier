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
  /** Retries on transient failures (429/5xx/network), on top of the first attempt. Default 3. */
  maxRetries?: number;
  /** Base backoff delay in ms (doubles per retry; a `Retry-After` header wins). Default 500.
   *  Tests set 0 to keep the suite fast. */
  retryBaseMs?: number;
}

/** Statuses worth retrying: rate limits and transient server-side failures. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Abort-aware sleep — resolves early (without throwing) if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Delay before the next attempt: `Retry-After` (seconds) when present, else exponential backoff. */
function retryDelayMs(res: Response | null, attempt: number, baseMs: number): number {
  const header = res?.headers?.get?.("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  }
  return baseMs * 2 ** attempt;
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
  const maxRetries = cfg.maxRetries ?? 3;
  const retryBaseMs = cfg.retryBaseMs ?? 500;

  return {
    id: cfg.id,
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const model = req.model ?? cfg.model;
      const body: Record<string, unknown> = {
        model,
        messages: req.messages.map(toApiMessage),
      };
      // Only send temperature when the caller sets one — otherwise let the model default apply.
      if (req.temperature != null) body.temperature = req.temperature;
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

      // A transient failure (rate limit, 5xx, dropped connection) must not kill a whole
      // multi-turn agent run — retry with backoff, honouring Retry-After. Aborts never retry.
      let res: Response | null = null;
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          await sleep(retryDelayMs(res, attempt - 1, retryBaseMs), req.signal);
        }
        if (req.signal?.aborted) {
          throw lastError ?? new DOMException("The operation was aborted.", "AbortError");
        }
        try {
          res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.apiKey}`,
              ...(cfg.headers ?? {}),
            },
            body: JSON.stringify(body),
            signal: req.signal,
          });
        } catch (err) {
          if (req.signal?.aborted) throw err; // an abort is the caller's intent, not a failure
          lastError = err as Error; // network-level failure — retryable
          res = null;
          continue;
        }
        if (res.ok || !RETRYABLE_STATUS.has(res.status)) break;
      }
      if (res === null) {
        throw new Error(
          `${cfg.id} completion failed after ${maxRetries + 1} attempts: ${lastError?.message ?? "network error"}`,
        );
      }

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
