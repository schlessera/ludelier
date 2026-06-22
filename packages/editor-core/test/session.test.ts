import { describe, expect, it } from "vitest";
import { EditorSession } from "../src/index";
import type { Story } from "@ludelier/schema";
import type { LLMProvider, ToolCall } from "@ludelier/authoring";

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] }],
};

type Step = ToolCall[] | { text: string };

/** A provider that emits scripted tool-call turns (hermetic — no network). */
function scriptedTools(steps: Step[]): LLMProvider {
  let i = 0;
  return {
    id: "mock",
    capabilities: { jsonSchema: true, tools: true },
    async complete() {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      if (Array.isArray(step)) return { text: "", model: "mock", toolCalls: step };
      return { text: step.text, model: "mock" };
    },
  };
}

function call(name: string, args: unknown, id = "c"): ToolCall {
  return { id, name, arguments: args };
}

describe("EditorSession", () => {
  it("rejects an invalid initial story", () => {
    expect(() => new EditorSession({ ...base, meta: { ...base.meta, start: "nope" } })).toThrow();
  });

  it("queries understand tasks; rejects manipulate tasks via query()", () => {
    const s = new EditorSession(base);
    expect(s.query("graph").success).toBe(true);
    expect(s.query("create-node", { id: "x" }).success).toBe(false);
    expect(s.query("nosuchtask").success).toBe(false);
  });

  it("applies a manipulate edit through the log", () => {
    const s = new EditorSession(base);
    expect(s.edit("create-node", { id: "b" }).success).toBe(true);
    expect(s.story.nodes.some((n) => n.id === "b")).toBe(true);
  });

  it("rejects an invalid edit without mutating the story or log", () => {
    const s = new EditorSession(base);
    const before = s.story.nodes.length;
    expect(s.edit("create-node", { id: "bad id!" }).success).toBe(false);
    expect(s.story.nodes.length).toBe(before);
    expect(s.canUndo).toBe(false);
  });

  it("rejects an understand task via edit()", () => {
    expect(new EditorSession(base).edit("graph").success).toBe(false);
  });

  it("undo/redo move through history and toggle canUndo/canRedo", () => {
    const s = new EditorSession(base);
    s.edit("create-node", { id: "b" });
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    s.undo();
    expect(s.story.nodes.some((n) => n.id === "b")).toBe(false);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
    s.redo();
    expect(s.story.nodes.some((n) => n.id === "b")).toBe(true);
  });

  it("notifies subscribers on change; unsubscribe stops them", () => {
    const s = new EditorSession(base);
    let n = 0;
    const off = s.subscribe(() => n++);
    s.edit("create-node", { id: "b" });
    s.undo();
    expect(n).toBe(2);
    off();
    s.redo();
    expect(n).toBe(2);
  });

  it("round-trips through exportLog / fromLog", () => {
    const s = new EditorSession(base);
    s.edit("create-node", { id: "b" });
    s.edit("append-end", { nodeId: "b" });
    const restored = EditorSession.fromLog(base, s.exportLog());
    expect(restored.success).toBe(true);
    if (restored.success) {
      expect(restored.data.story.nodes.some((nn) => nn.id === "b")).toBe(true);
      expect(restored.data.records()).toHaveLength(2);
    }
  });

  it("snapshot reports validity, undo state, and graph health", () => {
    const s = new EditorSession(base);
    const snap = s.snapshot();
    expect(snap.valid).toBe(true);
    expect(snap.canUndo).toBe(false);
    expect(snap.graph.reachable).toContain("a");
  });

  it("runs an agent chat on the session log; edits join history and are revertable", async () => {
    // 'a' is a pre-existing dead end (self-loop, no end) → baseline, won't block the gate.
    const s = new EditorSession({
      ...base,
      nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "jump", goto: "a" }] }],
    });
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("append-end", { nodeId: "b" }, "2")],
      [call("rewire-goto", { nodeId: "a", statementId: "a#1", goto: "b" }, "3")], // wire a -> b (reachable + ends)
      [call("done", {}, "4")],
    ]);
    const res = await s.chat("add an ending", { provider, runId: "chat-1" });
    expect(res.completed).toBe(true);
    expect(res.ok).toBe(true);
    expect(s.story.nodes.some((n) => n.id === "b")).toBe(true);
    // the whole chat turn is one run in the session history → revert it cleanly
    expect(s.revertRun("chat-1").success).toBe(true);
    expect(s.story.nodes.some((n) => n.id === "b")).toBe(false);
  });
});
