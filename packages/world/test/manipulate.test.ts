import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import { applyEdit } from "../src/applyEdit";
import { normalizeStatementIds } from "../src/statement-id";
import type { Result } from "../src/result";

const world = createWorld();

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "narrator", name: "Narrator" }],
  assets: [],
  nodes: [
    { id: "a", body: [{ op: "say", who: "narrator", text: "hi" }, { op: "jump", goto: "b" }] },
    { id: "b", body: [{ op: "end" }] },
    // a non-terminal node (no end/jump) — safe to append to without orphaning anything.
    { id: "c", body: [{ op: "say", who: "narrator", text: "c" }] },
  ],
};

function expectOk(res: Result<Story>): Story {
  if (!res.success) throw new Error("expected ok, got issues: " + JSON.stringify(res.issues));
  return res.data;
}

describe("applyEdit — spine builds a valid story", () => {
  it("create-node + append-say + append-end yields a story validateStory accepts", () => {
    let s = expectOk(applyEdit(world, base, "create-node", { id: "d" }));
    s = expectOk(applyEdit(world, s, "append-say", { nodeId: "d", who: "narrator", text: "yo" }));
    s = expectOk(applyEdit(world, s, "append-end", { nodeId: "d" }));
    const node = s.nodes.find((n) => n.id === "d")!;
    expect(node.body.map((st) => st.op)).toEqual(["say", "end"]);
  });

  it("rewire-goto repoints a choice option and re-validates", () => {
    // append a choice to non-terminal node c → c = [say, choice]; the choice's fallback id is "c#1".
    let s = expectOk(applyEdit(world, base, "append-choice", { nodeId: "c", options: [{ label: "go", goto: "a" }] }));
    s = expectOk(applyEdit(world, s, "rewire-goto", { nodeId: "c", statementId: "c#1", goto: "b", optionIndex: 0 }));
    const choice = s.nodes.find((n) => n.id === "c")!.body[1]!;
    expect(choice.op === "choice" && choice.options[0]!.goto).toBe("b");
  });

  it("register-asset then append-show referencing it passes", () => {
    let s = expectOk(applyEdit(world, base, "register-asset", { id: "bg", src: "/bg.webp" }));
    s = expectOk(applyEdit(world, s, "append-show", { nodeId: "c", sprite: "slot", asset: "bg" }));
    const show = s.nodes.find((n) => n.id === "c")!.body[1]!;
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
    const res = applyEdit(world, base, "append-say", { nodeId: "c", who: "ghost", text: "x" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown character "ghost"/.test(i.message))).toBe(true);
    expect(base.nodes.find((n) => n.id === "c")!.body).toHaveLength(1);
  });

  it("set-meta start to an unknown node fails with the meta.start issue", () => {
    const res = applyEdit(world, base, "set-meta", { start: "nope" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.path === "meta.start")).toBe(true);
  });
});

describe("terminal-position invariant + insert", () => {
  it("appending after a node's end is rejected (the statement would never run)", () => {
    const res = applyEdit(world, base, "append-say", { nodeId: "b", who: "narrator", text: "after the end" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /terminal/.test(i.message))).toBe(true);
  });

  it("insert-say places a line before an existing statement (e.g. before the end)", () => {
    // normalize so the end carries its id "b#0"; insert a line before it.
    const normalized = normalizeStatementIds(base);
    const s = expectOk(applyEdit(world, normalized, "insert-say", { nodeId: "b", beforeStatementId: "b#0", who: "narrator", text: "last words" }));
    const body = s.nodes.find((n) => n.id === "b")!.body;
    expect(body.map((st) => st.op)).toEqual(["say", "end"]); // say now precedes the end
  });

  it("insert-say before a nonexistent statement id fails", () => {
    const res = applyEdit(world, normalizeStatementIds(base), "insert-say", { nodeId: "b", beforeStatementId: "nope", who: "narrator", text: "x" });
    expect(res.success).toBe(false);
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
