import type { Story } from "@ludelier/schema";

/**
 * Variables that are *read* (in a `choice` option `if`) but never *written* (`set`/`add`/`roll`)
 * anywhere in the story. There is no variable declaration in the DSL, so a read of an unwritten
 * var is almost always a typo: at runtime it compares against `undefined` and the branch is
 * silently always-false. Returned sorted.
 *
 * This is intentionally NOT a hard `validateStory` error — during incremental editing the `set`
 * may legitimately land after the `if`, so wedging the edit would break depth-first building.
 * Instead the agent self-correction gate surfaces it as a problem to resolve before finishing.
 */
export function unwrittenVarReads(story: Story): string[] {
  const written = new Set<string>();
  const read = new Set<string>();
  for (const node of story.nodes) {
    for (const stmt of node.body) {
      if (stmt.op === "set" || stmt.op === "add" || stmt.op === "roll") written.add(stmt.var);
      if (stmt.op === "choice") for (const opt of stmt.options) if (opt.if) read.add(opt.if.var);
    }
  }
  return [...read].filter((v) => !written.has(v)).sort();
}

const ORDERED = new Set(["gt", "lt", "gte", "lte"]);

/**
 * Conditions whose ordered comparison (gt/lt/gte/lte) can never behave as intended, because the
 * engine evaluates ordered ops on numbers only (a non-number operand makes the branch always
 * false — see `compare`). Two shapes are flagged, each a likely authoring/type bug:
 *  - the literal `value` is not a number (e.g. `gt "high"`); and
 *  - the variable is `set` to a non-number somewhere, so the comparison is type-confused.
 * Returned as sorted human-readable messages, deduped. Soft (gate-surfaced), not a hard error.
 */
export function conditionTypeIssues(story: Story): string[] {
  // What non-number types each var is ever assigned (add/roll are always numeric, so ignored).
  const nonNumberWrites = new Map<string, Set<string>>();
  for (const node of story.nodes) {
    for (const stmt of node.body) {
      if (stmt.op === "set" && typeof stmt.value !== "number") {
        const set = nonNumberWrites.get(stmt.var) ?? new Set<string>();
        set.add(typeof stmt.value);
        nonNumberWrites.set(stmt.var, set);
      }
    }
  }

  const issues = new Set<string>();
  for (const node of story.nodes) {
    for (const stmt of node.body) {
      if (stmt.op !== "choice") continue;
      for (const opt of stmt.options) {
        const cond = opt.if;
        if (!cond || !ORDERED.has(cond.cmp)) continue;
        if (typeof cond.value !== "number") {
          issues.add(
            `variable "${cond.var}" is compared with "${cond.cmp}" against a non-number (${typeof cond.value}) — ordered comparisons are number-only, so this branch is always false.`,
          );
        }
        const bad = nonNumberWrites.get(cond.var);
        if (bad && bad.size > 0) {
          issues.add(
            `variable "${cond.var}" is compared with "${cond.cmp}" but is set to a ${[...bad].sort().join("/")} elsewhere — ordered comparisons are number-only, so the comparison is type-confused.`,
          );
        }
      }
    }
  }
  return [...issues].sort();
}
