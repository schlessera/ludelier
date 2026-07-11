import { describe, expect, it } from "vitest";
import { validateStory, type Story } from "@ludelier/schema";
import { exploreStory } from "../src/explore";
import { reducer } from "../src/reducer";
import { Simulation } from "../src/simulation";

function build(body: unknown[], extraNodes: unknown[] = []): Story {
  const result = validateStory({
    meta: { id: "audio", title: "Audio", start: "a", seed: 1 },
    characters: [{ id: "n", name: "Narrator" }],
    assets: [
      { id: "theme", src: "/audio/theme.ogg", kind: "audio" },
      { id: "battle", src: "/audio/battle.ogg", kind: "audio" },
      { id: "line", src: "/audio/line.ogg", kind: "audio" },
      { id: "hit", src: "/audio/hit.ogg", kind: "audio" },
      { id: "chime", src: "/audio/chime.ogg", kind: "audio" },
    ],
    nodes: [{ id: "a", body }, ...extraNodes],
  });
  if (!result.success) throw new Error("fixture invalid: " + JSON.stringify(result.issues));
  return result.data;
}

describe("logical audio state", () => {
  it("emits opening sound cues in authored order with channel-specific default loops", () => {
    const story = build([
      { op: "sound", channel: "music", asset: "theme" },
      { op: "sound", channel: "sfx", asset: "hit" },
      { op: "sound", channel: "voice", asset: "line" },
      { op: "say", who: "n", text: "Ready." },
    ]);

    const state = new Simulation(story).state;

    expect(state.pending).toEqual({ kind: "say", who: "n", text: "Ready." });
    expect(state.audio).toEqual({
      music: { asset: "theme", loop: true, startedAtSeq: 0 },
      voice: { asset: "line", loop: false, startedAtSeq: 2 },
      events: [
        { type: "play", seq: 0, channel: "music", asset: "theme", loop: true },
        { type: "play", seq: 1, channel: "sfx", asset: "hit", loop: false },
        { type: "play", seq: 2, channel: "voice", asset: "line", loop: false },
      ],
      nextEventSeq: 3,
    });
  });

  it("retains every repeated SFX cue through a blocking state and clears only on the next resolution", () => {
    const story = build([
      { op: "sound", channel: "sfx", asset: "hit" },
      { op: "sound", channel: "sfx", asset: "hit" },
      { op: "sound", channel: "sfx", asset: "chime" },
      { op: "say", who: "n", text: "First." },
      { op: "sound", channel: "sfx", asset: "hit" },
      { op: "say", who: "n", text: "Second." },
    ]);
    let state = new Simulation(story).state;

    expect(state.audio.events).toEqual([
      { type: "play", seq: 0, channel: "sfx", asset: "hit", loop: false },
      { type: "play", seq: 1, channel: "sfx", asset: "hit", loop: false },
      { type: "play", seq: 2, channel: "sfx", asset: "chime", loop: false },
    ]);

    state = reducer(story, state, { type: "ADVANCE" });

    expect(state.pending).toEqual({ kind: "say", who: "n", text: "Second." });
    expect(state.audio.events).toEqual([{ type: "play", seq: 3, channel: "sfx", asset: "hit", loop: false }]);
    expect(state.audio.nextEventSeq).toBe(4);
  });

  it("replaces desired channels and emits sequenced stops without persistent SFX", () => {
    const story = build([
      { op: "sound", channel: "music", asset: "theme" },
      { op: "sound", channel: "voice", asset: "line", loop: true },
      { op: "say", who: "n", text: "One." },
      { op: "sound", channel: "music", asset: "battle", loop: false },
      { op: "say", who: "n", text: "Two." },
      { op: "stop-sound", channel: "music" },
      { op: "say", who: "n", text: "Three." },
      { op: "stop-sound", channel: "sfx" },
      { op: "say", who: "n", text: "Four." },
      { op: "stop-sound", channel: "voice" },
      { op: "say", who: "n", text: "Five." },
    ]);
    let state = new Simulation(story).state;

    state = reducer(story, state, { type: "ADVANCE" });
    expect(state.audio.music).toEqual({ asset: "battle", loop: false, startedAtSeq: 2 });
    expect(state.audio.voice).toEqual({ asset: "line", loop: true, startedAtSeq: 1 });
    expect(state.audio.events).toEqual([
      { type: "play", seq: 2, channel: "music", asset: "battle", loop: false },
    ]);

    state = reducer(story, state, { type: "ADVANCE" });
    expect(state.audio.music).toBeNull();
    expect(state.audio.voice).toEqual({ asset: "line", loop: true, startedAtSeq: 1 });
    expect(state.audio.events).toEqual([{ type: "stop", seq: 3, channel: "music" }]);

    state = reducer(story, state, { type: "ADVANCE" });
    expect(state.audio.voice).toEqual({ asset: "line", loop: true, startedAtSeq: 1 });
    expect(state.audio.events).toEqual([{ type: "stop", seq: 4, channel: "sfx" }]);

    state = reducer(story, state, { type: "ADVANCE" });
    expect(state.audio.music).toBeNull();
    expect(state.audio.voice).toBeNull();
    expect(state.audio.events).toEqual([{ type: "stop", seq: 5, channel: "voice" }]);
    expect(state.audio.nextEventSeq).toBe(6);
  });

  it("explores a recurring SFX cue without treating event history as a new state", () => {
    const story = build(
      [
        { op: "sound", channel: "sfx", asset: "chime" },
        { op: "say", who: "n", text: "Again?" },
        {
          op: "choice",
          options: [
            { label: "Loop", goto: "a" },
            { label: "Exit", goto: "end" },
          ],
        },
      ],
      [{ id: "end", body: [{ op: "end" }] }],
    );

    expect(exploreStory(story, { maxStates: 10 })).toMatchObject({
      reached: ["a", "end"],
      endReachable: true,
      truncated: false,
      crashed: false,
    });
  });
});
