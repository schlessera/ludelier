import { StoryObject, type Story } from "@ludelier/schema";
import { fnv1a64 } from "@ludelier/engine";

/**
 * Stable, key-sorted JSON serialisation — two structurally-equal values serialise
 * to identical strings regardless of key-insertion order. Mirrors the engine's
 * `hash.ts` discipline (the source of replay determinism).
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stable(obj[k]))
      .join(",") +
    "}"
  );
}

/** Stable, key-sorted JSON of any value — for structural equality / diffing. */
export function stableStringify(value: unknown): string {
  return stable(value);
}

/**
 * Canonical Story form (KTD-6): first **materialise schema defaults** by running the
 * Story through `StoryObject.parse` (so an absent `characters`/`assets` becomes `[]`
 * and a `show` without `at` becomes `"center"`), then **stable-key-sort**. This makes a
 * refold-built Story and a Zod-loaded base serialise identically — key-sort alone would
 * not, because default materialisation varies by construction path.
 */
export function canonicalStory(story: Story): string {
  return stable(StoryObject.parse(story));
}

/**
 * Stable 64-bit hex hash of the canonical Story form (shares the engine's `fnv1a64`
 * so there is one hash implementation — no 32-vs-64-bit drift between the two). Used
 * as a content identity, so 64 bits matter (see `fnv1a64`).
 */
export function hashStory(story: Story): string {
  return fnv1a64(canonicalStory(story));
}
