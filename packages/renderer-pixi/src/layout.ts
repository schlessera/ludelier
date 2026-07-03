import type { StageSprite } from "@ludelier/engine";

/**
 * Pure display math for the renderer — no PixiJS, no DOM — so the numbers that
 * decide what a frame looks like are unit-testable without a GL context.
 * `renderer.ts` consumes these; changing a formula here changes the picture.
 */

/** Logical stage size. All layout math and the renderer's coordinate space use this. */
export const STAGE_W = 1280;
export const STAGE_H = 720;

/** Crossfade duration for background/sprite transitions. */
export const FADE_MS = 300;

/** Character sprites are scaled to this on-stage height. */
export const CHAR_H = 620;

/** Speaker-name color when a character declares none (or the id is undeclared). */
export const DEFAULT_NAME_COLOR = "#6ab0ff";

/** A speaking character. Structurally matches @ludelier/schema's `Character`. */
export interface CharacterRef {
  id: string;
  name: string;
  color?: string;
}

const SLOT_FRACTION: Record<StageSprite["at"], number> = {
  left: 0.25,
  center: 0.5,
  right: 0.75,
};

/** Cover-fit: uniform scale that fills the stage, cropping overflow, preserving aspect. */
export function coverScale(textureWidth: number, textureHeight: number): number {
  return Math.max(STAGE_W / textureWidth, STAGE_H / textureHeight);
}

/** X position of a stage slot (sprites are anchored bottom-center, "standing" on the floor). */
export function slotX(at: StageSprite["at"]): number {
  return STAGE_W * SLOT_FRACTION[at];
}

/** Uniform scale that renders a character texture at the standard on-stage height. */
export function characterScale(textureHeight: number): number {
  return CHAR_H / textureHeight;
}

/**
 * Alpha of a linear fade after `elapsed` ms. Once the duration is reached the value
 * snaps to exactly `to` (and `done` flips) — no float drift in settled screenshots.
 */
export function tweenAlpha(
  from: number,
  to: number,
  elapsed: number,
  durationMs: number = FADE_MS,
): { alpha: number; done: boolean } {
  const t = Math.min(1, elapsed / durationMs);
  if (t >= 1) return { alpha: to, done: true };
  return { alpha: from + (to - from) * t, done: false };
}

/**
 * Resolve a speaker id to its display name + color. The engine's `pending.who` is the
 * character *id*; an undeclared id falls back to the id itself and the default color.
 */
export function resolveSpeaker(
  who: string,
  characters: ReadonlyMap<string, CharacterRef>,
): { name: string; color: string } {
  const c = characters.get(who);
  return { name: c?.name ?? who, color: c?.color ?? DEFAULT_NAME_COLOR };
}
