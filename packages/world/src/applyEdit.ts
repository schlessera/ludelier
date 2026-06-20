import { validateStory, type Story } from "@ludelier/schema";
import type { Registry } from "./registry";
import { fail, parseParams, type Result } from "./result";
import { sayWhoIssues } from "./manipulate/say-who-check";

/**
 * The world's stricter validation gate (KTD-3): `validateStory` (Zod shape + the
 * cross-refs it checks) PLUS the world-local `say.who` check. Used both by `applyEdit`
 * and by `EditLog` import/base-load so the always-valid invariant covers the base and
 * imported logs, not only incremental edits.
 */
export function validateWorld(story: unknown): Result<Story> {
  const res = validateStory(story);
  if (!res.success) return res;
  const extra = sayWhoIssues(res.data);
  if (extra.length > 0) return fail(extra);
  return res;
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
