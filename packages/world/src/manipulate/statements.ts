import { z } from "zod";
import type { Statement, Story, StoryNode } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok, fail, type Result } from "../result";
import { slugId } from "./ids";

/** Append a built statement to a node's body (immutable). Unknown node → fail. */
function appendTo(story: Story, nodeId: string, stmt: Statement): Result<Story> {
  const node = story.nodes.find((n) => n.id === nodeId);
  if (!node) return fail([{ path: "nodeId", message: `unknown node "${nodeId}"` }]);
  const nodes = story.nodes.map((n): StoryNode => (n.id === nodeId ? { ...n, body: [...n.body, stmt] } : n));
  return ok({ ...story, nodes });
}

export const removeStatementTask: Task = {
  name: "remove-statement",
  kind: "manipulate",
  description: "Remove a statement from a node by index.",
  params: z.object({ nodeId: slugId, index: z.number().int().min(0) }),
  apply: (story, params) => {
    const p = params as { nodeId: string; index: number };
    const node = story.nodes.find((n) => n.id === p.nodeId);
    if (!node) return fail([{ path: "nodeId", message: `unknown node "${p.nodeId}"` }]);
    if (p.index >= node.body.length) {
      return fail([{ path: "index", message: `index ${p.index} out of range for node "${p.nodeId}"` }]);
    }
    const body = node.body.filter((_, i) => i !== p.index);
    const nodes = story.nodes.map((n): StoryNode => (n.id === p.nodeId ? { ...n, body } : n));
    return ok({ ...story, nodes });
  },
};

// --- Flattened scalar statement-add commands (KTD-4/KTD-7) ---

export const appendSayTask: Task = {
  name: "append-say",
  kind: "manipulate",
  description: "Append a say line (who must be a declared character).",
  params: z.object({ nodeId: slugId, who: slugId, text: z.string() }),
  apply: (story, params) => {
    const p = params as { nodeId: string; who: string; text: string };
    return appendTo(story, p.nodeId, { op: "say", who: p.who, text: p.text });
  },
};

export const appendShowTask: Task = {
  name: "append-show",
  kind: "manipulate",
  description: "Append a show statement (sprite slot + asset, optional position).",
  params: z.object({
    nodeId: slugId,
    sprite: slugId,
    asset: slugId,
    at: z.enum(["left", "center", "right"]).optional(),
  }),
  apply: (story, params) => {
    const p = params as { nodeId: string; sprite: string; asset: string; at?: "left" | "center" | "right" };
    return appendTo(story, p.nodeId, { op: "show", sprite: p.sprite, asset: p.asset, at: p.at ?? "center" });
  },
};

export const appendChoiceTask: Task = {
  name: "append-choice",
  kind: "manipulate",
  description: "Append a choice with labelled goto options.",
  params: z.object({
    nodeId: slugId,
    prompt: z.string().optional(),
    options: z.array(z.object({ label: z.string().min(1), goto: slugId })).min(1),
  }),
  apply: (story, params) => {
    const p = params as { nodeId: string; prompt?: string; options: { label: string; goto: string }[] };
    const choice: Statement = {
      op: "choice",
      ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
      options: p.options.map((o) => ({ label: o.label, goto: o.goto })),
    };
    return appendTo(story, p.nodeId, choice);
  },
};

export const appendJumpTask: Task = {
  name: "append-jump",
  kind: "manipulate",
  description: "Append a jump to another node.",
  params: z.object({ nodeId: slugId, goto: slugId }),
  apply: (story, params) => {
    const p = params as { nodeId: string; goto: string };
    return appendTo(story, p.nodeId, { op: "jump", goto: p.goto });
  },
};

export const appendEndTask: Task = {
  name: "append-end",
  kind: "manipulate",
  description: "Append an end statement.",
  params: z.object({ nodeId: slugId }),
  apply: (story, params) => {
    const p = params as { nodeId: string };
    return appendTo(story, p.nodeId, { op: "end" });
  },
};
