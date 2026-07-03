import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import type { EditorSnapshot } from "@ludelier/editor-core";
import { buildStoryGraph } from "../src/storymap/model";

const story: Story = {
  meta: { id: "m", title: "M", start: "sit" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [
    {
      id: "sit",
      body: [
        {
          op: "choice",
          options: [
            { label: "Pay now", goto: "checkout" },
            { label: "Run a tab", goto: "tab", if: { var: "gold", cmp: "gt", value: 5 } },
          ],
        },
      ],
    },
    {
      id: "talk",
      body: [
        { op: "branch", cond: { var: "mood", cmp: "lt", value: 0 }, goto: "sulk" },
        { op: "say", who: "n", text: "hm" },
        { op: "jump", goto: "recover" },
      ],
    },
    { id: "quiet", body: [{ op: "say", who: "n", text: "..." }, { op: "end" }] },
    { id: "checkout", body: [{ op: "end" }] },
    { id: "tab", body: [{ op: "end" }] },
    { id: "sulk", body: [{ op: "say", who: "n", text: "..." }] },
    { id: "recover", body: [{ op: "end" }] },
    { id: "orphan", body: [{ op: "end" }] },
  ],
};

const snap: EditorSnapshot = {
  story,
  valid: true,
  issues: [],
  canUndo: false,
  canRedo: false,
  records: [],
  graph: {
    entry: "sit",
    nodes: story.nodes.map((n) => n.id).sort(),
    edges: [],
    reachable: ["checkout", "quiet", "recover", "sit", "sulk", "tab", "talk"],
    unreachable: ["orphan"],
    deadEnds: ["sulk"],
  },
};

describe("buildStoryGraph", () => {
  const node = (id: string) => buildStoryGraph(snap, null).nodes.find((n) => n.id === id)!;
  const edge = (from: string, to: string) =>
    buildStoryGraph(snap, null).edges.find((e) => e.source === from && e.target === to)!;

  it("marks start, unreachable, and dead-end nodes from the snapshot graph (AE3)", () => {
    expect(node("sit").data.isStart).toBe(true);
    expect(node("orphan").data.isUnreachable).toBe(true);
    expect(node("sulk").data.isDeadEnd).toBe(true);
    expect(node("checkout").data.isStart).toBe(false);
  });

  it("labels a gated choice option and styles it conditional (AE1)", () => {
    expect(edge("sit", "tab").className).toBe("edge-conditional");
    expect(String(edge("sit", "tab").label)).toContain("Run a tab");
    expect(edge("sit", "checkout").className).toBe("edge-plain");
  });

  it("styles a branch conditional and its sibling jump plain (AE2)", () => {
    expect(edge("talk", "sulk").className).toBe("edge-conditional");
    expect(edge("talk", "sulk").label).toBe("mood < 0");
    expect(edge("talk", "recover").className).toBe("edge-plain");
  });

  it("emits no outgoing edges for a node with no transitions", () => {
    expect(buildStoryGraph(snap, null).edges.some((e) => e.source === "quiet")).toBe(false);
  });

  it("gives every node a finite position", () => {
    const { nodes } = buildStoryGraph(snap, null);
    expect(nodes).toHaveLength(story.nodes.length);
    expect(nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
  });

  it("flags the selected node", () => {
    const { nodes } = buildStoryGraph(snap, "sit");
    expect(nodes.find((n) => n.id === "sit")!.data.isSelected).toBe(true);
    expect(nodes.find((n) => n.id === "checkout")!.data.isSelected).toBe(false);
  });
});
