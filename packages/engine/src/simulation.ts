import type { Story } from "@ludelier/schema";
import type { Action, GameState } from "./state";
import { initialState, reducer } from "./reducer";
import { hashState } from "./hash";

/** Versioned JSONL header emitted before action trace lines. */
export interface TraceHeader {
  version: 2;
  initialHash: string;
}

export interface TraceLine {
  action: Action;
  hash: string;
}

const hashPattern = /^[0-9a-f]{16}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== expected.length) return false;
  return actual.every((key) => expected.includes(key));
}

function isValidHash(value: unknown): value is string {
  return typeof value === "string" && hashPattern.test(value);
}

function isTraceHeader(value: unknown): value is TraceHeader {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["version", "initialHash"]) &&
    value.version === 2 &&
    isValidHash(value.initialHash)
  );
}

function isTraceAction(value: unknown): value is Action {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ADVANCE") return hasOnlyKeys(value, ["type"]);
  return (
    value.type === "CHOOSE" &&
    hasOnlyKeys(value, ["type", "index"]) &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0
  );
}

function isTraceLine(value: unknown): value is TraceLine {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["action", "hash"]) &&
    isTraceAction(value.action) &&
    isValidHash(value.hash)
  );
}

function parseTraceJson(text: string, line: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid trace at line ${line}: invalid JSON`);
  }
}

interface TraceRecord {
  line: number;
  text: string;
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
    audio: s.audio,
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

  /** Emit a versioned JSONL trace, including the fully resolved state before any action. */
  record(actions: Action[]): string {
    const header: TraceHeader = { version: 2, initialHash: this.hash() };
    const lines: string[] = [JSON.stringify(header)];
    for (const action of actions) {
      this.dispatch(action);
      const line: TraceLine = { action, hash: this.hash() };
      lines.push(JSON.stringify(line));
    }
    return lines.join("\n");
  }
}

/**
 * Replay a versioned JSONL trace against a fresh simulation, asserting its fully resolved
 * initial-state hash and then the state hash at every action. This is how a recorded session
 * becomes a regression test.
 */
export function replayTrace(
  story: Story,
  jsonl: string,
  opts: { seed?: number; start?: string } = {},
): { ok: true; steps: number } {
  const records: TraceRecord[] = [];
  for (const [index, line] of jsonl.split("\n").entries()) {
    const text = line.trim();
    if (text) records.push({ line: index + 1, text });
  }
  const [headerRecord, ...actionRecords] = records;
  if (!headerRecord) throw new Error("invalid trace: missing version 2 header");

  const header = parseTraceJson(headerRecord.text, headerRecord.line);
  if (!isTraceHeader(header)) {
    throw new Error(`invalid trace at line ${headerRecord.line}: expected version 2 header`);
  }

  const sim = new Simulation(story, opts);
  const initialHash = sim.hash();
  if (initialHash !== header.initialHash) {
    throw new Error(`replay mismatch at initial state: expected ${header.initialHash}, got ${initialHash}`);
  }

  let steps = 0;
  for (const record of actionRecords) {
    const traceLine = parseTraceJson(record.text, record.line);
    if (!isTraceLine(traceLine)) {
      throw new Error(`invalid trace at line ${record.line}: expected action record`);
    }
    sim.dispatch(traceLine.action);
    steps++;
    const got = sim.hash();
    if (got !== traceLine.hash) {
      throw new Error(`replay mismatch at step ${steps}: expected ${traceLine.hash}, got ${got}`);
    }
  }
  return { ok: true, steps };
}
