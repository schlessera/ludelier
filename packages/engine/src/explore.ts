import type { Story } from "@ludelier/schema";
import type { Action, GameState } from "./state";
import { initialState, reducer } from "./reducer";
import { stableStringify } from "./hash";

export interface ExploreReport {
  /** Node ids entered while *executing* the story, including nodes passed through by nonblocking
   *  resolution (sorted). Respects `if` conditions at runtime, so it can be a strict subset of
   *  the static graph's reachable set — a node reachable only through a choice option whose `if`
   *  is never satisfiable will not appear here. */
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

/** Canonical state identity for traversal; transient output history is intentionally excluded. */
function stateKey(state: GameState): string {
  return stableStringify({
    cursor: state.cursor,
    vars: state.vars,
    rng: state.rng,
    stage: state.stage,
    audio: {
      music: state.audio.music && { asset: state.audio.music.asset, loop: state.audio.music.loop },
      voice: state.audio.voice && { asset: state.audio.voice.asset, loop: state.audio.voice.loop },
    },
    pending: state.pending,
    done: state.done,
  });
}

/** A non-observable statement that pauses resolver execution at every node entry. */
const entryMarker = { op: "say" as const, who: "", text: "" };

function withEntryMarkers(story: Story): Story {
  return {
    ...story,
    nodes: story.nodes.map((node) => ({ ...node, body: [entryMarker, ...node.body] })),
  };
}

/**
 * Advance only synthetic entry markers, exposing the nodes the normal reducer resolves through
 * without duplicating its control-flow or condition semantics.
 */
function consumeEntryMarkers(story: Story, state: GameState): { state: GameState; entered: string[] } {
  const entered: string[] = [];
  let current = state;
  while (!current.done && current.pending.kind === "say" && current.cursor.index === 0) {
    entered.push(current.cursor.node);
    current = reducer(story, current, { type: "ADVANCE" });
  }
  return { state: current, entered };
}

interface ExplorationState {
  state: GameState;
  markerState: GameState;
  entered: string[];
}

/**
 * Deterministic, bounded breadth-first exploration of every reachable game state — the
 * behavioural counterpart to the static `graph` analysis. Where `graph` walks edges ignoring
 * conditions, this *runs* the reducer, so it honours `if` gating and reports real coverage,
 * whether an ending is actually reachable, and choices that gate themselves off entirely.
 *
 * Termination is guaranteed: states are deduplicated by their canonical snapshot, and a
 * `maxStates` cap (default 5000) bounds every unique state as it is scheduled, so arbitrary
 * choice fan-out cannot grow the queue beyond the cap. Pure; same story + seed ⇒ identical report.
 */
export function exploreStory(story: Story, opts: { seed?: number; maxStates?: number } = {}): ExploreReport {
  const maxStates = opts.maxStates ?? 5000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 0) {
    throw new RangeError("maxStates must be a non-negative safe integer");
  }
  const visited = new Set<string>();
  const reached = new Set<string>();
  const stuck = new Set<string>();
  let endReachable = false;
  let truncated = false;
  let crashed = false;

  const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const markerStory = withEntryMarkers(story);
  let start: GameState;
  let markerStart: GameState;
  try {
    start = initialState(story, opts.seed);
    markerStart = initialState(markerStory, opts.seed);
  } catch {
    // The opening run-up itself looped (a jump cycle before any blocking statement).
    return { reached: [], endReachable: false, stuck: [], truncated: false, crashed: true };
  }
  if (maxStates <= 0) {
    return { reached: [], endReachable: false, stuck: [], truncated: true, crashed: false };
  }
  const initialEntries = consumeEntryMarkers(markerStory, markerStart);
  const scheduled = new Set<string>([stateKey(start)]);
  const queue: ExplorationState[] = [
    { state: start, markerState: initialEntries.state, entered: initialEntries.entered },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const { state } = current;
    const key = stateKey(state);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const node of current.entered) reached.add(node);
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
        const next = reducer(story, state, action);
        const nextKey = stateKey(next);
        const alreadyScheduled = scheduled.has(nextKey);
        if (!alreadyScheduled && scheduled.size >= maxStates) {
          truncated = true;
          continue;
        }
        const markerNext = consumeEntryMarkers(
          markerStory,
          reducer(markerStory, current.markerState, action),
        );
        for (const node of markerNext.entered) reached.add(node);
        if (alreadyScheduled) continue;
        scheduled.add(nextKey);
        queue.push({ state: next, markerState: markerNext.state, entered: markerNext.entered });
      } catch {
        // This transition looped past the statement budget — record it and stop down this path.
        crashed = true;
      }
    }
  }

  return { reached: sorted(reached), endReachable, stuck: sorted(stuck), truncated, crashed };
}
