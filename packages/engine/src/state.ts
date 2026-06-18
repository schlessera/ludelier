import type { VarValue } from "@ludelier/schema";

export interface Cursor {
  node: string;
  index: number;
}

export type Pending =
  | { kind: "say"; who: string; text: string }
  | {
      kind: "choice";
      prompt?: string;
      options: { label: string; goto: string; enabled: boolean }[];
    }
  | { kind: "end" };

export interface GameState {
  cursor: Cursor;
  vars: Record<string, VarValue>;
  /** mulberry32 state — part of game state so RNG is deterministic & replayable. */
  rng: number;
  pending: Pending;
  done: boolean;
  /** Ordered log of every line shown — deterministic, useful for transcript assertions. */
  transcript: { who: string; text: string }[];
}

export type Action = { type: "ADVANCE" } | { type: "CHOOSE"; index: number };
