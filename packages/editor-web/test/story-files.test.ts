import { describe, expect, it } from "vitest";
import { validateStory } from "@ludelier/schema";
import { Simulation } from "@ludelier/engine";
import { newStoryScaffold, parseStoryJson, serializeStory, storyFileName } from "../src/story/files";

describe("newStoryScaffold", () => {
  it("produces a valid story (validateStory, incl. cross-refs and say.who)", () => {
    const res = validateStory(newStoryScaffold());
    expect(res.success).toBe(true);
  });

  it("plays through to an ending", () => {
    const state = new Simulation(newStoryScaffold(), { seed: 1 }).run([{ type: "ADVANCE" }]);
    expect(state.done).toBe(true);
    expect(state.transcript.length).toBeGreaterThan(0);
  });

  it("round-trips through serialize + parse", () => {
    const story = newStoryScaffold();
    const res = parseStoryJson(serializeStory(story));
    expect(res).toEqual({ success: true, story });
  });
});

describe("parseStoryJson", () => {
  it("reports unparseable JSON as a (file) issue", () => {
    const res = parseStoryJson("{nope");
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.issues[0]?.path).toBe("(file)");
      expect(res.issues[0]?.message).toMatch(/not valid JSON/);
    }
  });

  it("reports a valid-JSON invalid story via validateStory issues", () => {
    const res = parseStoryJson(
      JSON.stringify({ meta: { id: "x", title: "X", start: "missing" }, nodes: [] }),
    );
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.length).toBeGreaterThan(0);
  });

  it("rejects a story whose start node does not exist (cross-ref check, not just shape)", () => {
    const bad = { ...newStoryScaffold(), meta: { id: "u", title: "U", start: "nope" } };
    expect(parseStoryJson(JSON.stringify(bad)).success).toBe(false);
  });

  it("parses a valid story and applies schema defaults", () => {
    const minimal = {
      meta: { id: "m", title: "M", start: "a" },
      nodes: [{ id: "a", body: [{ op: "end" }] }],
    };
    const res = parseStoryJson(JSON.stringify(minimal));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.story.characters).toEqual([]); // defaulted
      expect(res.story.assets).toEqual([]);
    }
  });
});

describe("storyFileName", () => {
  it("names the download after the story's meta id", () => {
    expect(storyFileName(newStoryScaffold())).toBe("untitled.story.json");
  });
});
