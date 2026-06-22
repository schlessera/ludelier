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
import type { ChatMessage, CompletionResult, LLMProvider, ToolCall, ToolDefinition } from "./provider";
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
  /**
   * Optional ABSOLUTE hard cap on provider turns. There is no default — the loop runs until the
   * agent finishes (a clean `done`), the caller interrupts (`signal`), or a checkpoint declines
   * to continue. Used mainly by tests / non-interactive callers that want a deterministic bound.
   */
  maxSteps?: number;
  /**
   * Pause every N turns and ask `onCheckpoint` whether to keep going — the safety net for a
   * long autonomous run. Default 500.
   */
  checkpointEvery?: number;
  /**
   * Called at each checkpoint with the current step count; resolve `true` to continue, `false`
   * to stop. If omitted, the run stops at the first checkpoint (safe default for non-interactive
   * callers — they still get `checkpointEvery` turns).
   */
  onCheckpoint?: (step: number) => boolean | Promise<boolean>;
  /** Interrupt the run between turns and abort the in-flight provider call. */
  signal?: AbortSignal;
  /** Progress callback fired as the run works — drives a live UI feed (see `AgentEvent`). */
  onEvent?: (event: AgentEvent) => void;
  /** Caller-supplied run id; defaults to a generated one. Uniqueness is the caller's responsibility. */
  runId?: string;
  model?: string;
  temperature?: number;
  system?: string;
}

/** Why the run loop stopped. */
export type StopReason = "completed" | "aborted" | "checkpoint" | "cap";

/** A streamed progress event. The editor renders these as a live, human-readable work feed. */
export type AgentEvent =
  | { kind: "turn"; step: number }
  | { kind: "assistant"; text: string }
  | { kind: "edit"; command: string; params: unknown; success: boolean; issues: Issue[] }
  | { kind: "query"; task: string; success: boolean }
  | { kind: "verify"; clean: boolean; problems: string[] }
  | { kind: "stop"; reason: StopReason };

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
 * `completed` distinguishes a run the agent verified clean from an interrupted, stalled, or
 * still-broken partial one (whose records remain committed — KTD-11). `aborted` flags a
 * caller interruption; `stopReason` says exactly why the loop ended.
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
  aborted: boolean;
  stopReason: StopReason;
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
    "   To change or remove an existing statement, call get-node and target it by its `id` field",
    "   (remove-statement / rewire-goto take a `statementId`, never a position). New statements are",
    "   appended to the end of a node — to replace a node's dialogue, remove the old statements by id",
    "   first, then append the new ones in order.",
    "2. Build depth-first and complete one node at a time: create a node, immediately give it its",
    "   statements (say/choice/end), and wire it in (rewire-goto, or a choice/jump that targets it) —",
    "   THEN move to the next node. Do NOT create empty placeholder nodes you will fill later: an empty",
    "   node is both a dead end and (until wired) unreachable, and if the run is cut short it is left",
    "   broken. Finishing fewer branches completely beats sketching many incompletely.",
    "3. Batch related edits in a single turn — you may emit several tool calls at once. Prefer that: it",
    "   is faster and leaves fewer half-built states between turns.",
    "4. Keep the graph healthy: every node you create must be reachable from the start node and must not",
    "   be a dead end (an ending node needs an `end`; a transit node needs a jump or choice out).",
    "5. Never remove an existing `end` statement unless you immediately replace it.",
    "6. Before finishing, run the `graph` tool and confirm `unreachable` is empty and you introduced no",
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
  const hardCap = opts.maxSteps; // optional absolute bound (no default)
  const checkpointEvery = opts.checkpointEvery ?? 500;
  const emit = opts.onEvent ?? ((): void => {});
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

  // The loop runs until the agent finishes (clean `done`), the caller interrupts (`signal`), an
  // absolute `maxSteps` cap is hit, or a periodic checkpoint declines to continue. There is no
  // step budget on a healthy run — the human watches the streamed events and interrupts if needed.
  let completed = false;
  let aborted = false;
  let declined = false;
  let step = 0;
  for (; ; step++) {
    if (hardCap !== undefined && step >= hardCap) break;
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    // Safety net: every `checkpointEvery` turns, ask whether to keep going.
    if (step > 0 && step % checkpointEvery === 0) {
      const cont = opts.onCheckpoint ? await opts.onCheckpoint(step) : false;
      if (!cont) {
        declined = true;
        break;
      }
    }

    emit({ kind: "turn", step });
    let completion: CompletionResult;
    try {
      completion = await opts.provider.complete({
        messages: [...transcript],
        model: opts.model,
        temperature: opts.temperature,
        tools,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      throw err;
    }
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    const calls: ToolCall[] = completion.toolCalls ?? [];
    transcript.push({
      role: "assistant",
      content: completion.text,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });
    if (completion.text) emit({ kind: "assistant", text: completion.text });

    // The model stopped calling tools: treat as an implicit completion request, but only
    // accept it if the run is clean — otherwise feed the graph problems back and continue.
    if (calls.length === 0) {
      const gate = gateNow();
      emit({ kind: "verify", clean: gate.clean, problems: gate.problems });
      if (gate.clean) {
        completed = true;
        break;
      }
      transcript.push({ role: "user", content: completionFeedback(gate) });
      continue;
    }

    for (const c of calls) {
      if (c.name === DONE_TOOL.name) {
        // `done` is a self-verification gate: accept only a clean run; otherwise return the
        // introduced unreachable / dead-end / validity issues so the model self-corrects.
        const gate = gateNow();
        emit({ kind: "verify", clean: gate.clean, problems: gate.problems });
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
      if (world.get(c.name)?.kind === "understand") {
        emit({ kind: "query", task: c.name, success: result.success });
      } else {
        emit({
          kind: "edit",
          command: c.name,
          params: c.arguments,
          success: result.success,
          issues: result.success ? [] : result.issues,
        });
      }
    }
    if (completed) break;
  }

  const stopReason: StopReason = completed
    ? "completed"
    : aborted
      ? "aborted"
      : declined
        ? "checkpoint"
        : "cap";
  emit({ kind: "stop", reason: stopReason });

  const story = log.currentStory();
  const verification = verify(world, story);
  return {
    ok: describeGate(baseline, verification).clean,
    aborted,
    stopReason,
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
