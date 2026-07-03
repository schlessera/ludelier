import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StoryFlowNode } from "./model";

/** Custom React Flow node: the node id plus start / unreachable / dead-end badges. */
export function StoryNode({ data }: NodeProps<StoryFlowNode>): JSX.Element {
  const cls = [
    "map-node",
    data.isStart ? "is-start" : "",
    data.isUnreachable ? "is-unreachable" : "",
    data.isDeadEnd ? "is-deadend" : "",
    data.isSelected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} />
      <span className="map-node-id">{data.label}</span>
      {data.isStart && <span className="tag">start</span>}
      {data.isUnreachable && <span className="tag bad">unreachable</span>}
      {data.isDeadEnd && <span className="tag bad">dead end</span>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
