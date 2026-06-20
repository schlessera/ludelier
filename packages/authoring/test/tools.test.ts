import { describe, expect, it } from "vitest";
import { createWorld, EditLog } from "@ludelier/world";
import { validateStory, type Story } from "@ludelier/schema";
import { worldTools, dispatch } from "../src/tools";

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "end" }] }],
};

describe("worldTools", () => {
  it("emits one tool per manifest task, each carrying a JSON Schema", () => {
    const world = createWorld();
    const tools = worldTools(world);
    expect(tools.length).toBe(world.describe().length);
    expect(tools.every((t) => typeof t.parameters === "object" && t.parameters !== null)).toBe(true);
  });
});

describe("dispatch", () => {
  it("applies a manipulate tool call through the log, keeping the story valid", () => {
    const world = createWorld();
    const log = new EditLog(world, base);
    const res = dispatch(world, log, "r1", { id: "tc1", name: "create-node", arguments: { id: "b" } });
    expect(res.success).toBe(true);
    expect(log.recordsView()).toHaveLength(1);
    expect(validateStory(log.currentStory()).success).toBe(true);
    expect(log.currentStory().nodes.some((n) => n.id === "b")).toBe(true);
  });

  it("returns issues and leaves the log untouched on bad arguments", () => {
    const world = createWorld();
    const log = new EditLog(world, base);
    const res = dispatch(world, log, "r1", { id: "tc1", name: "create-node", arguments: { id: "bad id!" } });
    expect(res.success).toBe(false);
    expect(log.recordsView()).toHaveLength(0);
  });

  it("runs an understand tool without mutating the log", () => {
    const world = createWorld();
    const log = new EditLog(world, base);
    const res = dispatch(world, log, "r1", { id: "tc1", name: "graph", arguments: {} });
    expect(res.success).toBe(true);
    expect(log.recordsView()).toHaveLength(0);
  });

  it("rejects an unknown tool name", () => {
    const world = createWorld();
    const log = new EditLog(world, base);
    expect(dispatch(world, log, "r1", { id: "tc1", name: "frobnicate", arguments: {} }).success).toBe(false);
  });
});
