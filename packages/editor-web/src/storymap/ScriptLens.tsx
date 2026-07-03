import { useEffect, useState } from "react";
import type { Statement, StoryNode } from "@ludelier/schema";
import type { EditorSession } from "@ludelier/editor-core";
import type { TaskManifestEntry } from "@ludelier/world";
import { renderStatement } from "./script";
import { TaskForm } from "../forms/TaskForm";

/** Which inline form is open: adding to the node, or editing one statement. */
type OpenForm = { kind: "add" } | { kind: "edit"; statementId: string } | null;

/**
 * Drop the statement's id before prefilling an update/add form — the tasks say to omit it
 * (update pins the id from `statementId`; add assigns a fresh one), and showing a generated
 * id invites the author to fight the id system.
 */
function withoutId(s: Statement): Statement {
  const { id: _id, ...rest } = s;
  return rest as Statement;
}

/**
 * Screenplay rendering of a node's statements — now with the human edit entry points
 * (parity payoff): per-statement update/remove and an add-statement form, all rendered
 * from the same manifest schemas the agent's tools use and applied through the same
 * `session.edit()` chokepoint (undo/redo just work). Statement ids stay visible so the
 * author can still point the agent at an exact line.
 */
export function ScriptLens({
  node,
  session,
  manifest,
}: {
  node: StoryNode | null;
  session: EditorSession;
  manifest: TaskManifestEntry[];
}): JSX.Element {
  const [open, setOpen] = useState<OpenForm>(null);
  const [err, setErr] = useState<string | null>(null);

  // Selecting another node (or losing the selection) closes any in-flight form — its
  // prefilled nodeId/statementId would silently target the previous node otherwise.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on node identity on purpose — a mere content edit must not close an open form
  useEffect(() => {
    setOpen(null);
    setErr(null);
  }, [node?.id]);

  if (!node) {
    return <div className="lens empty muted">Select a node to read its script.</div>;
  }

  const updateTask = manifest.find((t) => t.name === "update-statement");
  const addTask = manifest.find((t) => t.name === "add-statement");

  function removeStatement(statementId: string): void {
    if (!node) return;
    const res = session.edit("remove-statement", { nodeId: node.id, statementId });
    setErr(res.success ? null : res.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  }

  return (
    <div className="lens" data-testid="script-lens">
      <h3>
        <code>{node.id}</code> <span className="muted">· {node.body.length} stmt</span>
      </h3>
      {err && <p className="err">{err}</p>}
      <ol className="script">
        {node.body.map((s, i) => (
          <li key={s.id ?? i} className={`stmt op-${s.op}`}>
            <div className="stmt-row">
              <pre className="line">{renderStatement(s)}</pre>
              {s.id && <span className="stmt-id muted">#{s.id}</span>}
              {s.id && updateTask && (
                <span className="stmt-actions">
                  <button
                    type="button"
                    className="mini"
                    title="update-statement"
                    disabled={session.busy}
                    onClick={() =>
                      setOpen(
                        open?.kind === "edit" && open.statementId === s.id
                          ? null
                          : { kind: "edit", statementId: s.id! },
                      )
                    }
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    className="mini danger"
                    title="remove-statement"
                    disabled={session.busy}
                    onClick={() => removeStatement(s.id!)}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
            {open?.kind === "edit" && open.statementId === s.id && updateTask && (
              <TaskForm
                key={s.id}
                session={session}
                name={updateTask.name}
                schema={updateTask.schema}
                prefill={{ nodeId: node.id, statementId: s.id, statement: withoutId(s) }}
                submitLabel="Update statement"
                onDone={() => setOpen(null)}
              />
            )}
          </li>
        ))}
      </ol>
      {addTask && (
        <div className="lens-actions">
          <button
            type="button"
            disabled={session.busy}
            onClick={() => setOpen(open?.kind === "add" ? null : { kind: "add" })}
          >
            {open?.kind === "add" ? "Cancel" : "＋ Add statement"}
          </button>
          {open?.kind === "add" && (
            <TaskForm
              key={node.id}
              session={session}
              name={addTask.name}
              schema={addTask.schema}
              prefill={{ nodeId: node.id }}
              submitLabel="Add statement"
              onDone={() => setOpen(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
