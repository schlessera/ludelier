import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { Simulation } from "../src/simulation";

const story: Story = {
  meta: { id: "m", title: "M", start: "intro", seed: 0 },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [
    {
      id: "intro",
      body: [
        { op: "set", var: "gold", value: 10 },
        { op: "jump", goto: "gate" },
      ],
    },
    {
      id: "gate",
      body: [
        { op: "branch", cond: { var: "gold", cmp: "gt", value: 5 }, goto: "rich" },
        { op: "say", who: "n", text: "poor" },
        { op: "end" },
      ],
    },
    { id: "rich", body: [{ op: "say", who: "n", text: "rich" }, { op: "end" }] },
    { id: "checkout", body: [{ op: "say", who: "n", text: "pay here" }, { op: "end" }] },
  ],
};

function pendingText(sim: Simulation): string | undefined {
  const p = sim.state.pending;
  return p.kind === "say" ? p.text : undefined;
}

describe("Simulation start-node override", () => {
  it("begins playback at the chosen node, not meta.start (AE4)", () => {
    const sim = new Simulation(story, { start: "checkout" });
    expect(sim.state.cursor.node).toBe("checkout");
    expect(pendingText(sim)).toBe("pay here");
  });

  it("is unchanged when start is omitted (defaults to meta.start)", () => {
    // Default play of the full path: intro sets gold=10, jumps to gate, branch is true -> rich.
    const def = new Simulation(story);
    const explicit = new Simulation(story, { start: "intro" });
    expect(def.hash()).toBe(explicit.hash());
    expect(pendingText(def)).toBe("rich");
  });

  it("starts with fresh default variable state — upstream sets have not run", () => {
    // Starting at `gate` directly: `gold` is unset, so the gold>5 branch is false and we
    // fall through to "poor" instead of the "rich" a real path through `intro` would reach.
    const sim = new Simulation(story, { start: "gate" });
    expect(sim.state.cursor.node).toBe("gate");
    expect(pendingText(sim)).toBe("poor");
  });

  it("is deterministic for the same story + seed + start", () => {
    const a = new Simulation(story, { seed: 1, start: "gate" });
    const b = new Simulation(story, { seed: 1, start: "gate" });
    expect(a.hash()).toBe(b.hash());
  });

  it("surfaces an unknown start node as an error, never a silent fallback", () => {
    expect(() => new Simulation(story, { start: "nope" })).toThrow(/node not found/);
  });
});
