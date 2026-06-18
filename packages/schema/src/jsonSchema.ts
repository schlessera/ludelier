import { z } from "zod";
import { StoryObject } from "./story";

/**
 * Export the Story schema as JSON Schema, to constrain LLM output at generation
 * time (structured outputs / tool schemas). Requires Zod v4's `z.toJSONSchema`.
 */
export function storyJsonSchema(): unknown {
  const zAny = z as unknown as { toJSONSchema?: (s: unknown) => unknown };
  if (typeof zAny.toJSONSchema !== "function") {
    throw new Error(
      "z.toJSONSchema is unavailable — Zod v4+ is required for JSON Schema export",
    );
  }
  return zAny.toJSONSchema(StoryObject);
}
