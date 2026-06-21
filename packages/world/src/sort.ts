/** Stable string comparator — the basis for the golden-rule "sort before iterate". */
export function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparator for id-bearing records; sort before any order-sensitive iteration. */
export function byId<T extends { id: string }>(a: T, b: T): number {
  return compareStr(a.id, b.id);
}
