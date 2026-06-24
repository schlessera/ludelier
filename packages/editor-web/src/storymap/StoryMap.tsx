import { useMemo } from "react";
import { ReactFlow, Background, Controls, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EditorSnapshot } from "@ludelier/editor-core";
import { buildStoryGraph } from "./model";
import { StoryNode } from "./StoryNode";

// Defined at module scope so React Flow doesn't warn about a new nodeTypes object each render.
const nodeTypes = { story: StoryNode };
const defaultEdgeOptions = { markerEnd: { type: MarkerType.ArrowClosed } };

/**
 * Read-only structure map: auto-laid-out node boxes with badges, and labelled / conditional-
 * styled edges, re-derived from the snapshot on every render (so it tracks agent edits, undo,
 * redo, and revert — R11). Editing stays agent-only; clicking a node only selects it (drives the
 * script lens + play-from-here in the editor shell).
 */
export function StoryMap({
  snap,
  selected,
  onSelect,
}: {
  snap: EditorSnapshot;
  selected: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { nodes, edges } = useMemo(() => buildStoryGraph(snap, selected), [snap, selected]);

  return (
    <section className="panel map">
      <h2>
        Story map <span className="muted">· {nodes.length} nodes · read-only</span>
      </h2>
      <div className="storymap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodeClick={(_, node) => onSelect(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          colorMode="dark"
          fitView
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}
