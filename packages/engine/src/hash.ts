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

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x00000100000001b3n;
const U64 = (1n << 64n) - 1n;

/**
 * FNV-1a 64-bit, hex-encoded (16 chars). Computed with BigInt for exact 64-bit
 * wraparound, so it is stable across runs and platforms. 64 bits (vs the former
 * 32) pushes birthday collisions from ~77k to ~5B items — needed wherever a hash
 * is used as an *identity* / cache key (canonical story hash, P3 asset cache),
 * not merely a cheap equality probe.
 */
export function fnv1a64(s: string): string {
  let h = FNV64_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV64_PRIME) & U64;
  }
  return h.toString(16).padStart(16, "0");
}

/** Stable 64-bit hash of a value's canonical (sorted-key) serialisation. */
export function hashState(value: unknown): string {
  return fnv1a64(stable(value));
}
