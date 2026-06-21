import { z } from "zod";
import type { Task } from "../registry";
import { ok } from "../result";
import { byId } from "../sort";

export const listCharactersTask: Task = {
  name: "list-characters",
  kind: "understand",
  description: "List the story's characters, sorted by id.",
  params: z.object({}),
  run: (story) => ok([...story.characters].sort(byId)),
};

export const listAssetsTask: Task = {
  name: "list-assets",
  kind: "understand",
  description: "List the story's registered assets, sorted by id.",
  params: z.object({}),
  run: (story) => ok([...story.assets].sort(byId)),
};

/**
 * List variable names the story uses. There is no variable declaration in the DSL —
 * names are inferred from `set`/`add`/`roll` targets and `choice` option conditions.
 * Sorted for determinism.
 */
export const listVariablesTask: Task = {
  name: "list-variables",
  kind: "understand",
  description: "List variable names inferred from set/add/roll targets and choice conditions.",
  params: z.object({}),
  run: (story) => {
    const vars = new Set<string>();
    for (const node of story.nodes) {
      for (const stmt of node.body) {
        if (stmt.op === "set" || stmt.op === "add" || stmt.op === "roll") vars.add(stmt.var);
        if (stmt.op === "choice") {
          for (const opt of stmt.options) if (opt.if) vars.add(opt.if.var);
        }
      }
    }
    return ok([...vars].sort());
  },
};
