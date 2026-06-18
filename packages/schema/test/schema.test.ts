import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStory, storyJsonSchema } from "../src/index";

function cafe(): unknown {
  return JSON.parse(
    readFileSync(new URL("../../../examples/cafe.story.json", import.meta.url), "utf8"),
  );
}

describe("validateStory", () => {
  it("accepts the example story", () => {
    const res = validateStory(cafe());
    expect(res.success).toBe(true);
  });

  it("rejects a bad statement shape", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [{ id: "a", body: [{ op: "say", who: "n" }] }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects a jump to an unknown node (cross-reference)", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [{ id: "a", body: [{ op: "jump", goto: "nowhere" }] }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.issues.some((i) => i.message.includes("nowhere"))).toBe(true);
    }
  });

  it("rejects a start that is not a node", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "ghost" },
      nodes: [{ id: "a", body: [{ op: "end" }] }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects duplicate node ids", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [{ op: "end" }] },
        { id: "a", body: [{ op: "end" }] },
      ],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.issues.some((i) => i.message.includes("duplicate"))).toBe(true);
    }
  });

  it("exports a JSON Schema object (Zod v4)", () => {
    const schema = storyJsonSchema() as { type?: string; properties?: unknown };
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });
});
