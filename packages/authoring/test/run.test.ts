import { describe, expect, it } from "vitest";
import { createWorld, applyEdit, hashStory, normalizeStatementIds } from "@ludelier/world";
import { validateStory, type Story } from "@ludelier/schema";
import { runAgent } from "../src/run";
import type { AgentEvent } from "../src/run";
import type { LLMProvider, ToolCall } from "../src/provider";
import type { AgentTool } from "../src/tools";

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] }],
};

/** Story whose start node self-loops with no end — a pre-existing dead end (baseline). */
const selfLoop: Story = {
  ...base,
  nodes: [
    {
      id: "a",
      body: [
        { op: "say", who: "n", text: "hi" },
        { op: "jump", goto: "a" },
      ],
    },
  ],
  meta: { id: "t", title: "T", start: "a" },
};

/** A provider that emits a fresh create-node every turn and never completes. */
function endlessEditor(): LLMProvider {
  let i = 0;
  return {
    id: "endless",
    capabilities: { jsonSchema: false, tools: true },
    async complete() {
      const id = `n${i++}`;
      return {
        text: "",
        model: "endless",
        toolCalls: [{ id: `c${i}`, name: "create-node", arguments: { id } }],
      };
    },
  };
}

type Step = ToolCall[] | { text: string };

/** A provider that emits scripted tool-call turns (or a final text turn). */
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

