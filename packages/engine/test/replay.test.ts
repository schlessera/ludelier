import { describe, expect, it } from "vitest";
import { validateStory } from "@ludelier/schema";
import { Simulation, replayTrace } from "../src/simulation";
import type { Action } from "../src/state";
import { loadCafe } from "./fixture";

const story = loadCafe();
const path: Action[] = [
  { type: "ADVANCE" },
  { type: "CHOOSE", index: 0 },
  { type: "ADVANCE" },
  { type: "CHOOSE", index: 0 },
  { type: "ADVANCE" },
];

describe("trace record + replay", () => {
  it("replays a recorded trace with matching hashes", () => {
    const jsonl = new Simulation(story, { seed: 42 }).record(path);
    const result = replayTrace(story, jsonl, { seed: 42 });
    expect(result.ok).toBe(true);
    expect(result.steps).toBe(path.length);
  });

  it("replays a trace recorded from a non-default start node", () => {
    const result = validateStory({
      meta: { id: "alternate-start", title: "Alternate start", start: "default", seed: 1 },
      characters: [{ id: "n", name: "Narrator" }],
      nodes: [
        { id: "default", body: [{ op: "say", who: "n", text: "Default." }, { op: "end" }] },
        { id: "alternate", body: [{ op: "say", who: "n", text: "Alternate." }, { op: "end" }] },
      ],
    });
    if (!result.success) throw new Error("fixture invalid: " + JSON.stringify(result.issues));

    const trace = new Simulation(result.data, { start: "alternate" }).record([{ type: "ADVANCE" }]);
    expect(replayTrace(result.data, trace, { start: "alternate" })).toEqual({ ok: true, steps: 1 });
  });

  it("throws on a tampered trace hash", () => {
    const jsonl = new Simulation(story, { seed: 42 }).record(path);
    const lines = jsonl.split("\n");
    lines[lines.length - 1] = JSON.stringify({ action: { type: "ADVANCE" }, hash: "0000000000000000" });
    expect(() => replayTrace(story, lines.join("\n"), { seed: 42 })).toThrow(/mismatch/);
  });

  it("detects a wrong seed via the rolled value (hash divergence)", () => {
    // Record with seed 42, replay with a seed that yields a different luck roll.
    const jsonl = new Simulation(story, { seed: 42 }).record(path);
    const recorded = new Simulation(story, { seed: 42 }).run(path).vars.luck;
    // Find a seed whose roll differs, to guarantee divergence deterministically.
    let badSeed = 42;
    for (const candidate of [1, 2, 3, 7, 99, 1234]) {
      const luck = new Simulation(story, { seed: candidate }).run(path).vars.luck;
      if (luck !== recorded) {
        badSeed = candidate;
        break;
      }
    }
    expect(badSeed).not.toBe(42);
    expect(() => replayTrace(story, jsonl, { seed: badSeed })).toThrow(/mismatch/);
  });

  it("detects an audio cue change through deterministic hashes and replay", () => {
    const audioStory = (asset: string) => {
      const result = validateStory({
        meta: { id: "audio", title: "Audio", start: "a", seed: 1 },
        characters: [{ id: "n", name: "Narrator" }],
        assets: [
          { id: "theme", src: "/audio/theme.ogg", kind: "audio" },
          { id: "battle", src: "/audio/battle.ogg", kind: "audio" },
        ],
        nodes: [
          {
            id: "a",
            body: [
              { op: "say", who: "n", text: "Start." },
              { op: "sound", channel: "music", asset },
              { op: "say", who: "n", text: "After cue." },
            ],
          },
        ],
      });
      if (!result.success) throw new Error("fixture invalid: " + JSON.stringify(result.issues));
      return result.data;
    };
    const action: Action[] = [{ type: "ADVANCE" }];
    const themed = new Simulation(audioStory("theme"), { seed: 1 });
    const battle = new Simulation(audioStory("battle"), { seed: 1 });

    themed.run(action);
    battle.run(action);

    expect(themed.hash()).not.toBe(battle.hash());
    const trace = new Simulation(audioStory("theme"), { seed: 1 }).record(action);
    expect(() => replayTrace(audioStory("battle"), trace, { seed: 1 })).toThrow(/mismatch/);
  });

  it("verifies opening transient SFX before replaying actions", () => {
    const openingSfxStory = (asset: string) => {
      const result = validateStory({
        meta: { id: "opening-sfx", title: "Opening SFX", start: "a", seed: 1 },
        characters: [{ id: "n", name: "Narrator" }],
        assets: [
          { id: "hit", src: "/audio/hit.ogg", kind: "audio" },
          { id: "chime", src: "/audio/chime.ogg", kind: "audio" },
        ],
        nodes: [
          {
            id: "a",
            body: [
              { op: "sound", channel: "sfx", asset },
              { op: "say", who: "n", text: "Opening." },
              { op: "end" },
            ],
          },
        ],
      });
      if (!result.success) throw new Error("fixture invalid: " + JSON.stringify(result.issues));
      return result.data;
    };
    const actions: Action[] = [{ type: "ADVANCE" }];
    const hit = new Simulation(openingSfxStory("hit"), { seed: 1 });
    const chime = new Simulation(openingSfxStory("chime"), { seed: 1 });

    hit.run(actions);
    chime.run(actions);
    expect(hit.hash()).toBe(chime.hash()); // The opening-only event has been cleared by ADVANCE.

    const source = new Simulation(openingSfxStory("hit"), { seed: 1 });
    const initialHash = source.hash();
    const trace = source.record(actions);
    expect(JSON.parse(trace.split("\n")[0]!)).toEqual({ version: 2, initialHash });

    expect(() => replayTrace(openingSfxStory("chime"), trace, { seed: 1 })).toThrow(/initial state/);
  });

  it("rejects malformed action records before dispatching them", () => {
    const trace = new Simulation(story, { seed: 42 }).record([{ type: "ADVANCE" }]);
    const [header, step] = trace.split("\n");
    const { hash } = JSON.parse(step!) as { hash: string };

    for (const action of ["ADVANCE", { type: "CHOOSE", index: "0" }, { type: "CHOOSE", index: true }]) {
      const malformedTrace = [header, JSON.stringify({ action, hash })].join("\n");
      expect(() => replayTrace(story, malformedTrace, { seed: 42 })).toThrow(/invalid trace at line 2/);
    }
  });
});
