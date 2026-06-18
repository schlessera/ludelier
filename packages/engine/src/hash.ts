/**
 * Stable serialisation + hashing. Object keys are sorted so two logically equal
 * states always hash identically — the foundation of replay/regression testing.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(obj[k])).join(",") + "}";
}

export function stableStringify(value: unknown): string {
  return stable(value);
}

/** FNV-1a 32-bit, hex-encoded. Stable across runs and platforms. */
export function hashState(value: unknown): string {
  const s = stable(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
