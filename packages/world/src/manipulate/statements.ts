import { z } from "zod";
import { Statement } from "@ludelier/schema";
import type { Statement as StatementT, Story, StoryNode } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok, fail, type Result } from "../result";
import { slugId } from "./ids";

/**
 * Generic statement ops. One `add-statement` (the schema's `Statement` discriminated union)
 * covers every statement kind — and every future kind — instead of a flattened command per
 * kind × position, so the toolset stays flat as the DSL grows. All the always-valid guardrails
 * still run in `applyEdit` (terminal-position rule, say.who, cross-refs). Statements are targeted
 * by their stable `id` (from get-node); `add-statement` is the only one that creates a new id.
 */

/** The commands that create a brand-new statement — the EditLog assigns each a stable id. */
export const STATEMENT_CREATE_COMMANDS = new Set(["add-statement"]);

function withBody(story: Story, nodeId: string, body: StatementT[]): Story {
  const nodes = story.nodes.map((n): StoryNode => (n.id === nodeId ? { ...n, body } : n));
  return { ...story, nodes };
}

export const addStatementTask: Task = {
  name: "add-statement",
  kind: "manipulate",
  description:
    "Add a statement to a node. Appends at the end, or inserts before `before` (a statement id from get-node). `statement` is a story statement object: an `op` plus that op's fields — e.g. {op:'say',who,text}, {op:'choice',prompt?,options:[{label,goto}]}, {op:'jump',goto}, {op:'branch',cond:{var,cmp,value},goto}, {op:'end'}, {op:'scene',bg}, {op:'show',sprite,asset,at?}, {op:'hide',sprite}, {op:'set',var,value}, {op:'add',var,amount}, {op:'roll',var,min,max}. `branch` is a conditional jump (takes goto when cond holds, else falls through) and may be followed by more statements; a terminal (end/jump) must be the node's last statement. Omit the statement's id.",
  params: z.object({ nodeId: slugId, before: z.string().min(1).optional(), statement: Statement }),
  apply: (story, params) => {
    const p = params as { nodeId: string; before?: string; statement: StatementT };
    const node = story.nodes.find((n) => n.id === p.nodeId);
    if (!node) return fail([{ path: "nodeId", message: `unknown node "${p.nodeId}"` }]);
    const stmt: StatementT = { ...p.statement, id: p.statement.id ?? `${p.nodeId}#g${node.body.length}` };
    if (p.before === undefined) return ok(withBody(story, p.nodeId, [...node.body, stmt]));
    const idx = node.body.findIndex((s) => s.id === p.before);
    if (idx === -1) return fail([{ path: "before", message: `no statement "${p.before}" in node "${p.nodeId}"` }]);
    return ok(withBody(story, p.nodeId, [...node.body.slice(0, idx), stmt, ...node.body.slice(idx)]));
  },
};

export const updateStatementTask: Task = {
  name: "update-statement",
  kind: "manipulate",
  description:
    "Replace a statement in place (same position, same id) with a new `statement` object. Target the existing one by `statementId` (from get-node). Omit the statement's id.",
  params: z.object({ nodeId: slugId, statementId: z.string().min(1), statement: Statement }),
  apply: (story, params) => {
    const p = params as { nodeId: string; statementId: string; statement: StatementT };
    const node = story.nodes.find((n) => n.id === p.nodeId);
    if (!node) return fail([{ path: "nodeId", message: `unknown node "${p.nodeId}"` }]);
    if (!node.body.some((s) => s.id === p.statementId)) {
      return fail([{ path: "statementId", message: `no statement "${p.statementId}" in node "${p.nodeId}"` }]);
    }
    const body = node.body.map((s) => (s.id === p.statementId ? { ...p.statement, id: p.statementId } : s));
    return ok(withBody(story, p.nodeId, body));
  },
};

export const moveStatementTask: Task = {
  name: "move-statement",
  kind: "manipulate",
  description:
    "Reorder a statement: move it before `before` (a statement id), or to the node's end if `before` is omitted. Target the moving statement by `statementId`.",
  params: z.object({ nodeId: slugId, statementId: z.string().min(1), before: z.string().min(1).optional() }),
  apply: (story, params) => {
    const p = params as { nodeId: string; statementId: string; before?: string };
    const node = story.nodes.find((n) => n.id === p.nodeId);
    if (!node) return fail([{ path: "nodeId", message: `unknown node "${p.nodeId}"` }]);
    const from = node.body.findIndex((s) => s.id === p.statementId);
    if (from === -1) return fail([{ path: "statementId", message: `no statement "${p.statementId}" in node "${p.nodeId}"` }]);
    const moving = node.body[from]!;
    const without = node.body.filter((_, i) => i !== from);
    let body: StatementT[];
    if (p.before === undefined) {
      body = [...without, moving];
    } else {
      const idx = without.findIndex((s) => s.id === p.before);
      if (idx === -1) return fail([{ path: "before", message: `no statement "${p.before}" in node "${p.nodeId}"` }]);
      body = [...without.slice(0, idx), moving, ...without.slice(idx)];
    }
    return ok(withBody(story, p.nodeId, body));
  },
};

export const removeStatementTask: Task = {
  name: "remove-statement",
  kind: "manipulate",
  description: "Remove a statement from a node by its stable statement id (from get-node), not by position.",
  params: z.object({ nodeId: slugId, statementId: z.string().min(1) }),
  apply: (story, params): Result<Story> => {
    const p = params as { nodeId: string; statementId: string };
    const node = story.nodes.find((n) => n.id === p.nodeId);
    if (!node) return fail([{ path: "nodeId", message: `unknown node "${p.nodeId}"` }]);
    if (!node.body.some((s) => s.id === p.statementId)) {
      return fail([{ path: "statementId", message: `no statement "${p.statementId}" in node "${p.nodeId}"` }]);
    }
    return ok(withBody(story, p.nodeId, node.body.filter((s) => s.id !== p.statementId)));
  },
};
