import type { Story, StoryNode } from "@ludelier/schema";

/**
 * Stable statement ids let edits target a statement by identity rather than by a fragile
 * position (which the agent routinely miscounts). Two id sources, kept in distinct namespaces
 * so they never collide:
 *
 * - **Authored / base statements** — `normalizeStatementIds` assigns `"<nodeId>#<index>"` to any
 *   statement that lacks an id when a story is first loaded into the edit log. Positional but
 *   stable: a statement keeps its id through later inserts/removes elsewhere.
 * - **Statements created by an edit** — the `EditLog` assigns `nextStatementId(seq)` = `"s<seq>"`
 *   (the edit record's seq), baked into the record so a refold reproduces it deterministically.
 *
 * `"s<seq>"` never contains `#`; `"<nodeId>#<i>"` always does — so the namespaces are disjoint.
 */
export function nextStatementId(seq: number): string {
  return `s${seq}`;
}

/** Fill any missing statement ids deterministically (positional, node-scoped). Pure. */
export function normalizeStatementIds(story: Story): Story {
  let changed = false;
  const nodes = story.nodes.map((node): StoryNode => {
    let nodeChanged = false;
    const body = node.body.map((stmt, i) => {
      if (stmt.id !== undefined) return stmt;
      nodeChanged = true;
      return { ...stmt, id: `${node.id}#${i}` };
    });
    if (!nodeChanged) return node;
    changed = true;
    return { ...node, body };
  });
  return changed ? { ...story, nodes } : story;
}
