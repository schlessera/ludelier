import { StoryObject, type Story } from "./story";

export interface Issue {
  path: string;
  message: string;
}

export type ValidateResult =
  | { success: true; data: Story }
  | { success: false; issues: Issue[] };

/** Cross-reference checks that a single-pass Zod schema cannot express. */
function crossRefIssues(story: Story): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();

  for (const node of story.nodes) {
    if (ids.has(node.id)) {
      issues.push({ path: "nodes", message: `duplicate node id: "${node.id}"` });
    }
    ids.add(node.id);
  }

  if (!ids.has(story.meta.start)) {
    issues.push({
      path: "meta.start",
      message: `start "${story.meta.start}" is not a known node`,
    });
  }

  const assetIds = new Set<string>();
  for (const asset of story.assets) {
    if (assetIds.has(asset.id)) {
      issues.push({ path: "assets", message: `duplicate asset id: "${asset.id}"` });
    }
    assetIds.add(asset.id);
  }

  // say.who must name a declared character. Previously a world-only check; folded in here
  // so authoring (generateStory) and the world's edit gate share one definition of valid.
  const charIds = new Set(story.characters.map((c) => c.id));

  // Statement ids are how edits target a statement by identity — duplicates make the target
  // ambiguous, so they are rejected story-wide. This also backstops every id-generation path:
  // any scheme that happens to collide is caught by the always-valid re-validate. Only present
  // ids are checked (the id is optional on authored input; the world fills gaps before editing).
  const stmtIds = new Set<string>();

  for (const node of story.nodes) {
    // A terminal statement (end / jump) ends the node; nothing may follow it (dead code).
    const term = node.body.findIndex((s) => s.op === "end" || s.op === "jump");
    if (term !== -1 && term < node.body.length - 1) {
      issues.push({
        path: `nodes.${node.id}.body[${term + 1}]`,
        message: `statement follows a terminal "${node.body[term]!.op}" in node "${node.id}" — nothing runs after it`,
      });
    }
    node.body.forEach((stmt, i) => {
      const at = `nodes.${node.id}.body[${i}]`;
      if (stmt.id !== undefined) {
        if (stmtIds.has(stmt.id)) {
          issues.push({ path: at, message: `duplicate statement id: "${stmt.id}"` });
        }
        stmtIds.add(stmt.id);
      }
      if (stmt.op === "say" && !charIds.has(stmt.who)) {
        issues.push({ path: at, message: `say references unknown character "${stmt.who}"` });
      }
      if (stmt.op === "jump" && !ids.has(stmt.goto)) {
        issues.push({ path: at, message: `jump to unknown node "${stmt.goto}"` });
      }
      if (stmt.op === "branch" && !ids.has(stmt.goto)) {
        issues.push({ path: at, message: `branch to unknown node "${stmt.goto}"` });
      }
      if (stmt.op === "choice") {
        stmt.options.forEach((opt, j) => {
          if (!ids.has(opt.goto)) {
            issues.push({
              path: `${at}.options[${j}]`,
              message: `choice goto unknown node "${opt.goto}"`,
            });
          }
        });
      }
      if (stmt.op === "scene" && stmt.bg !== undefined && !assetIds.has(stmt.bg)) {
        issues.push({ path: at, message: `scene bg references unknown asset "${stmt.bg}"` });
      }
      if (stmt.op === "show" && !assetIds.has(stmt.asset)) {
        issues.push({ path: at, message: `show references unknown asset "${stmt.asset}"` });
      }
    });
  }

  return issues;
}

/**
 * Validate raw data as a Story: Zod shape check, then cross-reference checks.
 * This is the single guardrail AI-generated content passes through.
 */
export function validateStory(data: unknown): ValidateResult {
  const res = StoryObject.safeParse(data);
  if (!res.success) {
    return {
      success: false,
      issues: res.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    };
  }
  const issues = crossRefIssues(res.data);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data: res.data };
}
