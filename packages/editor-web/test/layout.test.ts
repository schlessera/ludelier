import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/storymap/layout";

describe("layoutGraph", () => {
  it("assigns exactly one finite position per node", () => {
    const pos = layoutGraph(
      ["a", "b", "c"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    expect(pos.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
    expect(pos.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it("lays out a graph with a cycle (back-edge) without throwing", () => {
    expect(() =>
      layoutGraph(
        ["a", "b"],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    ).not.toThrow();
  });

  it("positions an isolated node with no edges", () => {
    const pos = layoutGraph(["lonely"], []);
    expect(pos).toHaveLength(1);
    expect(pos[0]!.id).toBe("lonely");
  });

  it("is deterministic and independent of input order", () => {
    const a = layoutGraph(
      ["x", "y", "z"],
      [
        { from: "x", to: "y" },
        { from: "y", to: "z" },
      ],
    );
    const b = layoutGraph(
      ["z", "y", "x"],
      [
        { from: "y", to: "z" },
        { from: "x", to: "y" },
      ],
    );
    expect(a).toEqual(b);
  });

  it("ignores edges to unknown nodes rather than throwing", () => {
    expect(() => layoutGraph(["a"], [{ from: "a", to: "ghost" }])).not.toThrow();
  });
});
