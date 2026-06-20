import { z } from "zod";
import type { Story, StoryNode } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok } from "../result";
import { compareStr } from "../sort";

/** Outgoing node targets of a node: jump gotos + choice option gotos. */
function outgoing(node: StoryNode): string[] {
  const outs: string[] = [];
  for (const s of node.body) {
    if (s.op === "jump") outs.push(s.goto);
    if (s.op === "choice") for (const o of s.options) outs.push(o.goto);
  }
  return outs;
}

export interface GraphReport {
  entry: string;
  nodes: string[];
  edges: { from: string; to: string }[];
  reachable: string[];
  unreachable: string[];
  deadEnds: string[];
}

/**
 * Reachability + dead-end analysis. `reachable` is a forward BFS from `meta.start`;
 * `deadEnds` are nodes that cannot reach any `end` statement (computed by reverse BFS
 * from end-bearing nodes, which handles cycles correctly). All outputs sorted.
 */
export const graphTask: Task = {
  name: "graph",
  kind: "understand",
  description: "Story graph: reachability from the start node and dead-end detection.",
  params: z.object({}),
  run: (story) => ok(buildGraph(story)),
};

function buildGraph(story: Story): GraphReport {
  const byId = new Map(story.nodes.map((n) => [n.id, n] as const));

  // Edges (sorted by from, then to).
  const edges: { from: string; to: string }[] = [];
  for (const node of story.nodes) for (const to of outgoing(node)) edges.push({ from: node.id, to });
  edges.sort((a, b) => compareStr(a.from, b.from) || compareStr(a.to, b.to));

  // Forward reachability from the entry.
  const reachable = new Set<string>();
  const fwd: string[] = [story.meta.start];
  reachable.add(story.meta.start);
  while (fwd.length) {
    const node = byId.get(fwd.shift()!);
    if (!node) continue;
    for (const t of outgoing(node)) if (!reachable.has(t)) {
      reachable.add(t);
      fwd.push(t);
    }
  }

  // Reverse reachability to an end: start from end-bearing nodes, walk predecessors.
  const preds = new Map<string, string[]>();
  for (const node of story.nodes) for (const t of outgoing(node)) {
    const list = preds.get(t);
    if (list) list.push(node.id);
    else preds.set(t, [node.id]);
  }
  const canReachEnd = new Set<string>();
  const rev: string[] = [];
  for (const node of story.nodes) if (node.body.some((s) => s.op === "end")) {
    canReachEnd.add(node.id);
    rev.push(node.id);
  }
  while (rev.length) {
    const v = rev.shift()!;
    for (const u of preds.get(v) ?? []) if (!canReachEnd.has(u)) {
      canReachEnd.add(u);
      rev.push(u);
    }
  }

  const allIds = story.nodes.map((n) => n.id).sort(compareStr);
  return {
    entry: story.meta.start,
    nodes: allIds,
    edges,
    reachable: [...reachable].sort(compareStr),
    unreachable: allIds.filter((id) => !reachable.has(id)),
    deadEnds: allIds.filter((id) => !canReachEnd.has(id)),
  };
}
