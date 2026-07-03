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
    {
      id: "a",
      body: [
        { op: "say", who: "narrator", text: "hi" },
        { op: "jump", goto: "b" },
      ],
    },
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
  it("create-node + add-statement (say, end) yields a story validateStory accepts", () => {
    let s = expectOk(applyEdit(world, base, "create-node", { id: "d" }));
    s = expectOk(
      applyEdit(world, s, "add-statement", {
        nodeId: "d",
        statement: { op: "say", who: "narrator", text: "yo" },
      }),
    );
    s = expectOk(applyEdit(world, s, "add-statement", { nodeId: "d", statement: { op: "end" } }));
    const node = s.nodes.find((n) => n.id === "d")!;
    expect(node.body.map((st) => st.op)).toEqual(["say", "end"]);
  });

  it("rewire-goto repoints a choice option and re-validates", () => {
    // add a choice to non-terminal node c → c = [say, choice]; the choice's fallback id is "c#g1".
    let s = expectOk(
      applyEdit(world, base, "add-statement", {
        nodeId: "c",
        statement: { op: "choice", options: [{ label: "go", goto: "a" }] },
      }),
    );
    s = expectOk(
      applyEdit(world, s, "rewire-goto", { nodeId: "c", statementId: "c#g1", goto: "b", optionIndex: 0 }),
    );
    const choice = s.nodes.find((n) => n.id === "c")!.body[1]!;
    expect(choice.op === "choice" && choice.options[0]!.goto).toBe("b");
  });

  it("register-asset then add-statement show referencing it passes", () => {
    let s = expectOk(applyEdit(world, base, "register-asset", { id: "bg", src: "/bg.webp" }));
    s = expectOk(
      applyEdit(world, s, "add-statement", {
        nodeId: "c",
        statement: { op: "show", sprite: "slot", asset: "bg" },
      }),
    );
    const show = s.nodes.find((n) => n.id === "c")!.body[1]!;
    expect(show.op === "show" && show.at).toBe("center");
  });
});

describe("generic statement ops (add / update / move / remove)", () => {
  it("add-statement fills any statement kind from the discriminated union", () => {
    let s = expectOk(
      applyEdit(world, base, "add-statement", {
        nodeId: "c",
        statement: { op: "set", var: "score", value: 1 },
      }),
    );
    s = expectOk(
      applyEdit(world, s, "add-statement", {
        nodeId: "c",
        statement: { op: "roll", var: "d6", min: 1, max: 6 },
      }),
    );
    expect(s.nodes.find((n) => n.id === "c")!.body.map((st) => st.op)).toEqual(["say", "set", "roll"]);
  });

  it("update-statement replaces a statement in place, keeping its id", () => {
    const normalized = normalizeStatementIds(base);
    const s = expectOk(
      applyEdit(world, normalized, "update-statement", {
        nodeId: "c",
        statementId: "c#0",
        statement: { op: "say", who: "narrator", text: "rewritten" },
      }),
    );
    const stmt = s.nodes.find((n) => n.id === "c")!.body[0]!;
    expect(stmt.op === "say" && stmt.text).toBe("rewritten");
    expect(stmt.id).toBe("c#0");
  });

  it("move-statement reorders a statement to before another", () => {
    // c = [say c#0]; add a say, then move it before c#0.
    let s = expectOk(
      applyEdit(world, normalizeStatementIds(base), "add-statement", {
        nodeId: "c",
        statement: { op: "say", who: "narrator", text: "second" },
      }),
    );
    const added = s.nodes.find((n) => n.id === "c")!.body[1]!.id!;
    s = expectOk(applyEdit(world, s, "move-statement", { nodeId: "c", statementId: added, before: "c#0" }));
    const texts = s.nodes.find((n) => n.id === "c")!.body.map((st) => (st.op === "say" ? st.text : st.op));
    expect(texts).toEqual(["second", "c"]);
  });
});

describe("applyEdit — always-valid invariant rejects bad edits, story untouched", () => {
  it("delete-node still referenced by a goto fails with a cross-ref issue", () => {
    const res = applyEdit(world, base, "delete-node", { id: "b" });
    expect(res.success).toBe(false);
    // original story still has node b
    expect(base.nodes.some((n) => n.id === "b")).toBe(true);
  });

  it("add-statement show referencing an unregistered asset fails", () => {
    const res = applyEdit(world, base, "add-statement", {
      nodeId: "c",
      statement: { op: "show", sprite: "slot", asset: "ghost" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown asset/.test(i.message))).toBe(true);
  });

  it("add-statement say with an unknown who fails the say.who check; story untouched", () => {
    const res = applyEdit(world, base, "add-statement", {
      nodeId: "c",
      statement: { op: "say", who: "ghost", text: "x" },
    });
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
  it("adding after a node's end is rejected (the statement would never run)", () => {
    const res = applyEdit(world, base, "add-statement", {
      nodeId: "b",
      statement: { op: "say", who: "narrator", text: "after the end" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /terminal/.test(i.message))).toBe(true);
  });

  it("add-statement with `before` places a line before an existing statement (e.g. before the end)", () => {
    // normalize so the end carries its id "b#0"; insert a line before it.
    const normalized = normalizeStatementIds(base);
    const s = expectOk(
      applyEdit(world, normalized, "add-statement", {
        nodeId: "b",
        before: "b#0",
        statement: { op: "say", who: "narrator", text: "last words" },
      }),
    );
    const body = s.nodes.find((n) => n.id === "b")!.body;
    expect(body.map((st) => st.op)).toEqual(["say", "end"]); // say now precedes the end
  });

  it("add-statement before a nonexistent statement id fails", () => {
    const res = applyEdit(world, normalizeStatementIds(base), "add-statement", {
      nodeId: "b",
      before: "nope",
      statement: { op: "say", who: "narrator", text: "x" },
    });
    expect(res.success).toBe(false);
  });
});

describe("applyEdit — invalid params rejected before apply", () => {
  it("create-node with a non-slug id is rejected", () => {
    expect(applyEdit(world, base, "create-node", { id: "bad id!" }).success).toBe(false);
  });

  it("add-statement with a malformed statement is rejected", () => {
    expect(
      applyEdit(world, base, "add-statement", { nodeId: "c", statement: { op: "say", who: "narrator" } })
        .success,
    ).toBe(false);
  });

  it("unknown command name is rejected", () => {
    expect(applyEdit(world, base, "frobnicate", {}).success).toBe(false);
  });
});
