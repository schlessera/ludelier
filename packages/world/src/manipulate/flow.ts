import { z } from "zod";
import type { Statement, StoryNode } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok, fail } from "../result";
import { slugId } from "./ids";

/**
 * Rewire a goto target — either a `jump.goto` or a `choice.options[optionIndex].goto`.
 * The target node's existence is enforced by `validateStory` in applyEdit.
 */
export const rewireGotoTask: Task = {
  name: "rewire-goto",
  kind: "manipulate",
  description: "Repoint a jump or choice-option goto to another node (target the statement by id).",
  params: z.object({
    nodeId: slugId,
    statementId: z.string().min(1),
    goto: slugId,
    optionIndex: z.number().int().min(0).optional(),
  }),
  apply: (story, params) => {
    const p = params as { nodeId: string; statementId: string; goto: string; optionIndex?: number };
    const node = story.nodes.find((n) => n.id === p.nodeId);
    if (!node) return fail([{ path: "nodeId", message: `unknown node "${p.nodeId}"` }]);
    const stmt = node.body.find((s) => s.id === p.statementId);
    if (!stmt) return fail([{ path: "statementId", message: `no statement "${p.statementId}" in node "${p.nodeId}"` }]);

    let next: Statement;
    if (stmt.op === "jump") {
      next = { ...stmt, goto: p.goto };
    } else if (stmt.op === "choice") {
      if (p.optionIndex === undefined) {
        return fail([{ path: "optionIndex", message: "optionIndex is required to rewire a choice" }]);
      }
      const opt = stmt.options[p.optionIndex];
      if (!opt) return fail([{ path: "optionIndex", message: `option ${p.optionIndex} out of range` }]);
      next = {
        ...stmt,
        options: stmt.options.map((o, j) => (j === p.optionIndex ? { ...o, goto: p.goto } : o)),
      };
    } else {
      return fail([{ path: "statementId", message: `statement "${p.statementId}" is not a jump or choice` }]);
    }

    const body = node.body.map((s) => (s.id === p.statementId ? next : s));
    const nodes = story.nodes.map((n): StoryNode => (n.id === p.nodeId ? { ...n, body } : n));
    return ok({ ...story, nodes });
  },
};
