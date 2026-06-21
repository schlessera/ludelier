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
 * `success → ok` conversion point, KTD-5). The `log` is returned so the caller can keep
 * the run or `revertRun(runId)` it; `completed` distinguishes a finished run from a
 * `maxSteps`-truncated partial one (whose records remain committed — KTD-11).
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
    "Call the `done` tool when the task is complete.",
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
  const log = new EditLog(world, opts.story);
  const runId = opts.runId ?? defaultRunId();
  const maxSteps = opts.maxSteps ?? 12;
  const tools = [...worldTools(world), DONE_TOOL];

  const transcript: ChatMessage[] = [
    { role: "system", content: opts.system ?? agentSystemPrompt(world) },
    { role: "user", content: opts.prompt },
  ];

  let completed = false;
  for (let step = 0; step < maxSteps; step++) {
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

    if (calls.length === 0) {
      completed = true;
      break;
    }

    let sawDone = false;
    for (const c of calls) {
      if (c.name === DONE_TOOL.name) {
        sawDone = true;
        transcript.push({ role: "tool", content: JSON.stringify({ ok: true }), toolCallId: c.id });
        continue;
      }
      const result = dispatch(world, log, runId, c);
      transcript.push({ role: "tool", content: JSON.stringify(result), toolCallId: c.id });
    }
    if (sawDone) {
      completed = true;
      break;
    }
  }

  const story = log.currentStory();
  const verification = verify(world, story);
  return {
    ok: verification.valid,
    story,
    runId,
    commands: log.recordsView(),
    diff: diffStories(opts.story, story),
    verification,
    transcript,
    completed,
    log,
  };
}
