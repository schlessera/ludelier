import type { StoryNode } from "@ludelier/schema";
import { renderStatement } from "./script";

/**
 * Read-only screenplay rendering of a node's statements. Surfaces each statement's stable
 * id unobtrusively so the author can point the agent at an exact line. Read-only by design —
 * all edits go through the agent chat.
 */
export function ScriptLens({ node }: { node: StoryNode | null }): JSX.Element {
  if (!node) {
    return <div className="lens empty muted">Select a node to read its script.</div>;
  }
  return (
    <div className="lens">
      <h3>
        <code>{node.id}</code> <span className="muted">· {node.body.length} stmt</span>
      </h3>
      <ol className="script">
        {node.body.map((s, i) => (
          <li key={s.id ?? i} className={`stmt op-${s.op}`}>
            <pre className="line">{renderStatement(s)}</pre>
            {s.id && <span className="stmt-id muted">#{s.id}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
