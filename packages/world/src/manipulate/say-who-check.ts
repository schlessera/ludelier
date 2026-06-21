import type { Story, Issue } from "@ludelier/schema";

/**
 * The one cross-reference `validateStory` does not perform (KTD-3): every `say.who`
 * must name a declared character. Reachable via the `add-character` + `append-say`
 * spine, so slice 1 layers this stricter check over `validateStory`. Variable and
 * sprite-slot coherence remain deferred (Scope → Deferred).
 */
export function sayWhoIssues(story: Story): Issue[] {
  const issues: Issue[] = [];
  const charIds = new Set(story.characters.map((c) => c.id));
  for (const node of story.nodes) {
    node.body.forEach((stmt, i) => {
      if (stmt.op === "say" && !charIds.has(stmt.who)) {
        issues.push({
          path: `nodes.${node.id}.body[${i}]`,
          message: `say references unknown character "${stmt.who}"`,
        });
      }
    });
  }
  return issues;
}
