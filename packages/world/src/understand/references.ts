import { z } from "zod";
import type { Task } from "../registry";
import { ok } from "../result";
import { byId } from "../sort";

export interface Reference {
  path: string;
  kind: "goto" | "asset" | "sprite" | "character";
}

/**
 * Find every place an id is referenced — as a goto target, an asset, a sprite slot,
 * or a `say.who` character. Nodes are iterated in sorted id order so the result is
 * stable regardless of authored node order (golden rule). An id may be referenced in
 * more than one role (e.g. a sprite slot and asset sharing a name), so callers get all roles.
 */
export const findReferencesTask: Task = {
  name: "find-references",
  kind: "understand",
  description: "Find where a node/asset/character/sprite id is referenced.",
  params: z.object({ id: z.string() }),
  run: (story, params) => {
    const { id } = params as { id: string };
    const refs: Reference[] = [];
    for (const node of [...story.nodes].sort(byId)) {
      node.body.forEach((stmt, i) => {
        const at = `nodes.${node.id}.body[${i}]`;
        if (stmt.op === "jump" && stmt.goto === id) refs.push({ path: at, kind: "goto" });
        if (stmt.op === "branch" && stmt.goto === id) refs.push({ path: at, kind: "goto" });
        if (stmt.op === "choice") {
          stmt.options.forEach((o, j) => {
            if (o.goto === id) refs.push({ path: `${at}.options[${j}]`, kind: "goto" });
          });
        }
        if (stmt.op === "scene" && stmt.bg === id) refs.push({ path: at, kind: "asset" });
        if (stmt.op === "show" && stmt.asset === id) refs.push({ path: at, kind: "asset" });
        if (stmt.op === "sound" && stmt.asset === id) refs.push({ path: at, kind: "asset" });
        if (stmt.op === "show" && stmt.sprite === id) refs.push({ path: at, kind: "sprite" });
        if (stmt.op === "hide" && stmt.sprite === id) refs.push({ path: at, kind: "sprite" });
        if (stmt.op === "say" && stmt.who === id) refs.push({ path: at, kind: "character" });
      });
    }
    return ok(refs);
  },
};
