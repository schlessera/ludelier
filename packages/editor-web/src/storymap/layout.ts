import dagre from "@dagrejs/dagre";
import { compareStr } from "@ludelier/world";

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  nodeWidth: 168,
  nodeHeight: 48,
  rankSep: 64,
  nodeSep: 32,
};

/**
 * Compute node positions with a layered (Sugiyama) top-down layout via dagre. Pure and
 * deterministic: ids and edges are sorted before they reach dagre, so the result is stable and
 * independent of authored order, and positions are never persisted to the Story (the map derives
 * them fresh each render — R5). This is the single layout seam (R6): swapping dagre for another
 * engine later is a change confined to this function.
 */
export function layoutGraph(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
  options: LayoutOptions = {},
): PositionedNode[] {
  const o = { ...DEFAULTS, ...options };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: o.rankSep, nodesep: o.nodeSep });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = [...nodeIds].sort(compareStr);
  for (const id of ids) g.setNode(id, { width: o.nodeWidth, height: o.nodeHeight });

  // Defensive: only wire edges whose endpoints are real nodes. validateStory guarantees
  // gotos resolve, but the map must never throw on a transient mid-edit state.
  const known = new Set(ids);
  const sorted = [...edges].sort((a, b) => compareStr(a.from, b.from) || compareStr(a.to, b.to));
  for (const e of sorted) {
    if (known.has(e.from) && known.has(e.to)) g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  return ids.map((id) => {
    const n = g.node(id) as { x: number; y: number };
    // dagre returns node centres; React Flow positions are top-left corners.
    return { id, x: n.x - o.nodeWidth / 2, y: n.y - o.nodeHeight / 2 };
  });
}
