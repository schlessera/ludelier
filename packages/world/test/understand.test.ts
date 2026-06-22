import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import type { Reference } from "../src/understand/references";
import { loadCafe } from "./fixture";

const world = createWorld();

function run(name: string, story: Story, params: unknown = {}) {
  const task = world.get(name);
  if (!task || !task.run) throw new Error(`no understand task "${name}"`);
  return task.run(story, params);
}

describe("list-variables", () => {
  it("infers trust + luck from cafe, sorted", () => {
    const res = run("list-variables", loadCafe());
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual(["luck", "trust"]);
  });
});

describe("find-references", () => {
  it('finds the show statements that use asset "her"', () => {
    const res = run("find-references", loadCafe(), { id: "her" });
    expect(res.success).toBe(true);
    if (res.success) {
      const refs = res.data as Reference[];
      const assetRefs = refs.filter((r) => r.kind === "asset");
      // cafe shows "her" in four nodes (start, sit, talk, ending_lucky)
      expect(assetRefs).toHaveLength(4);
      // "her" is also a character id now (she speaks) — find-references reports both roles
      expect(refs.some((r) => r.kind === "character")).toBe(true);
    }
  });
});

describe("validate", () => {
  it("passes the cafe story", () => {
    expect(run("validate", loadCafe()).success).toBe(true);
  });

  it("surfaces a cross-reference issue on a broken story", () => {
    const broken = {
      meta: { id: "b", title: "B", start: "nope" },
      characters: [],
      assets: [],
      nodes: [{ id: "a", body: [{ op: "end" }] }],
    } as unknown as Story;
    const res = run("validate", broken);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.path === "meta.start")).toBe(true);
  });
});

describe("get-node", () => {
  it("returns a node by id", () => {
    const res = run("get-node", loadCafe(), { id: "sit" });
    expect(res.success).toBe(true);
  });

  it("fails with a not-found issue on an unknown id", () => {
    const res = run("get-node", loadCafe(), { id: "ghost" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues[0]!.message).toMatch(/unknown node "ghost"/);
  });
});

describe("determinism (sorted output regardless of authored order)", () => {
  const unsorted: Story = {
    meta: { id: "s", title: "S", start: "a" },
    characters: [
      { id: "zoe", name: "Zoe" },
      { id: "ana", name: "Ana" },
    ],
    assets: [],
    nodes: [{ id: "a", body: [{ op: "end" }] }],
  };

  it("list-characters sorts by id", () => {
    const res = run("list-characters", unsorted);
    expect(res.success).toBe(true);
    if (res.success) {
      const ids = (res.data as { id: string }[]).map((c) => c.id);
      expect(ids).toEqual(["ana", "zoe"]);
    }
  });
});
