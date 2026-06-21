import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { diffStories } from "../src/understand/diff";

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [
    { id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] },
    { id: "b", body: [{ op: "end" }] },
  ],
};

describe("diffStories", () => {
  it("reports an appended statement as a change on that node", () => {
    const to: Story = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "a" ? { ...n, body: [...n.body, { op: "jump", goto: "b" }] } : n,
      ),
    };
    const d = diffStories(base, to);
    expect(d.nodes.changed).toEqual(["a"]);
    expect(d.nodes.added).toEqual([]);
    expect(d.nodes.removed).toEqual([]);
  });

  it("is empty for a story diffed against itself", () => {
    const d = diffStories(base, base);
    expect(d).toEqual({
      meta: "unchanged",
      nodes: { added: [], removed: [], changed: [] },
      characters: { added: [], removed: [], changed: [] },
      assets: { added: [], removed: [], changed: [] },
    });
  });

  it("reports added and removed nodes, sorted", () => {
    const to: Story = {
      ...base,
      nodes: [
        { id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] },
        { id: "c", body: [{ op: "end" }] },
        { id: "z", body: [{ op: "end" }] },
      ],
    };
    const d = diffStories(base, to);
    expect(d.nodes.added).toEqual(["c", "z"]);
    expect(d.nodes.removed).toEqual(["b"]);
  });
});
