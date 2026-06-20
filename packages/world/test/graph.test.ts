import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import type { GraphReport } from "../src/understand/graph";

const world = createWorld();

function graph(story: Story): GraphReport {
  const res = world.get("graph")!.run!(story, {});
  if (!res.success) throw new Error("graph failed");
  return res.data as GraphReport;
}

const story: Story = {
  meta: { id: "g", title: "G", start: "start" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [
    {
      id: "start",
      body: [{ op: "choice", options: [{ label: "b", goto: "b" }, { label: "stuck", goto: "stuck" }] }],
    },
    { id: "b", body: [{ op: "jump", goto: "d" }] },
    { id: "d", body: [{ op: "end" }] },
    { id: "stuck", body: [{ op: "say", who: "n", text: "x" }] },
    { id: "orphan", body: [{ op: "end" }] },
  ],
};

describe("graph", () => {
  it("reports the entry, reachable set, orphan as unreachable, and stuck as a dead-end", () => {
    const g = graph(story);
    expect(g.entry).toBe("start");
    expect(g.reachable).toEqual(["b", "d", "start", "stuck"]);
    expect(g.unreachable).toEqual(["orphan"]);
    // stuck has no path to an end; orphan has an end so it is NOT a dead-end
    expect(g.deadEnds).toEqual(["stuck"]);
  });

  it("does not flag a reconverging diamond branch as a dead-end (b reaches d)", () => {
    const g = graph(story);
    expect(g.deadEnds).not.toContain("b");
  });

  it("produces stably sorted output across runs", () => {
    expect(graph(story)).toEqual(graph(story));
  });
});
