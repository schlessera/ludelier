import { describe, expect, it } from "vitest";
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

  it("throws on a tampered trace hash", () => {
    const jsonl = new Simulation(story, { seed: 42 }).record(path);
    const lines = jsonl.split("\n");
    lines[lines.length - 1] = JSON.stringify({ action: { type: "ADVANCE" }, hash: "deadbeef" });
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
});
