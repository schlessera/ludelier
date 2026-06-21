/**
 * The LLM provider seam. Mirrors the asset `AssetProvider` shape: a small,
 * capability-bearing interface with interchangeable implementations (OpenAI,
 * OpenRouter, …) selected by a registry. Authoring logic depends on this
 * interface only — never on a concrete vendor.
 */

/** A single tool/function call the model decided to make. `arguments` is JSON-parsed. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** On an assistant turn: the tool calls it issued (echoed back so the provider has context). */
  toolCalls?: ToolCall[];
  /** On a `role:"tool"` message: the id of the tool call this result answers. */
  toolCallId?: string;
}

/** A JSON Schema used to constrain structured output (when the provider supports it). */
export interface JsonSchemaSpec {
  name: string;
  schema: unknown;
}

/** A tool the model may call (OpenAI-style function tool). `parameters` is JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Overrides the provider's default model for this call. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** When set and `capabilities.jsonSchema` is true, constrain output to this schema. */
  jsonSchema?: JsonSchemaSpec;
  /** When set and `capabilities.tools` is true, offer these tools to the model. */
  tools?: ToolDefinition[];
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Tool calls the model requested, if any (parsed from the provider response). */
  toolCalls?: ToolCall[];
  /** The raw provider response, for debugging/provenance. */
  raw?: unknown;
}

export interface LLMCapabilities {
  /** Structured outputs via `response_format: { type: "json_schema" }`. */
  jsonSchema: boolean;
  /** Function/tool calling via `tools` + `tool_calls`. Optional for back-compat. */
  tools?: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: LLMCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
