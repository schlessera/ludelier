import { z } from "zod";
import { validateStory } from "@ludelier/schema";
import type { Task } from "../registry";

/**
 * Validate the story (Zod shape + cross-references). `validateStory` already returns
 * the `{success}` envelope, so this is a direct passthrough (KTD-5) — on failure the
 * result is `{success:false, issues}`; on success `{success:true, data: Story}`.
 */
export const validateTask: Task = {
  name: "validate",
  kind: "understand",
  description: "Validate the story: Zod shape plus cross-reference checks.",
  params: z.object({}),
  run: (story) => validateStory(story),
};
