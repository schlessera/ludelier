import { type Registry, type EditLog, type Result, parseParams, fail } from "@ludelier/world";
import type { Story } from "@ludelier/schema";
import type { ToolCall, ToolDefinition } from "./provider";

/** Declared effects let a host distinguish story edits from paid or filesystem work. */
export type AgentToolEffect = "read" | "story-write" | "paid-network" | "filesystem";

/**
 * The host-tool handler's run-scoped view. Hosts that change the story MUST use `log` (normally
 * `log.apply(..., { runId })`) so the change remains in the command history and can be reverted.
 * Authorization stays with the host: it may omit a tool or return the normal failure envelope.
 */
export interface AgentToolContext {
  call: ToolCall;
  story: Story;
  world: Registry;
  log: EditLog;
  runId: string;
  signal?: AbortSignal;
}

/**
 * A host-injected extension to the generic authoring loop. `definition.name` must be unique
 * across the host tools and must not conflict with a world task or `done`. Handler results are
 * deliberately compact and redacted: return identifiers/statuses, never bytes, credentials, or
 * raw provider responses.
 */
export interface AgentTool {
  definition: ToolDefinition;
  effects: readonly AgentToolEffect[];
  handler(context: AgentToolContext): Promise<Result<unknown>>;
}
/**
 * Host code is an external boundary: a rejected handler is converted into the same compact,
 * redacted failure envelope as other tool failures. Never expose the rejection reason because
 * hosts may include provider responses, credentials, or local paths in it.
 */
export async function runHostTool(tool: AgentTool, context: AgentToolContext): Promise<Result<unknown>> {
  try {
    return await tool.handler(context);
  } catch {
    return fail([{ path: "host", message: `host tool "${tool.definition.name}" failed` }]);
  }
}

/**
 * Derive the provider tool list from the world manifest — one tool per task, its
 * `parameters` being the task's JSON Schema. The single `describe()` manifest is the
 * source for the LLM toolset, the CLI, and the future UI (parity).
 */
export function worldTools(world: Registry): ToolDefinition[] {
  return world.describe().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.schema,
  }));
}

/**
 * Dispatch one tool call back to the world, routing on the task's `kind` (KTD-4):
 * `understand` runs against the current story; `manipulate` applies through the log
 * under `runId` (the only mutation path — never bypassed). `kind` is read from the
 * registry, never from the call. Returns the uniform `{success}` envelope.
 */
export function dispatch(world: Registry, log: EditLog, runId: string, call: ToolCall): Result<unknown> {
  const task = world.get(call.name);
  if (!task) return fail([{ path: "name", message: `unknown task "${call.name}"` }]);

  if (task.kind === "understand") {
    if (!task.run) return fail([{ path: "name", message: `task "${call.name}" has no run handler` }]);
    const parsed = parseParams(task.params, call.arguments);
    if (!parsed.success) return parsed;
    return task.run(log.currentStory(), parsed.data);
  }

  // manipulate — applyEdit (inside log.apply) validates params + re-validates the story.
  return log.apply(call.name, call.arguments, { runId });
}
