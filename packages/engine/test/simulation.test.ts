import { describe, expect, it } from "vitest";
import { Simulation } from "../src/simulation";
import type { Action } from "../src/state";
import { loadCafe } from "./fixture";

const story = loadCafe();
const goodPath: Action[] = [
  { type: "ADVANCE" },
  { type: "CHOOSE", index: 0 },
  { type: "ADVANCE" },
  { type: "CHOOSE", index: 0 },
  { type: "ADVANCE" },
];

describe("Simulation", () => {
  it("runs a full path to completion", () => {
    const sim = new Simulation(story, { seed: 42 });
    sim.run(goodPath);
    expect(sim.state.done).toBe(true);
    expect(sim.state.pending.kind).toBe("end");
  });

  it("records a deterministic transcript", () => {
    const sim = new Simulation(story, { seed: 42 });
    sim.run(goodPath);
    const lines = sim.transcript().map((t) => `${t.who}: ${t.text}`);
    expect(lines[0]).toBe("narrator: A quiet café. She looks up as you enter.");
    expect(lines).toContain("narrator: You talk for hours. The coffee goes cold, happily.");
  });

  it("hashes identically for identical runs", () => {
    const a = new Simulation(story, { seed: 42 });
    const b = new Simulation(story, { seed: 42 });
    a.run(goodPath);
    b.run(goodPath);
    expect(a.hash()).toBe(b.hash());
  });
});
