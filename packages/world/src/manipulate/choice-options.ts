import { z } from "zod";
import { ChoiceOption } from "@ludelier/schema";
import type { Statement as StatementT, Story, StoryNode } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok, fail, type Result } from "../result";
import { slugId } from "./ids";

/**
 * Choice-option ops: edit one option of a `choice` statement in place, without rebuilding
 * the whole statement (previously remove-statement + add-statement, or the editor form's
 * raw-JSON options field). The choice is targeted by its stable statement `id` (from
 * get-node); options carry no ids of their own, so within the choice they are addressed
 * by 0-based index — the same convention `rewire-goto` uses for `optionIndex`.
 * Cross-refs (an option's `goto` must resolve to a node) are enforced by `applyEdit`'s
 * whole-story re-validation, like every other manipulate task.
 */

type ChoiceOptionT = z.infer<typeof ChoiceOption>;
type ChoiceT = Extract<StatementT, { op: "choice" }>;

/** Locate the target choice, failing with a precise issue when the target isn't one. */
function findChoice(story: Story, nodeId: string, statementId: string): Result<ChoiceT> {
  const node = story.nodes.find((n) => n.id === nodeId);
  if (!node) return fail([{ path: "nodeId", message: `unknown node "${nodeId}"` }]);
  const stmt = node.body.find((s) => s.id === statementId);
  if (!stmt) {
    return fail([{ path: "statementId", message: `no statement "${statementId}" in node "${nodeId}"` }]);
  }
  if (stmt.op !== "choice") {
    return fail([
      { path: "statementId", message: `statement "${statementId}" is a ${stmt.op}, not a choice` },
    ]);
  }
  return ok(stmt);
}

/** Rebuild the story with the target choice's options replaced (same id, same position). */
function withOptions(
  story: Story,
  nodeId: string,
  statementId: string,
  choice: ChoiceT,
  options: ChoiceOptionT[],
): Story {
  const next: StatementT = { ...choice, options };
  const nodes = story.nodes.map(
    (n): StoryNode =>
      n.id === nodeId ? { ...n, body: n.body.map((s) => (s.id === statementId ? next : s)) } : n,
  );
  return { ...story, nodes };
}

function outOfRange(path: string, index: number, count: number): Result<never> {
  return fail([{ path, message: `option ${index} out of range (choice has ${count} option(s))` }]);
}

export const addChoiceOptionTask: Task = {
  name: "add-choice-option",
  kind: "manipulate",
  description:
    "Add an option to an existing choice statement (target the choice by statementId from get-node). `option` is {label, goto, if?:{var,cmp,value}}. Appends at the end, or inserts at `beforeIndex` (0-based; the option currently at that index shifts right).",
  params: z.object({
    nodeId: slugId,
    statementId: z.string().min(1),
    option: ChoiceOption,
    beforeIndex: z.number().int().min(0).optional(),
  }),
  apply: (story, params) => {
    const p = params as {
      nodeId: string;
      statementId: string;
      option: ChoiceOptionT;
      beforeIndex?: number;
    };
    const found = findChoice(story, p.nodeId, p.statementId);
    if (!found.success) return found;
    const choice = found.data;
    if (p.beforeIndex === undefined) {
      return ok(withOptions(story, p.nodeId, p.statementId, choice, [...choice.options, p.option]));
    }
    // `beforeIndex === options.length` is a valid explicit append; anything past it is a miss.
    if (p.beforeIndex > choice.options.length) {
      return outOfRange("beforeIndex", p.beforeIndex, choice.options.length);
    }
    const options = [
      ...choice.options.slice(0, p.beforeIndex),
      p.option,
      ...choice.options.slice(p.beforeIndex),
    ];
    return ok(withOptions(story, p.nodeId, p.statementId, choice, options));
  },
};

export const updateChoiceOptionTask: Task = {
  name: "update-choice-option",
  kind: "manipulate",
  description:
    "Replace one option of a choice statement in place, by 0-based `index`. `option` is the full replacement {label, goto, if?} — omitting `if` clears any existing condition.",
  params: z.object({
    nodeId: slugId,
    statementId: z.string().min(1),
    index: z.number().int().min(0),
    option: ChoiceOption,
  }),
  apply: (story, params) => {
    const p = params as { nodeId: string; statementId: string; index: number; option: ChoiceOptionT };
    const found = findChoice(story, p.nodeId, p.statementId);
    if (!found.success) return found;
    const choice = found.data;
    if (p.index >= choice.options.length) return outOfRange("index", p.index, choice.options.length);
    const options = choice.options.map((o, i) => (i === p.index ? p.option : o));
    return ok(withOptions(story, p.nodeId, p.statementId, choice, options));
  },
};

export const removeChoiceOptionTask: Task = {
  name: "remove-choice-option",
  kind: "manipulate",
  description:
    "Remove one option of a choice statement, by 0-based `index`. Refuses to remove the last remaining option (an option-less choice strands the player); remove the whole statement with remove-statement instead.",
  params: z.object({ nodeId: slugId, statementId: z.string().min(1), index: z.number().int().min(0) }),
  apply: (story, params) => {
    const p = params as { nodeId: string; statementId: string; index: number };
    const found = findChoice(story, p.nodeId, p.statementId);
    if (!found.success) return found;
    const choice = found.data;
    if (p.index >= choice.options.length) return outOfRange("index", p.index, choice.options.length);
    // An option-less choice is a runtime dead end: the reducer would present zero options, so no
    // CHOOSE action can ever advance (explore reports the node as `stuck`), and the schema itself
    // requires ≥1 option. Fail here with the real reason instead of a generic re-validation issue.
    if (choice.options.length === 1) {
      return fail([
        {
          path: "index",
          message:
            `cannot remove the last option of choice "${p.statementId}": a choice with no options ` +
            "strands the player (no CHOOSE action can advance — explore reports the node as stuck), " +
            "and a choice requires at least one option. Remove the whole statement with " +
            "remove-statement instead.",
        },
      ]);
    }
    const options = choice.options.filter((_, i) => i !== p.index);
    return ok(withOptions(story, p.nodeId, p.statementId, choice, options));
  },
};
