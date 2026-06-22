import { describe, expect, it } from "vitest";
import { validateStory, type Story } from "@ludelier/schema";
import { exploreStory } from "../src/explore";

function build(story: unknown): Story {
  const res = validateStory(story);
  if (!res.success) throw new Error("fixture invalid: " + JSON.stringify(res.issues));
  return res.data;
}

describe("exploreStory", () => {
  it("reaches both branches of a choice and finds the ending", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      characters: [{ id: "n", name: "N" }],
      nodes: [
        {
          id: "a",
          body: [
            { op: "say", who: "n", text: "pick" },
            { op: "choice", options: [{ label: "L", goto: "good" }, { label: "R", goto: "bad" }] },
          ],
        },
        { id: "good", body: [{ op: "say", who: "n", text: "g" }, { op: "end" }] },
        { id: "bad", body: [{ op: "say", who: "n", text: "b" }, { op: "end" }] },
      ],
    });
    const r = exploreStory(story);
    expect(r.reached).toEqual(["a", "bad", "good"]);
    expect(r.endReachable).toBe(true);
    expect(r.stuck).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("does NOT reach a node gated behind an always-false condition", () => {
    // `locked` requires flag gte 1, but flag is never set — runtime never takes that option.
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      characters: [{ id: "n", name: "N" }],
      nodes: [
        {
          id: "a",
          body: [
            { op: "choice", options: [
              { label: "open", goto: "locked", if: { var: "flag", cmp: "gte", value: 1 } },
              { label: "leave", goto: "out" },
            ] },
          ],
        },
        { id: "locked", body: [{ op: "say", who: "n", text: "secret" }, { op: "end" }] },
        { id: "out", body: [{ op: "end" }] },
      ],
    });
    const r = exploreStory(story);
    expect(r.reached).toContain("out");
    expect(r.reached).not.toContain("locked");
  });

  it("flags a node whose every choice option is gated off as stuck", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        {
          id: "a",
          body: [
            { op: "choice", options: [{ label: "x", goto: "b", if: { var: "f", cmp: "eq", value: 1 } }] },
          ],
        },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    const r = exploreStory(story);
    expect(r.stuck).toContain("a");
    expect(r.endReachable).toBe(false);
  });

  it("reports crashed (not throws) on a pure jump cycle", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [{ op: "jump", goto: "b" }] },
        { id: "b", body: [{ op: "jump", goto: "a" }] },
      ],
    });
    const r = exploreStory(story);
    expect(r.crashed).toBe(true);
    expect(r.endReachable).toBe(false);
    expect(exploreStory(story)).toEqual(r); // deterministic
  });

  it("terminates (via state dedup) on a choice loop that has an exit", () => {
    const story = build({
      meta: { id: "x", title: "x", start: "a" },
      characters: [{ id: "n", name: "N" }],
      nodes: [
        {
          id: "a",
          body: [
            { op: "say", who: "n", text: "again?" },
            { op: "choice", options: [{ label: "loop", goto: "a" }, { label: "exit", goto: "b" }] },
          ],
        },
        { id: "b", body: [{ op: "end" }] },
      ],
    });
    const r = exploreStory(story);
    expect(r.crashed).toBe(false);
    expect(r.endReachable).toBe(true);
    expect(r.reached).toEqual(["a", "b"]);
  });
});
