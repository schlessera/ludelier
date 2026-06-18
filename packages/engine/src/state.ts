import type { VarValue, SpritePosition } from "@ludelier/schema";

export interface Cursor {
  node: string;
  index: number;
}

/** A sprite currently on the stage. `id` is the slot/tag; `asset` is the image shown. */
export interface StageSprite {
  id: string;
  asset: string;
  at: SpritePosition;
}

/**
 * The persistent visual state the renderer draws: a background plus zero or more
 * sprites. Lives in GameState (not `pending`) so it survives across say/choice
 * statements. `sprites` is kept sorted by `id` so the state hashes deterministically.
 */
export interface Stage {
  bg: string | null;
  sprites: StageSprite[];
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
  /** Persistent visual stage (background + sprites), mutated by scene/show/hide. */
  stage: Stage;
  pending: Pending;
  done: boolean;
  /** Ordered log of every line shown — deterministic, useful for transcript assertions. */
  transcript: { who: string; text: string }[];
}

export type Action = { type: "ADVANCE" } | { type: "CHOOSE"; index: number };
