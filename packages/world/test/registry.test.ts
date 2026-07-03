import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateStory, type Story } from "@ludelier/schema";
import { Registry, type Task } from "../src/registry";
import { ok, fail, parseParams } from "../src/result";
import { hashStory } from "../src/canonical";

const understandTask: Task = {
  name: "echo",
  kind: "understand",
  description: "echoes its params",
  params: z.object({ n: z.number() }),
  run: (_story, params) => ok(params),
};

const manipulateTask: Task = {
  name: "noop-edit",
  kind: "manipulate",
  description: "returns the story unchanged",
  params: z.object({}),
  apply: (story) => ok(story),
};

describe("Registry.describe", () => {
  it("returns a registered task with kind, description, and a JSON Schema object", () => {
    const r = new Registry();
    r.register(understandTask);
    const manifest = r.describe();
    expect(manifest).toHaveLength(1);
    const entry = manifest[0]!;
    expect(entry.name).toBe("echo");
    expect(entry.kind).toBe("understand");
    expect(entry.description).toBe("echoes its params");
    expect((entry.schema as { type?: string }).type).toBe("object");
  });

  it("lists tasks stably sorted by name", () => {
    const r = new Registry();
    r.register(manipulateTask);
    r.register(understandTask);
    expect(r.describe().map((e) => e.name)).toEqual(["echo", "noop-edit"]);
  });
});

describe("Registry.register guards", () => {
  it("rejects a duplicate task name", () => {
    const r = new Registry();
    r.register(understandTask);
    expect(() => r.register(understandTask)).toThrow(/duplicate task name/);
  });

  it("rejects a manipulate task that defines run() instead of apply()", () => {
    const r = new Registry();
    const bad: Task = { ...understandTask, name: "bad", kind: "manipulate" };
    expect(() => r.register(bad)).toThrow(/manipulate tasks must define apply/);
  });

  it("rejects an understand task that defines apply() instead of run()", () => {
    const r = new Registry();
    const bad: Task = { ...manipulateTask, name: "bad", kind: "understand" };
    expect(() => r.register(bad)).toThrow(/understand tasks must define run/);
  });
});

describe("result envelope", () => {
  it("surfaces Zod param failures via the result envelope without throwing", () => {
    const res = parseParams(understandTask.params, { n: "not-a-number" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues.length).toBeGreaterThan(0);
  });

  it("passes a failing validateStory result through unchanged ({success:false})", () => {
    // The world envelope IS schema's ValidateResult shape, so no translation is needed.
    const res = validateStory({
      meta: { id: "x", title: "x", start: "missing" },
      nodes: [{ id: "a", body: [] }],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const passthrough = fail<Story>(res.issues);
      expect(passthrough.success).toBe(false);
    }
  });
});

describe("hashStory canonical form", () => {
  const base: Story = {
    meta: { id: "s", title: "S", start: "a" },
    characters: [],
    assets: [],
    nodes: [{ id: "a", body: [{ op: "end" }] }],
  };

  it("is stable across different key-insertion orders", () => {
    const reordered = {
      nodes: [{ body: [{ op: "end" as const }], id: "a" }],
      assets: [],
      characters: [],
      meta: { start: "a", title: "S", id: "s" },
    } as Story;
    expect(hashStory(reordered)).toBe(hashStory(base));
  });

  it("equals across default materialization (omitted characters/assets and show.at)", () => {
    const omitted = {
      meta: { id: "s", title: "S", start: "a" },
      nodes: [{ id: "a", body: [{ op: "show", sprite: "h", asset: "h" }, { op: "end" }] }],
    } as unknown as Story;
    const materialized: Story = {
      meta: { id: "s", title: "S", start: "a" },
      characters: [],
      assets: [],
      nodes: [{ id: "a", body: [{ op: "show", sprite: "h", asset: "h", at: "center" }, { op: "end" }] }],
    };
    expect(hashStory(omitted)).toBe(hashStory(materialized));
  });
});
