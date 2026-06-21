import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import { applyEdit } from "../src/applyEdit";
import type { Result } from "../src/result";

const world = createWorld();

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "narrator", name: "Narrator" }],
  assets: [],
  nodes: [
    { id: "a", body: [{ op: "say", who: "narrator", text: "hi" }, { op: "jump", goto: "b" }] },
    { id: "b", body: [{ op: "end" }] },
  ],
};

function expectOk(res: Result<Story>): Story {
  if (!res.success) throw new Error("expected ok, got issues: " + JSON.stringify(res.issues));
  return res.data;
}

describe("applyEdit — spine builds a valid story", () => {
  it("create-node + append-say + append-end yields a story validateStory accepts", () => {
    let s = expectOk(applyEdit(world, base, "create-node", { id: "c" }));
    s = expectOk(applyEdit(world, s, "append-say", { nodeId: "c", who: "narrator", text: "yo" }));
    s = expectOk(applyEdit(world, s, "append-end", { nodeId: "c" }));
    const node = s.nodes.find((n) => n.id === "c")!;
    expect(node.body.map((st) => st.op)).toEqual(["say", "end"]);
  });

  it("rewire-goto repoints a choice option and re-validates", () => {
    let s = expectOk(applyEdit(world, base, "create-node", { id: "c" }));
    s = expectOk(applyEdit(world, s, "append-end", { nodeId: "c" }));
    s = expectOk(applyEdit(world, s, "append-choice", { nodeId: "b", options: [{ label: "go", goto: "a" }] }));
    s = expectOk(applyEdit(world, s, "rewire-goto", { nodeId: "b", index: 1, goto: "c", optionIndex: 0 }));
    const choice = s.nodes.find((n) => n.id === "b")!.body[1]!;
    expect(choice.op === "choice" && choice.options[0]!.goto).toBe("c");
  });

  it("register-asset then append-show referencing it passes", () => {
    let s = expectOk(applyEdit(world, base, "register-asset", { id: "bg", src: "/bg.webp" }));
    s = expectOk(applyEdit(world, s, "append-show", { nodeId: "b", sprite: "slot", asset: "bg" }));
    const show = s.nodes.find((n) => n.id === "b")!.body[1]!;
    expect(show.op === "show" && show.at).toBe("center");
  });
});

describe("applyEdit — always-valid invariant rejects bad edits, story untouched", () => {
  it("delete-node still referenced by a goto fails with a cross-ref issue", () => {
    const res = applyEdit(world, base, "delete-node", { id: "b" });
    expect(res.success).toBe(false);
    // original story still has node b
    expect(base.nodes.some((n) => n.id === "b")).toBe(true);
  });

  it("append-show referencing an unregistered asset fails", () => {
    const res = applyEdit(world, base, "append-show", { nodeId: "b", sprite: "slot", asset: "ghost" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown asset/.test(i.message))).toBe(true);
  });

  it("append-say with an unknown who fails the say.who check; story untouched", () => {
    const res = applyEdit(world, base, "append-say", { nodeId: "b", who: "ghost", text: "x" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown character "ghost"/.test(i.message))).toBe(true);
    expect(base.nodes.find((n) => n.id === "b")!.body).toHaveLength(1);
  });

  it("set-meta start to an unknown node fails with the meta.start issue", () => {
    const res = applyEdit(world, base, "set-meta", { start: "nope" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.path === "meta.start")).toBe(true);
  });
});

describe("applyEdit — invalid params rejected before apply", () => {
  it("create-node with a non-slug id is rejected", () => {
    expect(applyEdit(world, base, "create-node", { id: "bad id!" }).success).toBe(false);
  });

  it("append-say missing text is rejected", () => {
    expect(applyEdit(world, base, "append-say", { nodeId: "a", who: "narrator" }).success).toBe(false);
  });

  it("unknown command name is rejected", () => {
    expect(applyEdit(world, base, "frobnicate", {}).success).toBe(false);
  });
});
