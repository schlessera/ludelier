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

  for (const node of story.nodes) {
    node.body.forEach((stmt, i) => {
      const at = `nodes.${node.id}.body[${i}]`;
      if (stmt.op === "jump" && !ids.has(stmt.goto)) {
        issues.push({ path: at, message: `jump to unknown node "${stmt.goto}"` });
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
