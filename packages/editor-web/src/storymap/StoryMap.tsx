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
  onPlay,
}: {
  snap: EditorSnapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Open the play preview from the current start / selected node. */
  onPlay: () => void;
}): JSX.Element {
  const { nodes, edges } = useMemo(() => buildStoryGraph(snap, selected), [snap, selected]);

  return (
    <section className="panel map">
      <div className="map-head">
        <h2>
          Story map{" "}
          <span className="muted">
            · {snap.story.meta.title} · {nodes.length} nodes · read-only
          </span>
        </h2>
        <button type="button" className="play-cta" onClick={onPlay} title="Play preview in an overlay">
          ▶ Play {selected ? `from ${selected}` : "from start"}
        </button>
      </div>
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
