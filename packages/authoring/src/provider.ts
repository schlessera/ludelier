/**
 * The LLM provider seam. Mirrors the asset `AssetProvider` shape: a small,
 * capability-bearing interface with interchangeable implementations (OpenAI,
 * OpenRouter, …) selected by a registry. Authoring logic depends on this
 * interface only — never on a concrete vendor.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A JSON Schema used to constrain structured output (when the provider supports it). */
export interface JsonSchemaSpec {
  name: string;
  schema: unknown;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Overrides the provider's default model for this call. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** When set and `capabilities.jsonSchema` is true, constrain output to this schema. */
  jsonSchema?: JsonSchemaSpec;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** The raw provider response, for debugging/provenance. */
  raw?: unknown;
}

export interface LLMCapabilities {
  /** Structured outputs via `response_format: { type: "json_schema" }`. */
  jsonSchema: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: LLMCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
