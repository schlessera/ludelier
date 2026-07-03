import { describe, expect, it } from "vitest";
import {
  type CharacterRef,
  CHAR_H,
  characterScale,
  coverScale,
  DEFAULT_NAME_COLOR,
  FADE_MS,
  resolveSpeaker,
  slotX,
  STAGE_H,
  STAGE_W,
  tweenAlpha,
} from "../src/layout";

describe("coverScale", () => {
  it("returns 1 for a texture that exactly matches the stage", () => {
    expect(coverScale(STAGE_W, STAGE_H)).toBe(1);
  });

  it("scales by height for a wider-than-stage aspect (cropping the sides)", () => {
    // 3200×720: width already covers at height scale 1; height governs.
    expect(coverScale(3200, 720)).toBe(1);
    // 2560×720 at half size: height must reach 720 → scale 2 (width overflows).
    expect(coverScale(2560, 360)).toBe(2);
  });

  it("scales by width for a taller-than-stage aspect (cropping top/bottom)", () => {
    // 640×720: width must double to cover → scale 2, height overflows.
    expect(coverScale(640, 720)).toBe(2);
  });

  it("upscales small textures to cover the stage", () => {
    expect(coverScale(128, 72)).toBe(10);
  });
});

describe("slotX", () => {
  it("places the three slots at quarter points of the stage width", () => {
    expect(slotX("left")).toBe(STAGE_W * 0.25);
    expect(slotX("center")).toBe(STAGE_W * 0.5);
    expect(slotX("right")).toBe(STAGE_W * 0.75);
  });
});

describe("characterScale", () => {
  it("renders a texture of the standard height at scale 1", () => {
    expect(characterScale(CHAR_H)).toBe(1);
  });

  it("shrinks oversized art and grows undersized art to the standard height", () => {
    expect(characterScale(CHAR_H * 2)).toBe(0.5);
    expect(characterScale(CHAR_H / 2)).toBe(2);
  });
});

describe("tweenAlpha", () => {
  it("starts at `from` when no time has elapsed", () => {
    expect(tweenAlpha(0, 1, 0)).toEqual({ alpha: 0, done: false });
    expect(tweenAlpha(0.4, 0, 0)).toEqual({ alpha: 0.4, done: false });
  });

  it("interpolates linearly mid-fade", () => {
    expect(tweenAlpha(0, 1, FADE_MS / 2)).toEqual({ alpha: 0.5, done: false });
    expect(tweenAlpha(1, 0, FADE_MS * 0.75)).toEqual({ alpha: 0.25, done: false });
  });

  it("snaps to exactly `to` at the duration boundary (no float drift)", () => {
    const { alpha, done } = tweenAlpha(0.123, 1, FADE_MS);
    expect(alpha).toBe(1); // strict identity — the screenshot-stability rule
    expect(done).toBe(true);
  });

  it("stays snapped past the duration", () => {
    expect(tweenAlpha(0, 1, FADE_MS * 10)).toEqual({ alpha: 1, done: true });
    expect(tweenAlpha(1, 0, FADE_MS + 1)).toEqual({ alpha: 0, done: true });
  });

  it("is not done one instant before the duration", () => {
    const { alpha, done } = tweenAlpha(0, 1, FADE_MS - 0.001);
    expect(done).toBe(false);
    expect(alpha).toBeLessThan(1);
  });

  it("honours a custom duration", () => {
    expect(tweenAlpha(0, 1, 50, 100)).toEqual({ alpha: 0.5, done: false });
    expect(tweenAlpha(0, 1, 100, 100)).toEqual({ alpha: 1, done: true });
  });

  it("interpolates between arbitrary endpoints, both directions", () => {
    expect(tweenAlpha(0.2, 0.8, FADE_MS / 2)).toEqual({ alpha: 0.5, done: false });
    expect(tweenAlpha(0.8, 0.2, FADE_MS / 2)).toEqual({ alpha: 0.5, done: false });
  });
});

describe("resolveSpeaker", () => {
  const cast = new Map<string, CharacterRef>([
    ["her", { id: "her", name: "Her", color: "#ff9ec3" }],
    ["narrator", { id: "narrator", name: "Narrator" }],
  ]);

  it("resolves a declared character to its display name and color", () => {
    expect(resolveSpeaker("her", cast)).toEqual({ name: "Her", color: "#ff9ec3" });
  });

  it("falls back to the default color when the character declares none", () => {
    expect(resolveSpeaker("narrator", cast)).toEqual({
      name: "Narrator",
      color: DEFAULT_NAME_COLOR,
    });
  });

  it("falls back to the raw id + default color for an undeclared speaker", () => {
    expect(resolveSpeaker("ghost", cast)).toEqual({ name: "ghost", color: DEFAULT_NAME_COLOR });
    expect(resolveSpeaker("ghost", new Map())).toEqual({
      name: "ghost",
      color: DEFAULT_NAME_COLOR,
    });
  });
});