describe("runAgent (hermetic, scripted provider)", () => {
  it("builds a valid story branch and self-verifies", async () => {
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("add-statement", { nodeId: "b", statement: { op: "say", who: "n", text: "branch" } }, "2")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "3")],
      [call("rewire-goto", { nodeId: "a", statementId: "a#1", goto: "b" }, "4")], // a's [say, ...]; index 1 must be a jump/choice
      [call("done", {}, "5")],
    ]);
    // Give node a a jump at index 1 so rewire-goto has a target.
    const story: Story = {
      ...base,
      nodes: [
        {
          id: "a",
          body: [
            { op: "say", who: "n", text: "hi" },
            { op: "jump", goto: "a" },
          ],
        },
        { id: "z", body: [{ op: "end" }] },
      ],
      meta: { id: "t", title: "T", start: "a" },
    };
    const res = await runAgent({ provider, prompt: "add a branch", story, runId: "run-1", maxSteps: 10 });
    expect(res.ok).toBe(true);
    expect(res.verification.valid).toBe(true);
    expect(res.completed).toBe(true);
    expect(res.story.nodes.some((n) => n.id === "b")).toBe(true);
    expect(res.diff.nodes.added).toContain("b");
  });

  it("keeps the story Zod-valid at every applied step", async () => {
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("add-statement", { nodeId: "b", statement: { op: "say", who: "n", text: "x" } }, "2")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "3")],
      [call("done", {}, "4")],
    ]);
    const res = await runAgent({ provider, prompt: "x", story: base, runId: "run-1", maxSteps: 10 });
    // Re-fold each command prefix and assert validity throughout.
    const w = createWorld();
    let s = base;
    for (const rec of res.commands) {
      const applied = applyEdit(w, s, rec.command, rec.params);
      expect(applied.success).toBe(true);
      if (applied.success) {
        s = applied.data;
        expect(validateStory(s).success).toBe(true);
      }
    }
    expect(res.commands.length).toBe(3);
  });

  it("revertRun on the result restores the pre-run story", async () => {
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "2")],
      [call("done", {}, "3")],
    ]);
    const res = await runAgent({ provider, prompt: "x", story: base, runId: "run-1", maxSteps: 10 });
    const reverted = res.log.revertRun(res.runId);
    expect(reverted.success).toBe(true);
    // the log normalizes the base (assigns statement ids), so revert restores the normalized form
    if (reverted.success) expect(hashStory(reverted.data)).toBe(hashStory(normalizeStatementIds(base)));
  });

  it("stops at maxSteps with a partial, non-completed result whose records persist", async () => {
    // Never emits done; each turn makes one edit.
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("create-node", { id: "c" }, "2")],
      [call("create-node", { id: "d" }, "3")],
    ]);
    const res = await runAgent({ provider, prompt: "x", story: base, runId: "run-1", maxSteps: 2 });
    expect(res.completed).toBe(false);
    expect(res.commands.length).toBe(2); // only 2 steps ran
    expect(res.log.recordsView().length).toBe(2); // committed, not rolled back
  });

  it("feeds an invalid tool call's issues back, then recovers", async () => {
    // node a has a self-jump at index 1 so rewire-goto can wire b in.
    const story: Story = {
      ...base,
      nodes: [
        {
          id: "a",
          body: [
            { op: "say", who: "n", text: "hi" },
            { op: "jump", goto: "a" },
          ],
        },
      ],
      meta: { id: "t", title: "T", start: "a" },
    };
    const provider = scriptedTools([
      [call("create-node", { id: "bad id!" }, "1")], // rejected (invalid id)
      [call("create-node", { id: "b" }, "2")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "3")],
      [call("rewire-goto", { nodeId: "a", statementId: "a#1", goto: "b" }, "4")],
      [call("done", {}, "5")],
    ]);
    const res = await runAgent({ provider, prompt: "x", story, runId: "run-1", maxSteps: 10 });
    expect(res.ok).toBe(true);
    expect(res.completed).toBe(true);
    expect(res.story.nodes.some((n) => n.id === "b")).toBe(true);
    // a tool-result message carrying the failure was fed back
    const toolMsgs = res.transcript.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content.includes('"success":false'))).toBe(true);
  });

  it("feeds graph problems (unreachable/dead-end) back through `done`, then self-corrects", async () => {
    const story: Story = {
      ...base,
      nodes: [
        {
          id: "a",
          body: [
            { op: "say", who: "n", text: "hi" },
            { op: "jump", goto: "a" },
          ],
        },
      ],
      meta: { id: "t", title: "T", start: "a" },
    };
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "2")], // b ends, but nothing points to it yet
      [call("done", {}, "3")], // rejected: b is unreachable
      [call("rewire-goto", { nodeId: "a", statementId: "a#1", goto: "b" }, "4")], // wire a -> b
      [call("done", {}, "5")], // accepted
    ]);
    const res = await runAgent({ provider, prompt: "x", story, runId: "run-1", maxSteps: 10 });
    expect(res.completed).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.verification.unreachable).not.toContain("b");
    // the first `done` was rejected with the reachability problem fed back to the model
    const toolMsgs = res.transcript.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content.includes("unreachable"))).toBe(true);
  });

  it("blocks completion when the run leaves a graph problem unfixed", async () => {
    // base 'a' is clean; the run adds a dangling, end-less node and only ever calls done.
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")], // unreachable + dead end
      [call("done", {}, "2")],
    ]);
    const res = await runAgent({ provider, prompt: "x", story: base, runId: "run-1", maxSteps: 4 });
    expect(res.completed).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.verification.unreachable).toContain("b");
    expect(res.verification.deadEnds).toContain("b");
  });

  it("ends on a done tool before maxSteps; done is not a world task", async () => {
    const world = createWorld();
    expect(world.describe().some((t) => t.name === "done")).toBe(false);
    const provider = scriptedTools([[call("done", {}, "1")]]);
    const res = await runAgent({ provider, prompt: "x", story: base, world, runId: "run-1", maxSteps: 10 });
    expect(res.completed).toBe(true);
    expect(res.commands.length).toBe(0);
  });

  it("returns an ok-discriminant result (no internal {success} envelope leaks)", async () => {
    const provider = scriptedTools([[call("done", {}, "1")]]);
    const res = await runAgent({ provider, prompt: "x", story: base, runId: "run-1", maxSteps: 10 });
    expect("success" in res).toBe(false);
    expect(typeof res.ok).toBe("boolean");
    // verification reports plain data, not a {success} envelope
    expect("success" in res.verification).toBe(false);
  });

  it("streams progress events ending in a terminal stop", async () => {
    const events: AgentEvent[] = [];
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "2")],
      [call("rewire-goto", { nodeId: "a", statementId: "a#1", goto: "b" }, "3")],
      [call("done", {}, "4")],
    ]);
    const res = await runAgent({
      provider,
      prompt: "x",
      story: selfLoop,
      runId: "run-1",
      onEvent: (e) => events.push(e),
    });
    expect(res.stopReason).toBe("completed");
    expect(events.some((e) => e.kind === "edit" && e.command === "create-node" && e.success)).toBe(true);
    expect(events.some((e) => e.kind === "verify" && e.clean)).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "stop", reason: "completed" });
  });

  it("can be interrupted mid-run via an abort signal", async () => {
    const ac = new AbortController();
    const res = await runAgent({
      provider: endlessEditor(),
      prompt: "go forever",
      story: base,
      runId: "run-1",
      maxSteps: 50, // backstop so a broken abort can't hang the test
      signal: ac.signal,
      onEvent: (e) => {
        if (e.kind === "turn" && e.step === 3) ac.abort();
      },
    });
    expect(res.aborted).toBe(true);
    expect(res.stopReason).toBe("aborted");
    expect(res.completed).toBe(false);
    expect(res.commands.length).toBeLessThan(10);
  });

  it("pauses at a checkpoint and stops when the caller declines", async () => {
    let asked = 0;
    const res = await runAgent({
      provider: endlessEditor(),
      prompt: "go",
      story: base,
      runId: "run-1",
      checkpointEvery: 2,
      onCheckpoint: () => {
        asked++;
        return false;
      },
      maxSteps: 50,
    });
    expect(asked).toBe(1);
    expect(res.stopReason).toBe("checkpoint");
    expect(res.completed).toBe(false);
    expect(res.commands.length).toBe(2); // steps 0 and 1 ran before the step-2 checkpoint
  });

  it("does not apply edits batched after an accepted done (no completed-but-dirty result)", async () => {
    // base is already clean, so the batched `done` is accepted immediately; the trailing
    // create-node (which would leave a new unreachable dead end) must NOT be applied.
    const provider = scriptedTools([[call("done", {}, "1"), call("create-node", { id: "dangling" }, "2")]]);
    const res = await runAgent({ provider, prompt: "x", story: base, runId: "run-1", maxSteps: 5 });
    expect(res.completed).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.commands.length).toBe(0);
    expect(res.story.nodes.some((n) => n.id === "dangling")).toBe(false);
    // the skipped call still got a tool-result message so the transcript stays coherent
    const toolMsgs = res.transcript.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content.includes("not applied"))).toBe(true);
  });

  it("an interrupt during a pending checkpoint aborts the run instead of hanging it", async () => {
    const ac = new AbortController();
    const res = await runAgent({
      provider: endlessEditor(),
      prompt: "go",
      story: base,
      runId: "run-1",
      checkpointEvery: 2,
      maxSteps: 50, // backstop so a broken abort can't hang the test
      signal: ac.signal,
      // Park the run on a checkpoint promise that never resolves, then interrupt.
      onCheckpoint: () => {
        setTimeout(() => ac.abort(), 10);
        return new Promise<boolean>(() => {});
      },
    });
    expect(res.aborted).toBe(true);
    expect(res.stopReason).toBe("aborted");
    expect(res.completed).toBe(false);
  });

  it("accepts done with a non-blocking warning for a runtime-unreached node", async () => {
    // Base: start says, sets trust=0, offers one always-on choice to an ending. The run
    // adds node "secret" (with an end) and a SECOND choice option gated on trust >= 1 —
    // statically reachable, but no runtime path can enable it (trust is always 0, and it
    // IS written, so the unwritten-var check stays quiet). The gate must accept `done`
    // (nothing is broken) while warning about the unreachable-in-practice branch.
    const story: Story = {
      meta: { id: "t", title: "T", start: "a" },
      characters: [{ id: "n", name: "N" }],
      assets: [],
      nodes: [
        {
          id: "a",
          body: [
            { op: "say", who: "n", text: "hi" },
            { op: "set", var: "trust", value: 0 },
            { op: "choice", options: [{ label: "go", goto: "z" }] },
          ],
        },
        { id: "z", body: [{ op: "end" }] },
      ],
    };
    const provider = scriptedTools([
      [call("create-node", { id: "secret" }, "1")],
      [call("add-statement", { nodeId: "secret", statement: { op: "end" } }, "2")],
      [
        call(
          "add-choice-option",
          {
            nodeId: "a",
            statementId: "a#2",
            option: { label: "sneak", goto: "secret", if: { var: "trust", cmp: "gte", value: 1 } },
          },
          "3",
        ),
      ],
      [call("done", {}, "4")],
    ]);
    const res = await runAgent({ provider, prompt: "x", story, runId: "run-1", maxSteps: 10 });
    expect(res.completed).toBe(true);
    expect(res.ok).toBe(true); // warnings never block
    expect(res.verification.runtimeUnreached).toContain("secret");
    // the accepted done's tool result carried the warning to the model
    const doneMsg = res.transcript.filter((m) => m.role === "tool").at(-1);
    expect(doneMsg?.content).toContain('"ok":true');
    expect(doneMsg?.content).toContain("no play-through can currently reach");
  });
  it("suppresses runtime-unreached claims when exploration reaches its state cap", async () => {
    // The first 4,999 successors fit below explore's 5,000-state cap; the remaining statically
    // reachable endings are not evidence of a gated branch because the exploration is incomplete.
    const destinations = Array.from({ length: 5_001 }, (_, index) => `ending-${index}`);
    const story: Story = {
      meta: { id: "explore-cap", title: "Explore cap", start: "a" },
      characters: [],
      assets: [],
      nodes: [
        {
          id: "a",
          body: [{ op: "choice", options: destinations.map((goto) => ({ label: goto, goto })) }],
        },
        ...destinations.map((id) => ({ id, body: [{ op: "end" as const }] })),
      ],
    };

    const res = await runAgent({
      provider: scriptedTools([[call("done", {}, "done")]]),
      prompt: "verify the branching story",
      story,
      maxSteps: 1,
    });

    expect(res.completed).toBe(true);
    expect(res.verification.truncated).toBe(true);
    expect(res.verification.runtimeUnreached).toEqual([]);
  });

  it("continues past a checkpoint the caller approves", async () => {
    let asked = 0;
    const provider = scriptedTools([
      [call("create-node", { id: "b" }, "1")],
      [call("add-statement", { nodeId: "b", statement: { op: "end" } }, "2")],
      [call("rewire-goto", { nodeId: "a", statementId: "a#1", goto: "b" }, "3")],
      [call("done", {}, "4")],
    ]);
    const res = await runAgent({
      provider,
      prompt: "x",
      story: selfLoop,
      runId: "run-1",
      checkpointEvery: 2,
      onCheckpoint: () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(1); // checkpoint at step 2, approved → run continues to completion
    expect(res.stopReason).toBe("completed");
    expect(res.completed).toBe(true);
  });
  it("dispatches an async host tool, advertises it, and emits compact progress", async () => {
    const events: AgentEvent[] = [];
    const offered: string[][] = [];
    let turn = 0;
    let seenRunId: string | undefined;
    let seenStoryTitle: string | undefined;
    const hostTool: AgentTool = {
      definition: {
        name: "host-generate-preview",
        description: "Generate a private preview.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      effects: ["paid-network", "filesystem"],
      async handler(context) {
        await Promise.resolve();
        seenRunId = context.runId;
        seenStoryTitle = context.story.meta.title;
        return { success: true, data: { assetId: "preview-1", status: "ready" } };
      },
    };
    const provider: LLMProvider = {
      id: "mock",
      capabilities: { jsonSchema: true, tools: true },
      async complete(request) {
        offered.push((request.tools ?? []).map((tool) => tool.name));
        return {
          text: "",
          model: "mock",
          toolCalls:
            turn++ === 0 ? [call(hostTool.definition.name, {}, "host-1")] : [call("done", {}, "done-1")],
        };
      },
    };

    const res = await runAgent({
      provider,
      prompt: "make a preview",
      story: base,
      runId: "host-run",
      tools: [hostTool],
      onEvent: (event) => events.push(event),
    });

    expect(res.completed).toBe(true);
    expect(seenRunId).toBe("host-run");
    expect(seenStoryTitle).toBe("T");
    expect(offered[0]).toContain(hostTool.definition.name);
    expect(events).toContainEqual({
      kind: "host-tool",
      name: hostTool.definition.name,
      effects: ["paid-network", "filesystem"],
      success: true,
    });
    expect(res.transcript.find((message) => message.toolCallId === "host-1")?.content).toBe(
      JSON.stringify({ success: true, data: { assetId: "preview-1", status: "ready" } }),
    );
  });

  it("converts rejected host handlers into a redacted failure and continues the run", async () => {
    const secret = "host-rejection-secret-never-expose";
    const events: AgentEvent[] = [];
    const hostTool: AgentTool = {
      definition: {
        name: "host-rejects",
        description: "A host tool whose provider call rejects.",
        parameters: { type: "object", additionalProperties: false },
      },
      effects: ["paid-network"],
      async handler() {
        throw new Error(`provider rejected with ${secret}`);
      },
    };

    const res = await runAgent({
      provider: scriptedTools([[call("host-rejects", {}, "rejected")], [call("done", {}, "done")]]),
      prompt: "continue after host failure",
      story: base,
      tools: [hostTool],
      onEvent: (event) => events.push(event),
    });

    expect(res.completed).toBe(true);
    expect(res.commands).toEqual([]);
    expect(events).toContainEqual({
      kind: "host-tool",
      name: "host-rejects",
      effects: ["paid-network"],
      success: false,
    });
    expect(res.transcript.find((message) => message.toolCallId === "rejected")?.content).toBe(
      JSON.stringify({
        success: false,
        issues: [{ path: "host", message: 'host tool "host-rejects" failed' }],
      }),
    );
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it("rejects host tool names colliding with world tasks, done, or each other before provider use", async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "mock",
      capabilities: { jsonSchema: true, tools: true },
      async complete() {
        providerCalls++;
        return { text: "", model: "mock", toolCalls: [call("done", {}, "done")] };
      },
    };
    const hostTool = (name: string): AgentTool => ({
      definition: { name, description: "host test tool", parameters: { type: "object" } },
      effects: ["read"],
      async handler() {
        return { success: true, data: null };
      },
    });
    const run = (tools: AgentTool[]) => runAgent({ provider, prompt: "x", story: base, tools });

    await expect(run([hostTool("graph")])).rejects.toThrow('host tool "graph" conflicts with world task');
    await expect(run([hostTool("done")])).rejects.toThrow(
      'host tool "done" conflicts with the reserved done tool',
    );
    await expect(run([hostTool("host-duplicate"), hostTool("host-duplicate")])).rejects.toThrow(
      'duplicate host tool "host-duplicate"',
    );
    expect(providerCalls).toBe(0);
  });

  it("feeds host failures and approval-required results back without changing the story", async () => {
    const hostTool: AgentTool = {
      definition: {
        name: "host-generate-preview",
        description: "Generate a preview after host approval.",
        parameters: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
      },
      effects: ["paid-network"],
      async handler({ call: toolCall }) {
        const { request } = toolCall.arguments as { request: string };
        return {
          success: false,
          issues: [
            {
              path: request === "approved" ? "authorization" : "provider",
              message: request === "approved" ? "approval required" : "preview generation failed",
            },
          ],
        };
      },
    };
    const res = await runAgent({
      provider: scriptedTools([
        [call(hostTool.definition.name, { request: "fail" }, "failure")],
        [call(hostTool.definition.name, { request: "approved" }, "approval")],
        [call("done", {}, "done")],
      ]),
      prompt: "generate a preview",
      story: base,
      runId: "host-run",
      tools: [hostTool],
    });

    expect(res.completed).toBe(true);
    expect(res.commands).toEqual([]);
    expect(hashStory(res.story)).toBe(hashStory(normalizeStatementIds(base)));
    const results = res.transcript
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(results.some((content) => content.includes("preview generation failed"))).toBe(true);
    expect(results.some((content) => content.includes("approval required"))).toBe(true);
  });
});
