import type { VarValue, SpritePosition, SoundChannel } from "@ludelier/schema";

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

/** A persistent music or voice request, established by the play event with `startedAtSeq`. */
export interface DesiredAudio {
  asset: string;
  loop: boolean;
  startedAtSeq: number;
}

/** A one-shot instruction for a presentation adapter. `seq` orders every emitted instruction. */
export type AudioEvent =
  | { type: "play"; seq: number; channel: SoundChannel; asset: string; loop: boolean }
  | { type: "stop"; seq: number; channel: SoundChannel };

/**
 * Logical audio output. Music and voice describe desired persistent playback; SFX is intentionally
 * event-only so repeated cues remain independently observable.
 */
export interface AudioState {
  music: DesiredAudio | null;
  voice: DesiredAudio | null;
  events: AudioEvent[];
  nextEventSeq: number;
}

/** Empty audio output for a new simulation. */
export const initialAudioState: AudioState = {
  music: null,
  voice: null,
  events: [],
  nextEventSeq: 0,
};

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
  /** Persistent desired playback plus transient audio instructions. */
  audio: AudioState;
  pending: Pending;
  done: boolean;
  /** Ordered log of every line shown — deterministic, useful for transcript assertions. */
  transcript: { who: string; text: string }[];
}

export type Action = { type: "ADVANCE" } | { type: "CHOOSE"; index: number };
