import {
  createWorld,
  EditLog,
  diffStories,
  type Registry,
  type EditRecord,
  type StoryDiff,
  type GraphReport,
} from "@ludelier/world";
import type { Issue, Story } from "@ludelier/schema";
import type { ChatMessage, LLMProvider, ToolCall, ToolDefinition } from "./provider";
import { worldTools, dispatch } from "./tools";

export interface RunAgentOptions {
  provider: LLMProvider;
  /** Natural-language description of the editing task. */
  prompt: string;
  /** The base story the run edits. */
  story: Story;
  /** A world registry; defaults to a fresh `createWorld()`. */
  world?: Registry;
  /**
   * An existing edit log to append this run onto (e.g. an editor session's history) so the
   * run's records join that history and stay undoable. Defaults to a fresh log over `story`.
   * When supplied, the run is measured against the log's *current* story, not `story`.
   */
  log?: EditLog;
  /** Hard cap on provider turns before the loop stops (partial result). */
  maxSteps?: number;
  /** Caller-supplied run id; defaults to a generated one. Uniqueness is the caller's responsibility. */
  runId?: string;
  model?: string;
  temperature?: number;
  system?: string;
}

/** Self-verification report — plain data (no `{success}` envelope leaks across the boundary). */
export interface Verification {
  valid: boolean;
  issues: Issue[];
  unreachable: string[];
  deadEnds: string[];
  simulate: { hash: string; reached: string[] } | null;
}

/**
 * The reviewable run result. `ok` mirrors `AuthorResult`'s discriminant (the single
 * `success → ok` conversion point, KTD-5) and now means **clean**: Zod-valid *and* the
 * run introduced no new unreachable / dead-end nodes (graph health, not just validity).
 * The `log` is returned so the caller can keep the run or `revertRun(runId)` it;
 * `completed` distinguishes a run the agent verified clean from a `maxSteps`-truncated or
 * still-broken partial one (whose records remain committed — KTD-11).
 */
export interface AgentRunResult {
  ok: boolean;
  story: Story;
  runId: string;
  commands: EditRecord[];
  diff: StoryDiff;
  verification: Verification;
  transcript: ChatMessage[];
  completed: boolean;
  log: EditLog;
}

/**
 * The self-correction gate. The agent's own graph self-verification (validate + graph) is
 * fed back into the loop: a run is "clean" only when it is Zod-valid and introduced no
 * **new** unreachable or dead-end nodes vs the pre-run baseline. Comparing against a
 * baseline (not absolute graph health) keeps the agent focused on its own edits — it is
 * never asked to fix problems that already existed in the story it was handed.
 */
interface Gate {
  clean: boolean;
  problems: string[];
}

function describeGate(baseline: Verification, current: Verification): Gate {
  const newUnreachable = current.unreachable.filter((id) => !baseline.unreachable.includes(id));
  const newDeadEnds = current.deadEnds.filter((id) => !baseline.deadEnds.includes(id));
  const problems: string[] = [];
  for (const i of current.issues) problems.push(`invalid: ${i.path ? `${i.path} — ` : ""}${i.message}`);
  for (const id of newUnreachable) {
    problems.push(
      `node "${id}" is unreachable from the start node — wire it in with rewire-goto, or add a choice/jump that targets it.`,
    );
  }
  for (const id of newDeadEnds) {
    problems.push(
      `node "${id}" is a dead end (it cannot reach an end statement) — append an end, or a jump toward a node that ends.`,
    );
  }
  return { clean: current.valid && problems.length === 0, problems };
}

/** Loop-control tool — injected into the toolset but NOT a world task (absent from describe()). */
const DONE_TOOL: ToolDefinition = {
  name: "done",
  description: "Signal that the editing task is complete.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

function agentSystemPrompt(world: Registry): string {
  const names = world.describe().map((t) => `${t.name} (${t.kind})`).join(", ");
  return [
    "You are an editing agent for the Ludelier visual-novel engine.",
    "Use the provided tools to inspect and edit the story. Every edit is validated;",
    "if a tool returns an error, read the issues and correct your next call.",
    "",
    "Work in this order:",
    "1. Inspect first — use graph, get-node, and the list-* tools to understand the story before editing.",
    "2. Make your edits with the manipulate tools.",
    "3. Keep the graph healthy: every node you create must be reachable from the start node (wire it in",
    "   with rewire-goto, or add a choice option / jump that targets it) and must not be a dead end",
    "   (give an ending node an `end` statement; give a transit node a jump or choice out).",
    "4. Never remove an existing `end` statement unless you immediately replace it.",
    "5. Before finishing, run the `graph` tool and confirm `unreachable` is empty and you introduced no",
    "   new dead ends. Only then call the `done` tool.",
    "",
    "The `done` tool is a gate: if your edits left a new unreachable or dead-end node it is rejected",
    "with the problems listed — fix them and call `done` again.",
    `Available world tasks: ${names}.`,
  ].join("\n");
}

function defaultRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `run-${Date.now().toString(36)}`;
}

