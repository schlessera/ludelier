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

  it("rejects say referencing an undeclared character (unified say.who check)", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a" },
      characters: [{ id: "mc", name: "MC" }],
      nodes: [{ id: "a", body: [{ op: "say", who: "ghost", text: "hi" }, { op: "end" }] }],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("accepts say for a declared character", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a" },
      characters: [{ id: "mc", name: "MC" }],
      nodes: [{ id: "a", body: [{ op: "say", who: "mc", text: "hi" }, { op: "end" }] }],
    });
    expect(res.success).toBe(true);
  });

  it("rejects duplicate statement ids", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a" },
      nodes: [
        { id: "a", body: [{ op: "jump", id: "dup", goto: "b" }] },
        { id: "b", body: [{ op: "end", id: "dup" }] },
      ],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.message.includes("duplicate statement id"))).toBe(true);
  });

  it("exports a JSON Schema object (Zod v4)", () => {
    const schema = storyJsonSchema() as { type?: string; properties?: unknown };
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });
});

describe("assets + scene/show/hide", () => {
  const base = {
    meta: { id: "x", title: "x", start: "a", seed: 1 },
    assets: [{ id: "bg", src: "/bg.png" }, { id: "her", src: "/her.png" }],
  };

  it("accepts scene/show/hide referencing declared assets", () => {
    const res = validateStory({
      ...base,
      nodes: [
        {
          id: "a",
          body: [
            { op: "scene", bg: "bg" },
            { op: "show", sprite: "her", asset: "her", at: "left" },
            { op: "hide", sprite: "her" },
            { op: "end" },
          ],
        },
      ],
    });
    expect(res.success).toBe(true);
  });

  it("defaults a show position to center", () => {
    const res = validateStory({
      ...base,
      nodes: [{ id: "a", body: [{ op: "show", sprite: "her", asset: "her" }, { op: "end" }] }],
    });
    expect(res.success).toBe(true);
    if (res.success) {
      const show = res.data.nodes[0]!.body[0]!;
      expect(show.op === "show" && show.at).toBe("center");
    }
  });

  it("rejects a scene bg referencing an unknown asset", () => {
    const res = validateStory({
      ...base,
      nodes: [{ id: "a", body: [{ op: "scene", bg: "missing" }, { op: "end" }] }],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.message.includes("missing"))).toBe(true);
  });

  it("rejects a show referencing an unknown asset", () => {
    const res = validateStory({
      ...base,
      nodes: [{ id: "a", body: [{ op: "show", sprite: "her", asset: "nope" }, { op: "end" }] }],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.message.includes("nope"))).toBe(true);
  });

  it("rejects duplicate asset ids", () => {
    const res = validateStory({
      meta: { id: "x", title: "x", start: "a", seed: 1 },
      assets: [{ id: "bg", src: "/a.png" }, { id: "bg", src: "/b.png" }],
      nodes: [{ id: "a", body: [{ op: "end" }] }],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.some((i) => i.message.includes("duplicate asset"))).toBe(true);
  });
});
