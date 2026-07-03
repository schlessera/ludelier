import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import { deriveFlowEdges, type FlowEdge } from "../src/index";

const world = createWorld();

function viaTask(story: Story): FlowEdge[] {
  const res = world.get("flow-edges")!.run!(story, {});
  if (!res.success) throw new Error("flow-edges failed");
  return res.data as FlowEdge[];
}

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
    {
      id: "split",
      body: [
        {
          op: "choice",
          options: [
            { label: "A", goto: "x" },
            { label: "B", goto: "x" },
          ],
        },
      ],
    },
    { id: "quiet", body: [{ op: "say", who: "n", text: "..." }, { op: "end" }] },
    { id: "checkout", body: [{ op: "end" }] },
    { id: "tab", body: [{ op: "end" }] },
    { id: "sulk", body: [{ op: "end" }] },
    { id: "recover", body: [{ op: "end" }] },
    { id: "x", body: [{ op: "end" }] },
  ],
};

const from = (edges: FlowEdge[], id: string) => edges.filter((e) => e.from === id);

describe("deriveFlowEdges", () => {
  it("labels a gated choice option conditional and shows its condition (AE1)", () => {
    const sit = from(deriveFlowEdges(story), "sit");
    expect(sit).toHaveLength(2);
    expect(sit.find((e) => e.to === "checkout")).toMatchObject({
      kind: "choice",
      conditional: false,
      label: "Pay now",
    });
    expect(sit.find((e) => e.to === "tab")).toMatchObject({
      kind: "choice",
      conditional: true,
      label: "Run a tab (if gold > 5)",
    });
  });

  it("renders branch fall-through as a conditional branch edge plus an unconditional jump (AE2)", () => {
    const talk = from(deriveFlowEdges(story), "talk");
    // the `say` between them yields no edge
    expect(talk).toHaveLength(2);
    expect(talk.find((e) => e.kind === "branch")).toMatchObject({
      to: "sulk",
      conditional: true,
      label: "mood < 0",
    });
    const jump = talk.find((e) => e.kind === "jump");
    expect(jump).toMatchObject({ to: "recover", conditional: false });
    expect(jump?.label).toBeUndefined();
  });

  it("keeps distinct options to the same target as separate edges", () => {
    const split = from(deriveFlowEdges(story), "split");
    expect(split).toHaveLength(2);
    expect(split.map((e) => e.label).sort()).toEqual(["A", "B"]);
    expect(split.every((e) => e.to === "x")).toBe(true);
  });

  it("emits no edges for a node with no transitions", () => {
    expect(from(deriveFlowEdges(story), "quiet")).toEqual([]);
  });

  it("is deterministic and independent of node order", () => {
    const reversed: Story = { ...story, nodes: [...story.nodes].reverse() };
    expect(deriveFlowEdges(reversed)).toEqual(deriveFlowEdges(story));
  });

  it("exposes the same result through the registered flow-edges task", () => {
    expect(viaTask(story)).toEqual(deriveFlowEdges(story));
  });
});
