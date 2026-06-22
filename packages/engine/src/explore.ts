import type { Story } from "@ludelier/schema";
import type { Action, GameState } from "./state";
import { initialState, reducer } from "./reducer";
import { stableStringify } from "./hash";

export interface ExploreReport {
  /** Node ids actually visited by *executing* the story (sorted). Respects `if` conditions at
   *  runtime, so it can be a strict subset of the static graph's reachable set — a node reachable
   *  only through a choice option whose `if` is never satisfiable will not appear here. */
  reached: string[];
  /** Whether at least one explored path terminates in an `end` (kind === "end", not a run-off). */
  endReachable: boolean;
  /** Nodes where exploration stalled: a `choice` with no enabled option (a runtime dead end the
   *  static graph cannot see, because every way out is gated off). Sorted. */
  stuck: string[];
  /** True if the state cap was hit before the reachable state space was exhausted — `reached` /
   *  `endReachable` are then lower bounds, not complete. */
  truncated: boolean;
  /** True if executing the story threw (the engine's statement-budget guard tripped — almost
   *  always an infinite jump loop). Caught here so analysis reports the defect instead of the
   *  whole verify pass crashing. */
  crashed: boolean;
}

/** The actions available from a blocking state, in deterministic order. */
function actionsFor(state: GameState): Action[] {
  if (state.pending.kind === "say") return [{ type: "ADVANCE" }];
  if (state.pending.kind === "choice") {
    const out: Action[] = [];
    state.pending.options.forEach((o, i) => {
      if (o.enabled) out.push({ type: "CHOOSE", index: i });
    });
    return out;
  }
  return [];
}

/**
 * Deterministic, bounded breadth-first exploration of every reachable game state — the
 * behavioural counterpart to the static `graph` analysis. Where `graph` walks edges ignoring
 * conditions, this *runs* the reducer, so it honours `if` gating and reports real coverage,
 * whether an ending is actually reachable, and choices that gate themselves off entirely.
 *
 * Termination is guaranteed: states are deduplicated by their canonical snapshot, and a
 * `maxStates` cap (default 5000) bounds pathological fan-out (e.g. a counter incremented in a
 * loop) — hitting it sets `truncated`. Pure; same story + seed ⇒ identical report.
 */
export function exploreStory(story: Story, opts: { seed?: number; maxStates?: number } = {}): ExploreReport {
  const maxStates = opts.maxStates ?? 5000;
  const visited = new Set<string>();
  const reached = new Set<string>();
  const stuck = new Set<string>();
  let endReachable = false;
  let truncated = false;
  let crashed = false;

  const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let start: GameState;
  try {
    start = initialState(story, opts.seed);
  } catch {
    // The opening run-up itself looped (a jump cycle before any blocking statement).
    return { reached: [], endReachable: false, stuck: [], truncated: false, crashed: true };
  }
  const queue: GameState[] = [start];

  while (queue.length > 0) {
    const state = queue.shift()!;
    const key = stableStringify({
      cursor: state.cursor,
      vars: state.vars,
      rng: state.rng,
      stage: state.stage,
      pending: state.pending,
      done: state.done,
    });
    if (visited.has(key)) continue;
    if (visited.size >= maxStates) {
      truncated = true;
      break;
    }
    visited.add(key);
    reached.add(state.cursor.node);

    if (state.done) {
      if (state.pending.kind === "end") endReachable = true;
      continue;
    }
    const actions = actionsFor(state);
    if (actions.length === 0) {
      // A blocking state with no way forward (a fully gated-off choice) — a runtime dead end.
      stuck.add(state.cursor.node);
      continue;
    }
    for (const action of actions) {
      try {
        queue.push(reducer(story, state, action));
      } catch {
        // This transition looped past the statement budget — record it and stop down this path.
        crashed = true;
      }
    }
  }

  return { reached: sorted(reached), endReachable, stuck: sorted(stuck), truncated, crashed };
}