function verify(world: Registry, story: Story): Verification {
  const v = world.get("validate")!.run!(story, {});
  const g = world.get("graph")!.run!(story, {});
  const s = world.get("simulate")!.run!(story, { actions: [] });
  const graph = g.success ? (g.data as GraphReport) : null;
  const sim = s.success ? (s.data as { hash: string; reached: string[] }) : null;
  return {
    valid: v.success,
    issues: v.success ? [] : v.issues,
    unreachable: graph?.unreachable ?? [],
    deadEnds: graph?.deadEnds ?? [],
    simulate: sim ? { hash: sim.hash, reached: sim.reached } : null,
  };
}

/**
 * Run a whole editing task end-to-end under one runId, committing validated commands as
 * it goes, then self-verify (validate + graph + simulate) and return a reviewable result.
 * Hermetic when given a scripted provider (KTD-9). The caller keeps or reverts the run.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const world = opts.world ?? createWorld();
  const log = opts.log ?? new EditLog(world, opts.story);
  const runId = opts.runId ?? defaultRunId();
  const maxSteps = opts.maxSteps ?? 24;
  const tools = [...worldTools(world), DONE_TOOL];

  // Measure against the log's current story (== opts.story for a fresh log) so an injected
  // session log diffs/verifies relative to the pre-run state, not the log's original base.
  const preRunStory = log.currentStory();
  // Pre-run baseline: the agent is only held to problems *it* introduces (describeGate).
  const baseline = verify(world, preRunStory);
  const gateNow = (): Gate => describeGate(baseline, verify(world, log.currentStory()));

  const transcript: ChatMessage[] = [
    { role: "system", content: opts.system ?? agentSystemPrompt(world) },
    { role: "user", content: opts.prompt },
  ];

  let completed = false;
  for (let step = 0; step < maxSteps && !completed; step++) {
    const completion = await opts.provider.complete({
      messages: [...transcript],
      model: opts.model,
      temperature: opts.temperature,
      tools,
    });
    const calls: ToolCall[] = completion.toolCalls ?? [];
    transcript.push({
      role: "assistant",
      content: completion.text,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });

    // The model stopped calling tools: treat as an implicit completion request, but only
    // accept it if the run is clean — otherwise feed the graph problems back and continue.
    if (calls.length === 0) {
      const gate = gateNow();
      if (gate.clean) completed = true;
      else transcript.push({ role: "user", content: completionFeedback(gate) });
      continue;
    }

    for (const c of calls) {
      if (c.name === DONE_TOOL.name) {
        // `done` is a self-verification gate: accept only a clean run; otherwise return the
        // introduced unreachable / dead-end / validity issues so the model self-corrects.
        const gate = gateNow();
        if (gate.clean) completed = true;
        transcript.push({
          role: "tool",
          content: JSON.stringify(gate.clean ? { ok: true } : { ok: false, issues: gate.problems }),
          toolCallId: c.id,
        });
        continue;
      }
      const result = dispatch(world, log, runId, c);
      transcript.push({ role: "tool", content: JSON.stringify(result), toolCallId: c.id });
    }
  }

  const story = log.currentStory();
  const verification = verify(world, story);
  return {
    ok: describeGate(baseline, verification).clean,
    story,
    runId,
    commands: log.recordsView().filter((r) => r.runId === runId),
    diff: diffStories(preRunStory, story),
    verification,
    transcript,
    completed,
    log,
  };
}

function completionFeedback(gate: Gate): string {
  return [
    "Before finishing, fix these issues introduced by your edits, then call the `done` tool:",
    ...gate.problems.map((p) => `- ${p}`),
  ].join("\n");
}
