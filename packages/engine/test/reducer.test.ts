import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../src/reducer";
import type { Action } from "../src/state";
import { loadCafe } from "./fixture";

const story = loadCafe();

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
