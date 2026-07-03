import type { ZodError, ZodType } from "zod";
import type { Issue } from "@ludelier/schema";

/**
 * The uniform result envelope every world task returns. Aligned on
 * `@ludelier/schema`'s `{ success }` discriminant (KTD-5) so `validateStory`'s
 * output passes through untouched and the CLI/engine majority shape is reused.
 * (`@ludelier/authoring`'s `AuthorResult` uses `ok`; that is a separate, pre-existing
 * shape — the `success → ok` mapping happens once, at the `runAgent` boundary.)
 */
export type Result<T> = { success: true; data: T } | { success: false; issues: Issue[] };

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function fail<T = never>(issues: Issue[]): Result<T> {
  return { success: false, issues };
}

/** Map a Zod error into the schema `Issue` shape (path + message). */
export function issuesFromZod(err: ZodError): Issue[] {
  return err.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}

/** Validate raw params against a task's Zod schema, surfacing failures as issues (never throws). */
export function parseParams(params: ZodType, raw: unknown): Result<unknown> {
  const res = params.safeParse(raw);
  if (!res.success) return fail(issuesFromZod(res.error));
  return ok(res.data);
}
