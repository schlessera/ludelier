import { z } from "zod";
import type { Story, StoryNode, Condition } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok } from "../result";
import { byId } from "../sort";

export type FlowEdgeKind = "choice" | "jump" | "branch";

/**
 * A node-to-node transition recovered from a node's body, carrying the metadata the
 * structure map renders: the edge `kind`, a human `label` (choice text / branch
 * condition), whether it is `conditional` (a `branch`, or a `choice` option with an
 * `if`), and the originating statement `id`. `GraphReport.edges` is bare `{from,to}`
 * adjacency — this is the labelled counterpart, derived the same way the engine
 * transitions between nodes (jump / branch / choice gotos), so the map matches real
 * execution. Pure analysis: never mutates the story, never persists positions.
 */
export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  label?: string;
  conditional: boolean;
  statementId?: string;
}

const CMP_SYMBOL: Record<Condition["cmp"], string> = {
  eq: "==",
  ne: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
};

/** Render a declarative condition as a readable label, e.g. `gold > 5`. */
export function formatCondition(cond: Condition): string {
  return `${cond.var} ${CMP_SYMBOL[cond.cmp]} ${String(cond.value)}`;
}

function nodeEdges(node: StoryNode): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const s of node.body) {
    if (s.op === "jump") {
      edges.push({ from: node.id, to: s.goto, kind: "jump", conditional: false, statementId: s.id });
    } else if (s.op === "branch") {
      edges.push({
        from: node.id,
        to: s.goto,
        kind: "branch",
        label: formatCondition(s.cond),
        conditional: true,
        statementId: s.id,
      });
    } else if (s.op === "choice") {
      for (const o of s.options) {
        edges.push({
          from: node.id,
          to: o.goto,
          kind: "choice",
          label: o.if ? `${o.label} (if ${formatCondition(o.if)})` : o.label,
          conditional: Boolean(o.if),
          statementId: s.id,
        });
      }
    }
  }
  return edges;
}

/**
 * Derive the labelled edge set for the whole story. Nodes are visited in id-sorted
 * order (golden-rule "sort before iterate" determinism); within a node, body order is
 * preserved so edge order is stable and meaningful. Pure — never mutates the story.
 */
export function deriveFlowEdges(story: Story): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (const node of [...story.nodes].sort(byId)) edges.push(...nodeEdges(node));
  return edges;
}

/**
 * Registered counterpart of `deriveFlowEdges` — agent-native parity: the agent can
 * query the same labelled edges the human reads off the map, via the registry/CLI.
 */
export const flowEdgesTask: Task = {
  name: "flow-edges",
  kind: "understand",
  description:
    "Labelled node transitions (choice/jump/branch) with edge labels and conditional flags.",
  params: z.object({}),
  run: (story) => ok(deriveFlowEdges(story)),
};
