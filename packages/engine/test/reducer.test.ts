import { describe, expect, it } from "vitest";
import { validateStory, type Story } from "@ludelier/schema";
import { initialState, reducer, StatementBudgetError } from "../src/reducer";
import { Simulation } from "../src/simulation";
import type { Action } from "../src/state";
import { loadCafe } from "./fixture";

const story = loadCafe();

function build(s: unknown): Story {
  const res = validateStory(s);
  if (!res.success) throw new Error("fixture invalid: " + JSON.stringify(res.issues));
  return res.data;
}

/** Build a single-node story whose only choice option is gated by `cond`, then report enabled. */
function optionEnabled(cond: unknown, setup: unknown[] = []): boolean {
  const st = build({
    meta: { id: "g", title: "g", start: "a", seed: 1 },
    nodes: [
      { id: "a", body: [...setup, { op: "choice", options: [{ label: "x", goto: "b", if: cond }] }] },
      { id: "b", body: [{ op: "end" }] },
    ],
  });
  const s = initialState(st, 1);
  return s.pending.kind === "choice" && (s.pending.options[0]?.enabled ?? false);
}

describe("reducer", () => {
  it("starts on the first say line", () => {
    const s = initialState(story, 42);
    expect(s.pending).toEqual({ kind: "say", who: "narrator", text: "A quiet café. She looks up as you enter." });
    expect(s.done).toBe(false);
  });

  it("advances through set/choice and reaches a choice", () => {
    let s = initialState(story, 42);
    s = reducer(story, s, { type: "ADVANCE" }); // dismiss narrator say -> set trust -> choice
    expect(s.pending.kind).toBe("choice");
    expect(s.vars.trust).toBe(0);
  });

  it("ADVANCE is a no-op while a choice is pending", () => {
    let s = initialState(story, 42);
    s = reducer(story, s, { type: "ADVANCE" });
    const before = s;
    s = reducer(story, s, { type: "ADVANCE" });
    expect(s).toBe(before);
  });

  it("gates a conditional choice option (trust >= 1)", () => {
    let s = initialState(story, 42);
    s = reducer(story, s, { type: "ADVANCE" }); // -> first choice (Sit/Leave)
    s = reducer(story, s, { type: "CHOOSE", index: 0 }); // Sit -> say -> ...
    s = reducer(story, s, { type: "ADVANCE" }); // dismiss "Mind if I join?" -> add trust -> roll -> choice
    if (s.pending.kind !== "choice") throw new Error("expected choice");
    // "Stay" requires trust >= 1; after add it is 1 -> enabled.
    expect(s.pending.options[0]!.enabled).toBe(true);
  });

  it("blocks CHOOSE on a disabled option", () => {
    // Hand-built story: option requires trust >= 1 but trust is never set.
    const gated = {
      meta: { id: "g", title: "g", start: "a", seed: 1 },
      characters: [],
      nodes: [
        {
          id: "a",
          body: [
            { op: "choice", options: [{ label: "locked", goto: "b", if: { var: "trust", cmp: "gte", value: 1 } }, { label: "open", goto: "b" }] },
          ],
        },
        { id: "b", body: [{ op: "end" }] },
      ],
    } as unknown as typeof story;
    let s = initialState(gated, 1);
    const before = s;
    s = reducer(gated, s, { type: "CHOOSE", index: 0 }); // disabled
    expect(s).toBe(before);
  });
});

describe("seeded RNG determinism", () => {
  function runToRoll(seed: number) {
    let s = initialState(story, seed);
    const actions: Action[] = [{ type: "ADVANCE" }, { type: "CHOOSE", index: 0 }, { type: "ADVANCE" }];
    for (const a of actions) s = reducer(story, s, a);
    return s.vars.luck as number;
  }

  it("produces the same roll for the same seed", () => {
    expect(runToRoll(42)).toBe(runToRoll(42));
  });

  it("keeps rolls within declared bounds [1,6]", () => {
    for (const seed of [1, 2, 7, 42, 999]) {
      const luck = runToRoll(seed);
      expect(luck).toBeGreaterThanOrEqual(1);
      expect(luck).toBeLessThanOrEqual(6);
    }
  });
});

describe("compare (no silent coercion)", () => {
  it("eq/ne are strict on type", () => {
    expect(optionEnabled({ var: "n", cmp: "eq", value: 5 }, [{ op: "set", var: "n", value: 5 }])).toBe(true);
    expect(optionEnabled({ var: "n", cmp: "eq", value: 5 }, [{ op: "set", var: "n", value: "5" }])).toBe(false);
  });

  it("ordered ops compare numbers", () => {
    expect(optionEnabled({ var: "n", cmp: "gte", value: 1 }, [{ op: "set", var: "n", value: 2 }])).toBe(true);
    expect(optionEnabled({ var: "n", cmp: "lt", value: 1 }, [{ op: "set", var: "n", value: 0 }])).toBe(true);
  });

  it("ordered ops are false (not coerced) when an operand is not a number", () => {
    // unset var
    expect(optionEnabled({ var: "missing", cmp: "gt", value: 1 })).toBe(false);
    // string var vs number — no NaN/lexical coercion
    expect(optionEnabled({ var: "n", cmp: "gt", value: 1 }, [{ op: "set", var: "n", value: "9" }])).toBe(false);
    // string vs string — ordered ops do NOT do lexical ordering
    expect(optionEnabled({ var: "n", cmp: "gt", value: "a" }, [{ op: "set", var: "n", value: "b" }])).toBe(false);
  });
});

describe("branch (conditional jump)", () => {
  function story(flag: number): Story {
    return build({
      meta: { id: "x", title: "x", start: "a", seed: 1 },
      characters: [{ id: "n", name: "N" }],
      nodes: [
        {
          id: "a",
          body: [
            { op: "set", var: "flag", value: flag },
            { op: "branch", cond: { var: "flag", cmp: "eq", value: 1 }, goto: "b" },
            { op: "say", who: "n", text: "fell through" },
            { op: "end" },
          ],
        },
        { id: "b", body: [{ op: "say", who: "n", text: "branched" }, { op: "end" }] },
      ],
    });
  }

  it("takes the goto when the condition holds", () => {
    const s = initialState(story(1), 1);
    expect(s.pending).toMatchObject({ kind: "say", text: "branched" });
  });

  it("falls through to the next statement when the condition is false", () => {
    const s = initialState(story(0), 1);
    expect(s.pending).toMatchObject({ kind: "say", text: "fell through" });
  });
});

describe("StatementBudgetError", () => {
  it("is thrown on an infinite jump loop", () => {
    const loop = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [{ op: "jump", goto: "b" }] },
        { id: "b", body: [{ op: "jump", goto: "a" }] },
      ],
    });
    expect(() => new Simulation(loop, { seed: 1 })).toThrow(StatementBudgetError);
  });
});
