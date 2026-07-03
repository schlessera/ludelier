import { validateStory } from "@ludelier/schema";
import type { Issue, Story } from "@ludelier/schema";

/**
 * Pure story open/save/new helpers — the file-shaped half of the editor's persistence.
 * DOM-free so they are unit-testable (golden rule 4); the toolbar wires them to file
 * inputs and Blob downloads.
 */

export type ParseStoryResult = { success: true; story: Story } | { success: false; issues: Issue[] };

/**
 * Parse + validate a `.story.json` file's text. Both failure modes (bad JSON, valid JSON
 * that isn't a valid Story) come back as the same issue list so the UI has one error path
 * — and an invalid file never replaces the current session.
 */
export function parseStoryJson(text: string): ParseStoryResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      success: false,
      issues: [{ path: "(file)", message: `not valid JSON: ${(e as Error).message}` }],
    };
  }
  const v = validateStory(raw);
  return v.success ? { success: true, story: v.data } : { success: false, issues: v.issues };
}

/** Canonical download name for a story — pairs with the Open filter (`.json`). */
export function storyFileName(story: Story): string {
  return `${story.meta.id}.story.json`;
}

/** Pretty-printed story JSON for download (trailing newline: friendly to diffs/editors). */
export function serializeStory(story: Story): string {
  return `${JSON.stringify(story, null, 2)}\n`;
}

/**
 * A minimal valid story for "New": one start node that says a line and ends, plus the
 * narrator it quotes (validateStory requires `say.who` to be declared). Kept tiny on
 * purpose — the point is a valid seed for the edit tasks (human forms or agent chat)
 * to grow, not a template.
 */
export function newStoryScaffold(): Story {
  return {
    meta: { id: "untitled", title: "Untitled story", start: "start", seed: 1 },
    characters: [{ id: "narrator", name: "Narrator" }],
    assets: [],
    nodes: [
      {
        id: "start",
        body: [{ op: "say", who: "narrator", text: "A new story begins." }, { op: "end" }],
      },
    ],
  };
}
