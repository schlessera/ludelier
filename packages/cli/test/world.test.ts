import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStory } from "@ludelier/schema";
import { createWorld } from "@ludelier/world";
import { run } from "../src/index";

const baseStory = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] }],
};

let dir: string;
let storyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ludelier-cli-"));
  storyPath = join(dir, "s.json");
  writeFileSync(storyPath, JSON.stringify(baseStory));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("world subcommands", () => {
  it("world describe lists the registered tasks", async () => {
    const log = captureLog();
    expect(await run(["world", "describe"])).toBe(0);
    const manifest = JSON.parse(log.mock.calls.map((c) => c[0]).join("\n"));
    expect(Array.isArray(manifest) && manifest.length).toBeGreaterThan(0);
  });

  it("world query graph prints reachability JSON", async () => {
    const log = captureLog();
    expect(await run(["world", "query", "graph", "--story", storyPath])).toBe(0);
    const data = JSON.parse(log.mock.calls.map((c) => c[0]).join("\n"));
    expect(data.reachable).toContain("a");
  });

  it("world edit append-say writes a new story + a log record; reload validates", async () => {
    captureLog();
    const logPath = join(dir, "l.jsonl");
    const outPath = join(dir, "out.json");
    const code = await run([
      "world", "edit", "append-say",
      "--story", storyPath,
      "--json", JSON.stringify({ nodeId: "a", who: "n", text: "more" }),
      "--log", logPath,
      "-o", outPath,
    ]);
    expect(code).toBe(0);
    expect(validateStory(JSON.parse(readFileSync(outPath, "utf8"))).success).toBe(true);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("world undo after an edit restores the prior story", async () => {
    captureLog();
    const logPath = join(dir, "l.jsonl");
    await run(["world", "edit", "append-end", "--story", storyPath, "--json", JSON.stringify({ nodeId: "a" }), "--log", logPath]);
    const outPath = join(dir, "out.json");
    expect(await run(["world", "undo", "--story", storyPath, "--log", logPath, "-o", outPath])).toBe(0);
    const out = JSON.parse(readFileSync(outPath, "utf8"));
    expect(out.nodes.find((n: { id: string }) => n.id === "a").body).toHaveLength(2);
    expect(readFileSync(logPath, "utf8").trim()).toBe("");
  });
});

describe("author run", () => {
  it("exits non-zero with a BYOK message when no provider key is set", async () => {
    const savedO = process.env.OPENAI_API_KEY;
    const savedR = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await run(["author", "run", "make a story", "--story", storyPath]);
    expect(code).toBe(1);
    expect(err.mock.calls.map((c) => c[0]).join("\n")).toMatch(/OPENAI_API_KEY|BYOK/);
    if (savedO !== undefined) process.env.OPENAI_API_KEY = savedO;
    if (savedR !== undefined) process.env.OPENROUTER_API_KEY = savedR;
  });

  it("rejects a non-numeric --max-steps with exit 2 before any provider call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["author", "run", "x", "--story", storyPath, "--max-steps", "abc"])).toBe(2);
    expect(await run(["author", "run", "x", "--story", storyPath, "--max-steps", "0"])).toBe(2);
  });
});

describe("parity guard (CLI surface == registry)", () => {
  it("recognizes every world task via query/edit and rejects unknown ones", async () => {
    captureLog();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const t of createWorld().describe()) {
      const verb = t.kind === "understand" ? "query" : "edit";
      const code = await run(["world", verb, t.name, "--story", storyPath, "--json", "{}"]);
      // recognized → 0 (ran) or 1 (param/validation failure); never 2 (unknown)
      expect(code).not.toBe(2);
    }
    expect(await run(["world", "query", "nosuchtask", "--story", storyPath])).toBe(2);
  });
});
