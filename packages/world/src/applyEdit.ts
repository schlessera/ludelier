import { validateStory, type Story } from "@ludelier/schema";
import type { Registry } from "./registry";
import { fail, parseParams, type Result } from "./result";

/**
 * The world's validation gate. `say.who` (KTD-3) and statement-id uniqueness now live in
 * `validateStory` itself, so there is a single definition of "valid" shared by authoring
 * and the world — this is a thin alias kept for the call sites that gate edits, imports, and
 * base-loads. Returns the schema `Result` so the envelope passes through untouched.
 */
export function validateWorld(story: unknown): Result<Story> {
  return validateStory(story);
}

/**
 * The always-valid chokepoint: look up the manipulate command, validate its params,
 * run its pure transform, then re-validate the whole resulting Story. On any failure
 * the original story is returned untouched (the caller never sees a half-applied edit).
 */
export function applyEdit(world: Registry, story: Story, name: string, rawParams: unknown): Result<Story> {
  const task = world.get(name);
  if (!task || task.kind !== "manipulate" || !task.apply) {
    return fail([{ path: "command", message: `unknown manipulate command "${name}"` }]);
  }
  const parsed = parseParams(task.params, rawParams);
  if (!parsed.success) return parsed;
  const applied = task.apply(story, parsed.data);
  if (!applied.success) return applied;
  return validateWorld(applied.data);
}
