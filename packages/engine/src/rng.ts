/**
 * Deterministic seeded PRNG (mulberry32), expressed as a pure step so RNG state
 * can live inside game state and be serialised/hashed/replayed. NEVER use
 * Math.random in game logic — thread state through these functions instead.
 */

/** Returns [value in [0,1), nextState]. */
export function nextRandom(state: number): [number, number] {
  let a = state | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, a];
}

/** Returns [integer in [min,max] inclusive, nextState]. */
export function rollInt(state: number, min: number, max: number): [number, number] {
  const [value, next] = nextRandom(state);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const roll = lo + Math.floor(value * (hi - lo + 1));
  return [roll, next];
}
