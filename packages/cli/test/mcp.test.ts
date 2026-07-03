import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateStory, type Issue } from "@ludelier/schema";
import { createWorld, EditLog, type Registry } from "@ludelier/world";
import { buildMcpServer, buildMcpTools, createPersister, type McpTool } from "../src/mcp";

const baseStory = {
  meta: { id: "t", title: "T", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  // node a has no terminal, so the add-statement tests don't orphan statements after an end.
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }] }],
};

let dir: string;
let storyPath: string;
let logPath: string;
let world: Registry;
let tools: McpTool[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ludelier-mcp-"));
  storyPath = join(dir, "s.json");
  logPath = join(dir, "l.jsonl");
  writeFileSync(storyPath, JSON.stringify(baseStory));
  world = createWorld();
  const base = validateStory(JSON.parse(readFileSync(storyPath, "utf8")));
  if (!base.success) throw new Error("base story invalid");
  const log = new EditLog(world, base.data);
  tools = buildMcpTools(world, log, { runId: "test", persist: createPersister(log, { storyPath, logPath }) });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tool(name: string): McpTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool "${name}" not built`);
  return found;
}

/** Parse the world `{success}` envelope back out of a tool result's text content. */
function envelope(res: CallToolResult): { success: boolean; data?: unknown; issues?: Issue[] } {
  const first = (res.content as { type: string; text: string }[])[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as { success: boolean; data?: unknown; issues?: Issue[] };
}

describe("buildMcpTools (registry parity)", () => {
  it("exposes every registry task with its registry kind, plus the two server-level extras", () => {
    const manifest = world.describe();
    for (const entry of manifest) {
      const t = tools.find((x) => x.name === entry.name);
      expect(t, entry.name).toBeDefined();
      expect(t!.kind).toBe(entry.kind);
    }
    const extras = tools
      .filter((t) => t.kind === "server")
      .map((t) => t.name)
      .sort();
    expect(extras).toEqual(["describe", "export-log"]);
    expect(tools).toHaveLength(manifest.length + 2);
    expect(tools.find((t) => t.name === "nosuchtask")).toBeUndefined();
  });
});

describe("understand tools", () => {
  it("returns the task's data in a success envelope", () => {
    const res = tool("graph").handler({});
    expect(res.isError).toBe(false);
    const env = envelope(res);
    expect(env.success).toBe(true);
    expect((env.data as { reachable: string[] }).reachable).toContain("a");
  });

  it("returns a fail envelope for invalid params instead of throwing", () => {
    const res = tool("get-node").handler({});
    expect(res.isError).toBe(true);
    const env = envelope(res);
    expect(env.success).toBe(false);
    expect(env.issues!.length).toBeGreaterThan(0);
  });
});

describe("manipulate tools", () => {
  it("persists the story file (revalidates) and rewrites the JSONL log on success", () => {
    const res = tool("add-statement").handler({
      nodeId: "a",
      statement: { op: "say", who: "n", text: "more" },
    });
    expect(res.isError).toBe(false);
    expect(envelope(res).success).toBe(true);
    const onDisk = JSON.parse(readFileSync(storyPath, "utf8")) as {
      nodes: { id: string; body: unknown[] }[];
    };
    expect(validateStory(onDisk).success).toBe(true);
    expect(onDisk.nodes.find((n) => n.id === "a")?.body).toHaveLength(2);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { runId: string }).runId).toBe("test");
  });

  it("returns a fail envelope for an invalid edit and writes nothing", () => {
    const before = readFileSync(storyPath, "utf8");
    const res = tool("add-statement").handler({ nodeId: "nope", statement: { op: "end" } });
    expect(res.isError).toBe(true);
    const env = envelope(res);
    expect(env.success).toBe(false);
    expect(env.issues!.length).toBeGreaterThan(0);
    expect(readFileSync(storyPath, "utf8")).toBe(before); // never rewritten, not even byte-wise
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("server-level tools", () => {
  it("describe returns the manifest; export-log tracks the live session", () => {
    const desc = envelope(tool("describe").handler({}));
    expect(desc.success).toBe(true);
    expect(desc.data).toEqual(world.describe());
    expect(envelope(tool("export-log").handler({})).data).toBe("");
    tool("add-statement").handler({ nodeId: "a", statement: { op: "end" } });
    const jsonl = envelope(tool("export-log").handler({})).data as string;
    expect(jsonl.trim().split("\n")).toHaveLength(1);
  });
});

describe("buildMcpServer (end-to-end, in-memory transport — no stdio)", () => {
  it("lists every tool, serves a call, and rejects an unknown tool as isError", async () => {
    const server = buildMcpServer(tools);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(tools.length);
      const ok = await client.callTool({ name: "graph", arguments: {} });
      expect(envelope(ok as CallToolResult).success).toBe(true);
      const unknown = await client.callTool({ name: "nosuchtask", arguments: {} });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
