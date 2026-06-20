import { type Registry, type EditLog, type Result, parseParams, fail } from "@ludelier/world";
import type { ToolCall, ToolDefinition } from "./provider";

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
