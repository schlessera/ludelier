import type { Edge, Node } from "@xyflow/react";
import type { EditorSnapshot } from "@ludelier/editor-core";
import { deriveFlowEdges } from "@ludelier/world";
import { layoutGraph } from "./layout";

export type StoryNodeData = {
  label: string;
  isStart: boolean;
  isUnreachable: boolean;
  isDeadEnd: boolean;
  isSelected: boolean;
};

export type StoryFlowNode = Node<StoryNodeData, "story">;

export interface StoryGraphModel {
  nodes: StoryFlowNode[];
  edges: Edge[];
}

/**
 * Build the React Flow node/edge model for a snapshot. Pure (no React, no DOM, no @xyflow
 * runtime imports) so it is Vitest-testable: badges come from the snapshot's graph analysis
 * (R4 — never recomputed here), edges + labels + conditional styling come from the world's
 * `deriveFlowEdges` (R2/R3), and positions come from the layout adapter (R5). The component is a
 * thin renderer over this model.
 */
export function buildStoryGraph(snap: EditorSnapshot, selected: string | null): StoryGraphModel {
  const story = snap.story;
  const ids = story.nodes.map((n) => n.id);
  const flow = deriveFlowEdges(story);
  const positions = new Map(
    layoutGraph(
      ids,
      flow.map((e) => ({ from: e.from, to: e.to })),
    ).map((p) => [p.id, p] as const),
  );
  const unreachable = new Set(snap.graph.unreachable);
  const deadEnds = new Set(snap.graph.deadEnds);

  const nodes: StoryFlowNode[] = story.nodes.map((n) => {
    const pos = positions.get(n.id);
    return {
      id: n.id,
      type: "story",
      position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
      data: {
        label: n.id,
        isStart: n.id === story.meta.start,
        isUnreachable: unreachable.has(n.id),
        isDeadEnd: deadEnds.has(n.id),
        isSelected: n.id === selected,
      },
    };
  });

  const edges: Edge[] = flow.map((e, i) => ({
    id: `${e.from}->${e.to}#${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    className: e.conditional ? "edge-conditional" : "edge-plain",
    style: e.conditional ? { strokeDasharray: "6 4" } : undefined,
  }));

  return { nodes, edges };
}
