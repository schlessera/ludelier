import { describe, expect, it } from "vitest";
import type { Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import { applyEdit } from "../src/applyEdit";
import { normalizeStatementIds } from "../src/statement-id";
import type { Result } from "../src/result";

const world = createWorld();

// Normalized so the choice carries its stable id "a#1" (the say is "a#0").
const base: Story = normalizeStatementIds({
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "narrator", name: "Narrator" }],
  assets: [],
  nodes: [
    {
      id: "a",
      body: [
        { op: "say", who: "narrator", text: "hi" },
        {
          op: "choice",
          prompt: "Where to?",
          options: [
            { label: "To b", goto: "b" },
            { label: "To c", goto: "c" },
          ],
        },
      ],
    },
    { id: "b", body: [{ op: "end" }] },
    { id: "c", body: [{ op: "end" }] },
  ],
});

function expectOk(res: Result<Story>): Story {
  if (!res.success) throw new Error("expected ok, got issues: " + JSON.stringify(res.issues));
  return res.data;
}

function choiceOf(s: Story) {
  const stmt = s.nodes.find((n) => n.id === "a")!.body[1]!;
  if (stmt.op !== "choice") throw new Error(`expected a choice, got ${stmt.op}`);
  return stmt;
}

describe("add-choice-option", () => {
  it("appends an option, keeping the statement's id and the others intact", () => {
    const s = expectOk(
      applyEdit(world, base, "add-choice-option", {
        nodeId: "a",
        statementId: "a#1",
        option: { label: "Stay", goto: "a" },
      }),
    );
    const choice = choiceOf(s);
    expect(choice.id).toBe("a#1");
    expect(choice.options.map((o) => o.label)).toEqual(["To b", "To c", "Stay"]);
  });

  it("inserts at beforeIndex, shifting the existing option right", () => {
    const s = expectOk(
      applyEdit(world, base, "add-choice-option", {
        nodeId: "a",
        statementId: "a#1",
        option: { label: "First now", goto: "b" },
        beforeIndex: 0,
      }),
    );
    expect(choiceOf(s).options.map((o) => o.label)).toEqual(["First now", "To b", "To c"]);
  });

  it("accepts beforeIndex === options.length as an explicit append", () => {
    const s = expectOk(
      applyEdit(world, base, "add-choice-option", {
        nodeId: "a",
        statementId: "a#1",
        option: { label: "Last", goto: "b" },
        beforeIndex: 2,
      }),
    );
    expect(choiceOf(s).options.map((o) => o.label)).toEqual(["To b", "To c", "Last"]);
  });

  it("keeps a conditional option's `if` intact through the edit", () => {
    const s = expectOk(
      applyEdit(world, base, "add-choice-option", {
        nodeId: "a",
        statementId: "a#1",
        option: { label: "Secret", goto: "c", if: { var: "trust", cmp: "gte", value: 2 } },
      }),
    );
    expect(choiceOf(s).options[2]).toEqual({
      label: "Secret",
      goto: "c",
      if: { var: "trust", cmp: "gte", value: 2 },
    });
  });

  it("rejects beforeIndex past the end", () => {
    const res = applyEdit(world, base, "add-choice-option", {
      nodeId: "a",
      statementId: "a#1",
      option: { label: "x", goto: "b" },
      beforeIndex: 3,
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /out of range/.test(i.message))).toBe(true);
  });

  it("an option goto to an unknown node is rejected by the always-valid re-validation", () => {
    const res = applyEdit(world, base, "add-choice-option", {
      nodeId: "a",
      statementId: "a#1",
      option: { label: "Nowhere", goto: "ghost" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown node "ghost"/.test(i.message))).toBe(true);
    // original story untouched — the failed edit never leaks
    expect(choiceOf(base).options).toHaveLength(2);
  });
});

describe("update-choice-option", () => {
  it("replaces one option in place, leaving the others untouched", () => {
    const s = expectOk(
      applyEdit(world, base, "update-choice-option", {
        nodeId: "a",
        statementId: "a#1",
        index: 1,
        option: { label: "To c, gated", goto: "c", if: { var: "coins", cmp: "gt", value: 0 } },
      }),
    );
    const choice = choiceOf(s);
    expect(choice.options[0]).toEqual({ label: "To b", goto: "b" });
    expect(choice.options[1]).toEqual({
      label: "To c, gated",
      goto: "c",
      if: { var: "coins", cmp: "gt", value: 0 },
    });
  });

  it("rejects an out-of-range index", () => {
    const res = applyEdit(world, base, "update-choice-option", {
      nodeId: "a",
      statementId: "a#1",
      index: 2,
      option: { label: "x", goto: "b" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /out of range/.test(i.message))).toBe(true);
  });

  it("rejects a replacement whose goto does not resolve (cross-ref via re-validate)", () => {
    const res = applyEdit(world, base, "update-choice-option", {
      nodeId: "a",
      statementId: "a#1",
      index: 0,
      option: { label: "To nowhere", goto: "ghost" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown node "ghost"/.test(i.message))).toBe(true);
  });
});

describe("remove-choice-option", () => {
  it("removes exactly the indexed option", () => {
    const s = expectOk(
      applyEdit(world, base, "remove-choice-option", { nodeId: "a", statementId: "a#1", index: 0 }),
    );
    expect(choiceOf(s).options.map((o) => o.label)).toEqual(["To c"]);
  });

  it("refuses to remove the LAST remaining option (an option-less choice strands the player)", () => {
    const one = expectOk(
      applyEdit(world, base, "remove-choice-option", { nodeId: "a", statementId: "a#1", index: 1 }),
    );
    const res = applyEdit(world, one, "remove-choice-option", { nodeId: "a", statementId: "a#1", index: 0 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.issues.some((i) => /last option/.test(i.message) && /stuck/.test(i.message))).toBe(true);
    }
    // the one-option story is untouched
    expect(choiceOf(one).options).toHaveLength(1);
  });

  it("rejects an out-of-range index", () => {
    const res = applyEdit(world, base, "remove-choice-option", { nodeId: "a", statementId: "a#1", index: 5 });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /out of range/.test(i.message))).toBe(true);
  });
});

describe("targeting failures (shared findChoice guard)", () => {
  it("fails when the statement is not a choice", () => {
    const res = applyEdit(world, base, "update-choice-option", {
      nodeId: "a",
      statementId: "a#0",
      index: 0,
      option: { label: "x", goto: "b" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /is a say, not a choice/.test(i.message))).toBe(true);
  });

  it("fails when the statement id does not exist in the node", () => {
    const res = applyEdit(world, base, "add-choice-option", {
      nodeId: "a",
      statementId: "nope",
      option: { label: "x", goto: "b" },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /no statement "nope"/.test(i.message))).toBe(true);
  });

  it("fails when the node does not exist", () => {
    const res = applyEdit(world, base, "remove-choice-option", {
      nodeId: "zzz",
      statementId: "a#1",
      index: 0,
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => /unknown node "zzz"/.test(i.message))).toBe(true);
  });

  it("rejects invalid params (negative index) before apply", () => {
    const res = applyEdit(world, base, "remove-choice-option", {
      nodeId: "a",
      statementId: "a#1",
      index: -1,
    });
    expect(res.success).toBe(false);
  });
});

describe("describe() exposure — CLI / LLM tools / MCP / editor forms gain the ops for free", () => {
  it("the manifest carries all three tasks as manipulate, with schemas", () => {
    const manifest = world.describe();
    // 21 tasks before this change; the three choice-option ops make 24.
    expect(manifest).toHaveLength(24);
    for (const name of ["add-choice-option", "update-choice-option", "remove-choice-option"]) {
      const entry = manifest.find((t) => t.name === name);
      expect(entry, name).toBeDefined();
      expect(entry!.kind).toBe("manipulate");
      expect(entry!.schema).toBeTruthy();
    }
  });
});
