import { describe, expect, it } from "vitest";
import { validateStory, type Story } from "@ludelier/schema";
import { unwrittenVarReads, conditionTypeIssues } from "../src/understand/variables";
import { exploreTask } from "../src/understand/explore";
import { hashStory } from "../src/canonical";
import { createWorld } from "../src/index";
import { loadCafe } from "./fixture";

function build(story: unknown): Story {
  const res = validateStory(story);
  if (!res.success) throw new Error("fixture invalid: " + JSON.stringify(res.issues));
  return res.data;
}

describe("unwrittenVarReads", () => {
  it("flags a var read in a choice if but never written", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [{ op: "choice", options: [
          { label: "go", goto: "b", if: { var: "ghost", cmp: "gte", value: 1 } },
          { label: "stay", goto: "b" },
        ] }] },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    expect(unwrittenVarReads(story)).toEqual(["ghost"]);
  });

  it("does not flag a var that is written somewhere", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [
          { op: "set", var: "trust", value: 0 },
          { op: "choice", options: [{ label: "go", goto: "b", if: { var: "trust", cmp: "gte", value: 0 } }] },
        ] },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    expect(unwrittenVarReads(story)).toEqual([]);
  });

  it("the example story has no unwritten var reads", () => {
    expect(unwrittenVarReads(loadCafe())).toEqual([]);
  });
});

describe("conditionTypeIssues", () => {
  it("flags an ordered comparison against a non-number literal", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [{ op: "choice", options: [
          { label: "go", goto: "b", if: { var: "n", cmp: "gt", value: "high" } },
        ] }] },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    expect(conditionTypeIssues(story).length).toBe(1);
    expect(conditionTypeIssues(story)[0]).toContain("non-number");
  });

  it("flags an ordered comparison on a var set to a string elsewhere", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [
          { op: "set", var: "n", value: "lots" },
          { op: "choice", options: [{ label: "go", goto: "b", if: { var: "n", cmp: "gte", value: 1 } }] },
        ] },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    expect(conditionTypeIssues(story).some((m) => m.includes("type-confused"))).toBe(true);
  });

  it("does not flag a clean numeric ordered comparison", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [
          { op: "set", var: "n", value: 3 },
          { op: "choice", options: [{ label: "go", goto: "b", if: { var: "n", cmp: "gte", value: 1 } }] },
        ] },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    expect(conditionTypeIssues(story)).toEqual([]);
  });

  it("the example story has no condition type issues", () => {
    expect(conditionTypeIssues(loadCafe())).toEqual([]);
  });
});

describe("explore task is registered and runs", () => {
  it("is in the world registry as an understand task", () => {
    const world = createWorld();
    const t = world.get("explore");
    expect(t?.kind).toBe("understand");
  });

  it("reports an end is reachable for the example story", () => {
    const res = exploreTask.run!(loadCafe(), {});
    expect(res.success).toBe(true);
    if (res.success) expect((res.data as { endReachable: boolean }).endReachable).toBe(true);
  });
});

describe("branch in the world API", () => {
  const story = () =>
    build({
      meta: { id: "x", title: "x", start: "a", seed: 1 },
      characters: [{ id: "n", name: "N" }],
      nodes: [
        {
          id: "a",
          body: [
            { op: "set", var: "f", value: 1 },
            { op: "branch", cond: { var: "f", cmp: "eq", value: 1 }, goto: "lucky" },
            { op: "say", who: "n", text: "ordinary" },
            { op: "end" },
          ],
        },
        { id: "lucky", body: [{ op: "say", who: "n", text: "rare" }, { op: "end" }] },
      ],
    });

  it("graph counts the branch goto as an edge (so the target is reachable, not a dead end)", () => {
    const world = createWorld();
    const g = world.get("graph")!.run!(story(), {});
    expect(g.success).toBe(true);
    if (g.success) {
      const report = g.data as { edges: { from: string; to: string }[]; unreachable: string[]; deadEnds: string[] };
      expect(report.edges).toContainEqual({ from: "a", to: "lucky" });
      expect(report.unreachable).toEqual([]);
      expect(report.deadEnds).toEqual([]);
    }
  });

  it("explore takes the branch when its condition holds", () => {
    const res = exploreTask.run!(story(), {});
    expect(res.success).toBe(true);
    if (res.success) expect((res.data as { reached: string[] }).reached).toContain("lucky");
  });
});

describe("hashStory width", () => {
  it("is a 64-bit (16 hex char) digest", () => {
    expect(hashStory(loadCafe())).toMatch(/^[0-9a-f]{16}$/);
  });
});
