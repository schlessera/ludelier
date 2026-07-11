import {
  createWorld,
  EditLog,
  diffStories,
  unwrittenVarReads,
  conditionTypeIssues,
  type Registry,
  type EditRecord,
  type StoryDiff,
  type GraphReport,
  type ExploreReport,
} from "@ludelier/world";
import type { Issue, Story } from "@ludelier/schema";
import type { ChatMessage, CompletionResult, LLMProvider, ToolCall, ToolDefinition } from "./provider";
import { worldTools, dispatch, runHostTool, type AgentTool, type AgentToolEffect } from "./tools";

export interface RunAgentOptions {
  provider: LLMProvider;
  /** Natural-language description of the editing task. */
  prompt: string;
  /** The base story the run edits. */
  story: Story;
  /** A world registry; defaults to a fresh `createWorld()`. */
  world?: Registry;
  /**
   * Host-owned tools composed with the world manifest for this run. Hosts own authorization and
   * external I/O; story changes must use the supplied edit log from the tool handler context.
   */
  tools?: readonly AgentTool[];
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
  /** Sampling temperature. Defaults low (0.2) — editing wants precision, not variety. */
  temperature?: number;
  /** Output-token cap per turn. Defaults to a generous 8192 so a long say-writing batch
   *  isn't silently truncated into an unparseable tool call by a stingy provider default. */
  maxTokens?: number;
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
  /** Compact host-tool progress: never includes unbounded call arguments or tool results. */
  | { kind: "host-tool"; name: string; effects: readonly AgentToolEffect[]; success: boolean }
  | { kind: "verify"; clean: boolean; problems: string[]; warnings?: string[] }
  | { kind: "stop"; reason: StopReason };

/** Self-verification report — plain data (no `{success}` envelope leaks across the boundary). */
export interface Verification {
  valid: boolean;
  issues: Issue[];
  /** Static graph: nodes not reachable from start / nodes that cannot reach an `end`. */
  unreachable: string[];
  deadEnds: string[];
  /** Vars read in a choice `if` but never written — silently always-false branches. */
  unwrittenVars: string[];
  /** Ordered comparisons that can't behave as intended (non-number operand) — type bugs. */
  typeMismatches: string[];
  /** Nodes where a *runtime* play-through stalls: a choice with every option gated off. */
  stuck: string[];
  /** Whether an ending is reachable by actually playing through (honours `if`). */
  endReachable: boolean;
  /** Whether playing the story throws (infinite jump loop) — caught, not propagated. */
  crashed: boolean;
  /**
   * Whether the condition-honouring exploration hit its state cap. Its `reached` and
   * `endReachable` values are lower bounds while true, so derived absence claims are suppressed.
   */
  truncated: boolean;
  /** Statically reachable nodes no COMPLETE runtime play-through visits. This is intentionally
   * empty while exploration is truncated, because an unvisited node may simply be beyond its cap.
   * It is not a hard error — a WIP branch legitimately looks like this — but worth telling the
   * author/agent about (surfaced as a gate warning, non-blocking). */
  runtimeUnreached: string[];
  /** `reached` is real behavioural coverage (every explored path), not just the linear head; it
   * is a lower bound when `truncated` is true. `hash` is the seeded linear-run fingerprint. */
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
  /** Non-blocking observations delivered WITH an accepted `done` — real enough to mention,
   *  not real enough to wedge the loop on (e.g. a branch every runtime path gates off). */
  warnings: string[];
}

function describeGate(baseline: Verification, current: Verification): Gate {
  const added = (cur: string[], base: string[]): string[] => cur.filter((id) => !base.includes(id));
  const newUnreachable = added(current.unreachable, baseline.unreachable);
  const newDeadEnds = added(current.deadEnds, baseline.deadEnds);
  const newStuck = added(current.stuck, baseline.stuck);
  const newUnwrittenVars = added(current.unwrittenVars, baseline.unwrittenVars);
  const newTypeMismatches = added(current.typeMismatches, baseline.typeMismatches);
  const problems: string[] = [];
  for (const i of current.issues) problems.push(`invalid: ${i.path ? `${i.path} — ` : ""}${i.message}`);
  if (current.crashed && !baseline.crashed) {
    problems.push(
      "the story crashes when played (the statement budget was exceeded — almost always an infinite jump loop). Break the cycle: give a node on the loop an `end`, or a choice/condition that exits.",
    );
  }
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
  for (const id of newStuck) {
    problems.push(
      `node "${id}" has a choice whose every option is gated off (its \`if\` is never satisfiable at play time) — relax a condition or add an always-available option, or it is a runtime dead end.`,
    );
  }
  for (const v of newUnwrittenVars) {
    problems.push(
      `variable "${v}" is read in a choice \`if\` but never set by any set/add/roll — it compares against nothing and the branch is always false. Add a set/add/roll for it, or fix the name.`,
    );
  }
  for (const m of newTypeMismatches) problems.push(m);
  // Non-blocking: a node the run made statically reachable that no runtime path actually
  // visits. Legitimate mid-build (a branch pending its unlock), so it must not wedge the
  // loop — but silently shipping it is how "content nobody can see" happens.
  const warnings = added(current.runtimeUnreached, baseline.runtimeUnreached).map(
    (id) =>
      `node "${id}" is wired in but no play-through can currently reach it — every path to it is gated off by conditions. If that's not intentional, relax a condition or add an ungated route.`,
  );
  return { clean: current.valid && problems.length === 0, problems, warnings };
}

/** Loop-control tool — injected into the toolset but NOT a world task (absent from describe()). */
const DONE_TOOL: ToolDefinition = {
  name: "done",
  description: "Signal that the editing task is complete.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** Compose only unambiguous provider tool definitions, before the provider is ever invoked. */
function composeTools(world: Registry, hostTools: readonly AgentTool[]): ToolDefinition[] {
  const worldNames = new Set(world.describe().map((task) => task.name));
  if (worldNames.has(DONE_TOOL.name)) {
    throw new Error(`world task "${DONE_TOOL.name}" conflicts with the reserved done tool`);
  }

  const hostNames = new Set<string>();
  for (const tool of hostTools) {
    const { name } = tool.definition;
    if (name === DONE_TOOL.name) throw new Error(`host tool "${name}" conflicts with the reserved done tool`);
    if (worldNames.has(name)) throw new Error(`host tool "${name}" conflicts with world task "${name}"`);
    if (hostNames.has(name)) throw new Error(`duplicate host tool "${name}"`);
    hostNames.add(name);
  }

  return [...worldTools(world), ...hostTools.map((tool) => tool.definition), DONE_TOOL];
}

function agentSystemPrompt(world: Registry, hostTools: readonly AgentTool[]): string {
  const names = world
    .describe()
    .map((t) => `${t.name} (${t.kind})`)
    .join(", ");
  const hostNames = hostTools.map((tool) => tool.definition.name).join(", ");
  return [
    "You are an editing agent for the Ludelier visual-novel engine.",
    "Use the provided tools to inspect and edit the story. Every edit is validated;",
    "if a tool returns an error, read the issues and correct your next call.",
    "",
    "Work in this order:",
    "1. Inspect first — use graph, get-node, and the list-* tools to understand the story before editing.",
    "   Edit a node's body with the statement tools, targeting existing statements by their `id` from",
    "   get-node (never by position): add-statement {nodeId, statement:{op,...}, before?} appends a new",
    "   statement (or inserts it before the `before` statement id); update-statement replaces one in",
    "   place; move-statement reorders one; remove-statement deletes one. `statement` is a story",
    "   statement object — an `op` plus that op's fields. A terminal (`end`/`jump`/`choice`) must be a",
    "   node's LAST statement — nothing runs after it — so add it last (or insert earlier statements",
    "   `before` it).",
    "   Edit a choice's options in place by 0-based index — add-choice-option {nodeId, statementId,",
    "   option:{label,goto,if?}, beforeIndex?}, update-choice-option {nodeId, statementId, index,",
    "   option}, remove-choice-option {nodeId, statementId, index} — instead of rebuilding the whole",
    "   choice with update-statement.",
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
    "6. Before finishing, run `graph` (reachability + dead ends) and `explore` (it plays through every",
    "   path, honouring `if` conditions) and confirm `unreachable` is empty, you introduced no new dead",
    "   ends, and an ending is reachable. Make sure any variable a choice `if` reads is set somewhere.",
    "   Only then call the `done` tool.",
    "",
    "The `done` tool is a gate: if your edits left a new unreachable / dead-end / self-gated node, or a",
    "choice that reads a variable nothing ever sets, it is rejected with the problems listed — fix them",
    "and call `done` again.",
    `Available world tasks: ${names}.`,
    ...(hostNames ? [`Available host tools: ${hostNames}.`] : []),
  ].join("\n");
}

/** Await a checkpoint answer, resolving `false` immediately if the signal aborts first. */
function raceAbort(answer: boolean | Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return Promise.resolve(answer);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(answer).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      },
    );
  });
}

function defaultRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `run-${Date.now().toString(36)}`;
}

function verify(world: Registry, story: Story): Verification {
  const v = world.get("validate")!.run!(story, {});
  const g = world.get("graph")!.run!(story, {});
  // Behavioural coverage: actually play through every reachable path (honours `if`), instead of
  // the old `simulate(actions:[])` that only walked the linear head and reported no real coverage.
  // `explore` is crash-robust (it reports an infinite loop instead of throwing); the linear
  // `simulate` is not, so guard it — a crashing story still yields a usable verification report.
  const e = world.get("explore")!.run!(story, {});
  const graph = g.success ? (g.data as GraphReport) : null;
  const explore = e.success ? (e.data as ExploreReport) : null;
  let sim: { hash: string; reached: string[] } | null = null;
  try {
    const s = world.get("simulate")!.run!(story, { actions: [] });
    if (s.success) sim = s.data as { hash: string; reached: string[] };
  } catch {
    sim = null; // the story loops at runtime — explore.crashed already captures it
  }
  // Statically reachable but never visited by COMPLETE condition-honouring exploration: every
  // path in is gated off. A truncated `reached` set is only a lower bound, so it must never
  // produce false absence warnings.
  const runtimeReached = new Set(explore?.reached ?? []);
  const staticallyUnreachable = new Set(graph?.unreachable ?? []);
  const runtimeUnreached =
    graph && explore && !explore.crashed && !explore.truncated
      ? story.nodes.map((n) => n.id).filter((id) => !staticallyUnreachable.has(id) && !runtimeReached.has(id))
      : [];
  return {
    valid: v.success,
    issues: v.success ? [] : v.issues,
    unreachable: graph?.unreachable ?? [],
    deadEnds: graph?.deadEnds ?? [],
    unwrittenVars: unwrittenVarReads(story),
    typeMismatches: conditionTypeIssues(story),
    stuck: explore?.stuck ?? [],
    endReachable: explore?.endReachable ?? false,
    crashed: explore?.crashed ?? false,
    truncated: explore?.truncated ?? false,
    runtimeUnreached,
    simulate: sim ? { hash: sim.hash, reached: explore?.reached ?? sim.reached } : null,
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
  const hostTools = opts.tools ?? [];
  const tools = composeTools(world, hostTools);
  const hostToolsByName = new Map(hostTools.map((tool) => [tool.definition.name, tool]));

  // Measure against the log's current story (== opts.story for a fresh log) so an injected
  // session log diffs/verifies relative to the pre-run state, not the log's original base.
  const preRunStory = log.currentStory();
  // Pre-run baseline: the agent is only held to problems *it* introduces (describeGate).
  const baseline = verify(world, preRunStory);
  const gateNow = (): Gate => describeGate(baseline, verify(world, log.currentStory()));

  const transcript: ChatMessage[] = [
    { role: "system", content: opts.system ?? agentSystemPrompt(world, hostTools) },
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
    // Safety net: every `checkpointEvery` turns, ask whether to keep going. The wait races
    // the abort signal — an Interrupt while parked on a checkpoint prompt must end the run,
    // not leave it hanging on a promise nobody will resolve.
    if (step > 0 && step % checkpointEvery === 0) {
      const cont = opts.onCheckpoint ? await raceAbort(opts.onCheckpoint(step), opts.signal) : false;
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
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
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 8192,
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
      emit({ kind: "verify", clean: gate.clean, problems: gate.problems, warnings: gate.warnings });
      if (gate.clean) {
        completed = true;
        break;
      }
      transcript.push({ role: "user", content: completionFeedback(gate) });
      continue;
    }

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!;
      if (c.name === DONE_TOOL.name) {
        // `done` is a self-verification gate: accept only a clean run; otherwise return the
        // introduced unreachable / dead-end / validity issues so the model self-corrects.
        // Warnings ride along on acceptance — visible, never blocking.
        const gate = gateNow();
        emit({ kind: "verify", clean: gate.clean, problems: gate.problems, warnings: gate.warnings });
        transcript.push({
          role: "tool",
          content: JSON.stringify(
            gate.clean
              ? { ok: true, ...(gate.warnings.length > 0 ? { warnings: gate.warnings } : {}) }
              : { ok: false, issues: gate.problems },
          ),
          toolCallId: c.id,
        });
        if (gate.clean) {
          // An accepted `done` ends the run at the verified-clean state. Any calls the model
          // batched AFTER it are not applied — otherwise a trailing edit could dirty the story
          // after the gate passed, yielding `completed: true` with `ok: false`.
          completed = true;
          for (let j = i + 1; j < calls.length; j++) {
            transcript.push({
              role: "tool",
              content: JSON.stringify({
                success: false,
                issues: [
                  { path: "(run)", message: "not applied — `done` was already accepted in this turn" },
                ],
              }),
              toolCallId: calls[j]!.id,
            });
          }
          break;
        }
        continue;
      }
      const hostTool = hostToolsByName.get(c.name);
      if (hostTool) {
        const result = await runHostTool(hostTool, {
          call: c,
          story: log.currentStory(),
          world,
          log,
          runId,
          signal: opts.signal,
        });
        transcript.push({ role: "tool", content: JSON.stringify(result), toolCallId: c.id });
        emit({
          kind: "host-tool",
          name: hostTool.definition.name,
          effects: hostTool.effects,
          success: result.success,
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
