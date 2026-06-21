import { z } from "zod";
import { StoryObject } from "./story";

/**
 * Convert any Zod schema to JSON Schema behind a runtime guard. The single home for
 * the `z.toJSONSchema` call — world `describe()`, CLI `--json` validation, and future
 * UI forms all route through here so the guard is not copied (and cannot drift).
 * Requires Zod v4's `z.toJSONSchema`.
 */
export function toJsonSchema(schema: unknown): unknown {
  const zAny = z as unknown as { toJSONSchema?: (s: unknown) => unknown };
  if (typeof zAny.toJSONSchema !== "function") {
    throw new Error(
      "z.toJSONSchema is unavailable — Zod v4+ is required for JSON Schema export",
    );
  }
  return zAny.toJSONSchema(schema);
}

/**
 * Export the Story schema as JSON Schema, to constrain LLM output at generation
 * time (structured outputs / tool schemas).
 */
export function storyJsonSchema(): unknown {
  return toJsonSchema(StoryObject);
}
