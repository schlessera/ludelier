import { describe, expect, it } from "vitest";
import { validateStory, type Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import { EditLog, importLog } from "../src/log";
import { applyEdit } from "../src/applyEdit";
import { hashStory } from "../src/canonical";

const world = createWorld();

const base: Story = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "end" }] }],
};

/** Apply a 3-command run under one runId, asserting each step succeeds. */
function applyRun(log: EditLog, runId: string): void {
  for (const [command, params] of [
    ["create-node", { id: "b" }],
    ["append-say", { nodeId: "b", who: "n", text: "hi" }],
    ["append-end", { nodeId: "b" }],
  ] as const) {
    const res = log.apply(command, params, { runId });
    if (!res.success) throw new Error("run step failed: " + JSON.stringify(res.issues));
  }
}

describe("EditLog fold", () => {
  it("currentStory equals folding the same commands directly", () => {
    const log = new EditLog(world, base);
    applyRun(log, "r1");

    let direct = base;
    direct = (applyEdit(world, direct, "create-node", { id: "b" }) as { success: true; data: Story }).data;
    direct = (applyEdit(world, direct, "append-say", { nodeId: "b", who: "n", text: "hi" }) as { success: true; data: Story }).data;
    direct = (applyEdit(world, direct, "append-end", { nodeId: "b" }) as { success: true; data: Story }).data;

    expect(hashStory(log.currentStory())).toBe(hashStory(direct));
  });
});

describe("undo / redo", () => {
  it("undo then redo returns the same story; undo past base is a no-op", () => {
    const log = new EditLog(world, base);
    applyRun(log, "r1");
    const tip = hashStory(log.currentStory());
    log.undo();
    log.redo();
    expect(hashStory(log.currentStory())).toBe(tip);

    const fresh = new EditLog(world, base);
    fresh.undo(); // no-op at base
    expect(hashStory(fresh.currentStory())).toBe(hashStory(base));
  });

  it("a new edit after undo discards the redo tail (linear-history)", () => {
    const log = new EditLog(world, base);
    applyRun(log, "r1"); // records: create-node b, append-say b, append-end b
    log.undo(); // drop append-end b from active history
    const after = log.apply("create-node", { id: "c" }, { runId: "r2" });
    expect(after.success).toBe(true);
    log.redo(); // no-op — the redo tail was discarded
    const story = log.currentStory();
    expect(story.nodes.some((n) => n.id === "c")).toBe(true);
    // append-end b was discarded, so node b has only the say
    expect(story.nodes.find((n) => n.id === "b")!.body.map((s) => s.op)).toEqual(["say"]);
  });
});

describe("revertRun", () => {
  it("drops exactly the run's records, restoring the pre-run state", () => {
    const log = new EditLog(world, base);
    const r0 = log.apply("create-node", { id: "z" }, { runId: "r0" });
    expect(r0.success).toBe(true);
    const preRun = hashStory(log.currentStory());
    applyRun(log, "r1");
    const res = log.revertRun("r1");
    expect(res.success).toBe(true);
    expect(hashStory(log.currentStory())).toBe(preRun);
  });

  it("fails when the run is not a contiguous tail", () => {
    const log = new EditLog(world, base);
    log.apply("create-node", { id: "x" }, { runId: "rA" });
    log.apply("create-node", { id: "y" }, { runId: "rB" });
    log.apply("create-node", { id: "z" }, { runId: "rA" }); // rA interleaved
    const res = log.revertRun("rA");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues[0]!.message).toMatch(/not a contiguous tail/);
  });
});

describe("rejected command", () => {
  it("leaves the log and currentStory unchanged and returns issues", () => {
    const log = new EditLog(world, base);
    applyRun(log, "r1");
    const before = hashStory(log.currentStory());
    const beforeLen = log.recordsView().length;
    const res = log.apply("append-say", { nodeId: "b", who: "ghost", text: "x" }, { runId: "r2" });
    expect(res.success).toBe(false);
    expect(log.recordsView().length).toBe(beforeLen);
    expect(hashStory(log.currentStory())).toBe(before);
  });
});

describe("replay determinism", () => {
  it("export then import reproduces an identical canonical Story and validity", () => {
    const log = new EditLog(world, base);
    applyRun(log, "r1");
    const jsonl = log.export();

    const imported = importLog(world, base, jsonl);
    expect(imported.success).toBe(true);
    if (imported.success) {
      const original = log.currentStory();
      const round = imported.data.currentStory();
      expect(hashStory(round)).toBe(hashStory(original));
      expect(validateStory(round).success).toBe(validateStory(original).success);
    }
  });
});
