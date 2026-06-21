import { describe, expect, it } from "vitest";
import { Simulation, type Action } from "@ludelier/engine";
import { createWorld } from "../src/index";
import { loadCafe } from "./fixture";

const world = createWorld();

// The cafe "good ending" path (matches examples/cafe.actions.json).
const goodEnding: Action[] = [
  { type: "ADVANCE" },
  { type: "CHOOSE", index: 0 },
  { type: "ADVANCE" },
  { type: "CHOOSE", index: 0 },
  { type: "ADVANCE" },
];

function simulate(actions: Action[]) {
  const res = world.get("simulate")!.run!(loadCafe(), { actions });
  if (!res.success) throw new Error("simulate failed");
  return res.data as { hash: string; reached: string[] };
}

describe("simulate", () => {
  it("matches engine.Simulation's hash for the same story + actions", () => {
    const sim = new Simulation(loadCafe());
    sim.run(goodEnding);
    expect(simulate(goodEnding).hash).toBe(sim.hash());
  });

  it("reports the reached nodes including the good ending", () => {
    expect(simulate(goodEnding).reached).toContain("ending_good");
  });

  it("is deterministic across repeated runs", () => {
    expect(simulate(goodEnding).hash).toBe(simulate(goodEnding).hash);
  });
});
