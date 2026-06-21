import { StoryObject, type Story } from "@ludelier/schema";

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

/** FNV-1a 32-bit hex hash of the canonical Story form. Stable across runs and platforms. */
export function hashStory(story: Story): string {
  const s = canonicalStory(story);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
