import type { Story } from "@ludelier/schema";
import type { Action, GameState } from "./state";
import { initialState, reducer } from "./reducer";
import { hashState } from "./hash";

export interface TraceLine {
  action: Action;
  hash: string;
}

/** The logical (deterministic) slice of state that gets hashed. Everything is included —
 *  the transcript too, so a text-only edit (a changed `say`) shows up in replay hashes.
 *  (`exploreStory` keeps its own transcript-free dedup key; this does not affect it.) */
function snapshot(s: GameState) {
  return {
    cursor: s.cursor,
    vars: s.vars,
    rng: s.rng,
    stage: s.stage,
    pending: s.pending,
    done: s.done,
    transcript: s.transcript,
  };
}

/**
 * Headless game runner — the AI agent's primary test surface. No DOM, no renderer.
 * Generate actions, run them, assert on hash/state/transcript.
 */
export class Simulation {
  readonly story: Story;
  state: GameState;

  constructor(story: Story, opts: { seed?: number; start?: string } = {}) {
    this.story = story;
    this.state = initialState(story, opts.seed, opts.start);
  }

  dispatch(action: Action): GameState {
    this.state = reducer(this.story, this.state, action);
    return this.state;
  }

  run(actions: Action[]): GameState {
    for (const action of actions) this.dispatch(action);
    return this.state;
  }

  hash(): string {
    return hashState(snapshot(this.state));
  }

  transcript(): { who: string; text: string }[] {
    return this.state.transcript;
  }

  /** Dispatch actions, capturing the state hash after each — emits a JSONL trace. */
  record(actions: Action[]): string {
    const lines: string[] = [];
    for (const action of actions) {
      this.dispatch(action);
      const line: TraceLine = { action, hash: this.hash() };
      lines.push(JSON.stringify(line));
    }
    return lines.join("\n");
  }
}

/**
 * Replay a JSONL trace against a fresh simulation, asserting the state hash matches
 * at every step. This is how a recorded session becomes a regression test.
 */
export function replayTrace(
  story: Story,
  jsonl: string,
  opts: { seed?: number } = {},
): { ok: true; steps: number } {
  const sim = new Simulation(story, opts);
  const lines = jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let steps = 0;
  for (const line of lines) {
    const { action, hash } = JSON.parse(line) as TraceLine;
    sim.dispatch(action);
    steps++;
    const got = sim.hash();
    if (got !== hash) {
      throw new Error(`replay mismatch at step ${steps}: expected ${hash}, got ${got}`);
    }
  }
  return { ok: true, steps };
}
