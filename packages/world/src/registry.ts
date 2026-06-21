import type { ZodType } from "zod";
import type { Story } from "@ludelier/schema";
import { toJsonSchema } from "@ludelier/schema";
import type { Result } from "./result";

export type TaskKind = "understand" | "manipulate";

/**
 * A self-describing world task. `kind` is load-bearing routing metadata (KTD-4):
 * `understand` tasks read (`run`), `manipulate` tasks edit (`apply`). The registry
 * asserts `kind`⟺handler correspondence so a mis-declared task cannot silently
 * bypass the log chokepoint.
 */
export interface Task {
  name: string;
  kind: TaskKind;
  description: string;
  params: ZodType;
  run?: (story: Story, params: unknown) => Result<unknown>;
  apply?: (story: Story, params: unknown) => Result<Story>;
}

/** One entry of the `describe()` manifest — the highest-fanout contract (CLI + LLM tools + UI). */
export interface TaskManifestEntry {
  name: string;
  kind: TaskKind;
  description: string;
  schema: unknown;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Keyed task registries (understand + manipulate) that derive the manifest. */
export class Registry {
  private readonly understand = new Map<string, Task>();
  private readonly manipulate = new Map<string, Task>();

  register(task: Task): void {
    // kind ⟺ handler correspondence (KTD-4): a mis-tag is a silent log-bypass / parity bug.
    if (task.kind === "understand" && (!task.run || task.apply)) {
      throw new Error(`task "${task.name}": understand tasks must define run() and not apply()`);
    }
    if (task.kind === "manipulate" && (!task.apply || task.run)) {
      throw new Error(`task "${task.name}": manipulate tasks must define apply() and not run()`);
    }
    if (this.understand.has(task.name) || this.manipulate.has(task.name)) {
      throw new Error(`duplicate task name: "${task.name}"`);
    }
    (task.kind === "understand" ? this.understand : this.manipulate).set(task.name, task);
  }

  get(name: string): Task | undefined {
    return this.understand.get(name) ?? this.manipulate.get(name);
  }

  tasks(): Task[] {
    return [...this.understand.values(), ...this.manipulate.values()].sort(byName);
  }

  /** The manifest: name/kind/description + JSON Schema, stably sorted by name. */
  describe(): TaskManifestEntry[] {
    return this.tasks().map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description,
      schema: toJsonSchema(t.params),
    }));
  }
}
