import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateStory, type Issue } from "@ludelier/schema";
import { createWorld, EditLog, type Registry } from "@ludelier/world";
import { buildMcpServer, buildMcpTools, createPersister, type McpTool } from "../src/mcp";
import type {
  AssetGenerationRequest,
  AssetGenerationResult,
  AssetProvider,
  AudioModelTarget,
} from "@ludelier/assets";
import { AssetNodeStore } from "@ludelier/assets-node";
import { createAssetHost } from "../src/assets";

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
let editLog: EditLog;
let tools: McpTool[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ludelier-mcp-"));
  storyPath = join(dir, "s.json");
  logPath = join(dir, "l.jsonl");
  writeFileSync(storyPath, JSON.stringify(baseStory));
  world = createWorld();
  const base = validateStory(JSON.parse(readFileSync(storyPath, "utf8")));
  if (!base.success) throw new Error("base story invalid");
  editLog = new EditLog(world, base.data);
  tools = buildMcpTools(world, editLog, {
    runId: "test",
    persist: createPersister(editLog, { storyPath, logPath }),
  });
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
  it("exposes every registry task with its registry kind, plus only the default server-level extras", () => {
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
  it("returns the task's data in a success envelope", async () => {
    const res = await tool("graph").handler({});
    expect(res.isError).toBe(false);
    const env = envelope(res);
    expect(env.success).toBe(true);
    expect((env.data as { reachable: string[] }).reachable).toContain("a");
  });

  it("returns a fail envelope for invalid params instead of throwing", async () => {
    const res = await tool("get-node").handler({});
    expect(res.isError).toBe(true);
    const env = envelope(res);
    expect(env.success).toBe(false);
    expect(env.issues!.length).toBeGreaterThan(0);
  });
});

describe("manipulate tools", () => {
  it("persists the story file (revalidates) and rewrites the JSONL log on success", async () => {
    const res = await tool("add-statement").handler({
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

  it("returns a fail envelope for an invalid edit and writes nothing", async () => {
    const before = readFileSync(storyPath, "utf8");
    const res = await tool("add-statement").handler({ nodeId: "nope", statement: { op: "end" } });
    expect(res.isError).toBe(true);
    const env = envelope(res);
    expect(env.success).toBe(false);
    expect(env.issues!.length).toBeGreaterThan(0);
    expect(readFileSync(storyPath, "utf8")).toBe(before); // never rewritten, not even byte-wise
    expect(existsSync(logPath)).toBe(false);
  });

  it("rolls back an in-memory edit and returns a redacted failure when persistence throws", async () => {
    const secret = "persist-error-secret-never-returned";
    const beforeStory = JSON.stringify(editLog.currentStory());
    const failingTools = buildMcpTools(world, editLog, {
      runId: "test",
      persist: () => {
        throw new Error(`persistence failed: ${secret}`);
      },
    });
    const add = failingTools.find((candidate) => candidate.name === "add-statement");
    if (!add) throw new Error("add-statement not built");

    const result = await add.handler({
      nodeId: "a",
      statement: { op: "say", who: "n", text: "must not remain live" },
    });

    expect(result.isError).toBe(true);
    expect(envelope(result)).toMatchObject({
      success: false,
      issues: [{ path: "persistence", message: "story changes could not be persisted" }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(editLog.currentStory())).toBe(beforeStory);
    expect(editLog.recordsView()).toHaveLength(0);
    expect(readFileSync(storyPath, "utf8")).toBe(JSON.stringify(baseStory));
    expect(existsSync(logPath)).toBe(false);
  });

  it("preserves existing persistence modes and creates new logs with mode 0600", async () => {
    const first = await tool("add-statement").handler({
      nodeId: "a",
      statement: { op: "say", who: "n", text: "first" },
    });
    expect(first.isError).toBe(false);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);

    chmodSync(storyPath, 0o666);
    chmodSync(logPath, 0o606);
    const second = await tool("add-statement").handler({
      nodeId: "a",
      statement: { op: "say", who: "n", text: "second" },
    });
    expect(second.isError).toBe(false);
    expect(statSync(storyPath).mode & 0o777).toBe(0o666);
    expect(statSync(logPath).mode & 0o777).toBe(0o606);
  });

  it("serializes a failed asset registration before an interleaved world mutation", async () => {
    const target: AudioModelTarget = {
      providerId: "fake-audio",
      modelId: "fake-audio-model",
      kind: "audio",
      endpoint: "https://fake-audio.example/v1",
      capabilities: { outputFormats: ["pcm"], voices: ["alloy"] },
    };
    const provider: AssetProvider = {
      id: "fake-audio",
      capabilities: { kinds: ["audio"] },
      targets: [target],
      generate: async (): Promise<AssetGenerationResult> => ({
        bytes: new Uint8Array([0, 1, 2, 3]),
        mimeType: "audio/pcm",
        extension: "pcm",
        createdAt: "2026-07-10T00:00:00.000Z",
        contentTypeValidated: true,
      }),
    };
    let assetPersistStarted!: () => void;
    const assetPersisting = new Promise<void>((resolve) => {
      assetPersistStarted = resolve;
    });
    let rejectAssetPersist!: (reason?: unknown) => void;
    const host = createAssetHost({
      store: new AssetNodeStore({
        publicRoot: join(dir, "public"),
        provenanceRoot: join(dir, "provenance"),
      }),
      providers: [provider],
      persist: () => {
        assetPersistStarted();
        return new Promise<void>((_, reject) => {
          rejectAssetPersist = reject;
        });
      },
    });
    const interleavedTools = buildMcpTools(world, editLog, {
      runId: "test",
      persist: createPersister(editLog, { storyPath, logPath }),
      assetHost: host,
    });
    const generate = interleavedTools.find((candidate) => candidate.name === "generate-asset");
    const add = interleavedTools.find((candidate) => candidate.name === "add-statement");
    if (!generate || !add) throw new Error("interleaving tools not built");

    const generation = Promise.resolve(
      generate.handler({
        id: "scene",
        destination: "audio/scene.pcm",
        request: {
          kind: "audio",
          prompt: "prompt must not persist after failure",
          role: "voice",
          outputFormat: "pcm",
          voice: "alloy",
        },
      }),
    );
    await assetPersisting;
    const mutation = Promise.resolve(
      add.handler({
        nodeId: "a",
        statement: { op: "say", who: "n", text: "the surviving edit" },
      }),
    );
    rejectAssetPersist(new Error("asset persistence failed"));
    const [generationResult, mutationResult] = await Promise.all([generation, mutation]);

    expect(generationResult.isError).toBe(true);
    expect(mutationResult.isError).toBe(false);
    expect(editLog.currentStory().assets).toEqual([]);
    expect(editLog.recordsView()).toHaveLength(1);
    expect(editLog.recordsView()[0]?.command).toBe("add-statement");
    const onDisk = JSON.parse(readFileSync(storyPath, "utf8")) as {
      assets: unknown[];
      nodes: { id: string; body: unknown[] }[];
    };
    expect(onDisk.assets).toEqual([]);
    expect(onDisk.nodes.find((node) => node.id === "a")?.body).toHaveLength(2);
  });
});

describe("server-level tools", () => {
  it("describe returns the manifest; export-log tracks the live session", async () => {
    const desc = envelope(await tool("describe").handler({}));
    expect(desc.success).toBe(true);
    expect(desc.data).toEqual(world.describe());
    expect(envelope(await tool("export-log").handler({})).data).toBe("");
    await tool("add-statement").handler({ nodeId: "a", statement: { op: "end" } });
    const jsonl = envelope(await tool("export-log").handler({})).data as string;
    expect(jsonl.trim().split("\n")).toHaveLength(1);
  });

  it("exposes a redacted read-only asset inventory without authorizing paid generation", async () => {
    const publicRoot = join(dir, "public");
    const provenanceRoot = join(dir, "provenance");
    const secret = "asset-inventory-prompt-never-returned";
    const target: AudioModelTarget = {
      providerId: "fake-audio",
      modelId: "fake-audio-model",
      kind: "audio",
      endpoint: "https://fake-audio.example/v1",
      capabilities: { outputFormats: ["pcm"], voices: ["alloy"] },
    };
    const provider: AssetProvider = {
      id: "fake-audio",
      capabilities: { kinds: ["audio"] },
      targets: [target],
      generate: async (): Promise<AssetGenerationResult> => ({
        bytes: new Uint8Array([0, 1, 2, 3]),
        mimeType: "audio/pcm",
        extension: "pcm",
        createdAt: "2026-07-10T00:00:00.000Z",
        contentTypeValidated: true,
      }),
    };
    const store = new AssetNodeStore({ publicRoot, provenanceRoot });
    const host = createAssetHost({ store, providers: [provider], persist: () => undefined });
    const request: AssetGenerationRequest = {
      kind: "audio",
      prompt: secret,
      role: "voice",
      outputFormat: "pcm",
      voice: "alloy",
    };
    const fixtureLog = new EditLog(world, editLog.currentStory());
    const normal = await host.generate({
      log: fixtureLog,
      runId: "fixture",
      id: "normal",
      destination: "audio/normal.pcm",
      request,
    });
    const sidecar = await host.generate({
      log: fixtureLog,
      runId: "fixture",
      id: "sidecar",
      destination: "audio/sidecar.pcm",
      request,
    });
    expect(normal.success).toBe(true);
    expect(sidecar.success).toBe(true);
    unlinkSync(join(publicRoot, "t", "audio", "sidecar.pcm"));

    const mediaOnly = await store.prepareDestination(
      { storyId: "t", assetId: "media", relativePath: "audio/media.pcm" },
      "pcm",
    );
    writeFileSync(mediaOnly.mediaPath, new Uint8Array([0, 1, 2, 3]));
    const corrupt = await store.prepareDestination(
      { storyId: "t", assetId: "corrupt", relativePath: "audio/corrupt.pcm" },
      "pcm",
    );
    writeFileSync(corrupt.mediaPath, new Uint8Array([0, 1, 2, 3]));
    writeFileSync(corrupt.provenancePath, "{");

    const inventoryTools = buildMcpTools(world, editLog, {
      runId: "test",
      persist: createPersister(editLog, { storyPath, logPath }),
      assetInventoryHost: host,
    });
    expect(inventoryTools.find((candidate) => candidate.name === "generate-asset")).toBeUndefined();
    const inventoryTool = inventoryTools.find((candidate) => candidate.name === "list-asset-inventory");
    expect(inventoryTools.find((candidate) => candidate.name === "list-assets")?.kind).toBe("understand");
    expect(inventoryTool).toBeDefined();

    const beforeStory = JSON.stringify(editLog.currentStory());
    const beforeLog = editLog.export();
    const server = buildMcpServer(inventoryTools);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "asset-inventory-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const advertised = await client.listTools();
      expect(
        advertised.tools.find((candidate) => candidate.name === "list-asset-inventory")?.annotations,
      ).toMatchObject({ readOnlyHint: true });

      const result = (await client.callTool({
        name: "list-asset-inventory",
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBe(false);
      const listed = envelope(result).data as { src: string; status: string }[];
      expect(listed.map((entry) => [entry.src, entry.status])).toEqual(
        expect.arrayContaining([
          ["/assets/t/audio/normal.pcm", "valid"],
          ["/assets/t/audio/sidecar.pcm", "orphaned-sidecar"],
          ["/assets/t/audio/media.pcm", "orphaned-media"],
          ["/assets/t/audio/corrupt.pcm", "corrupt"],
        ]),
      );
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(publicRoot);
      expect(JSON.stringify(result)).not.toContain(provenanceRoot);
      expect(JSON.stringify(editLog.currentStory())).toBe(beforeStory);
      expect(editLog.export()).toBe(beforeLog);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("omits generation by default and exposes the authorized shared asset host with a redacted result", async () => {
    expect(tools.find((candidate) => candidate.name === "generate-asset")).toBeUndefined();
    const target: AudioModelTarget = {
      providerId: "fake-audio",
      modelId: "fake-audio-model",
      kind: "audio",
      endpoint: "https://fake-audio.example/v1",
      capabilities: { outputFormats: ["pcm"], voices: ["alloy"] },
    };
    const secret = "asset-secret-never-returned";
    const provider: AssetProvider = {
      id: "fake-audio",
      capabilities: { kinds: ["audio"] },
      targets: [target],
      generate: async (): Promise<AssetGenerationResult> => ({
        bytes: new Uint8Array([0, 1, 2, 3]),
        mimeType: "audio/pcm",
        extension: "pcm",
        createdAt: "2026-07-10T00:00:00.000Z",
        contentTypeValidated: true,
      }),
    };
    const host = createAssetHost({
      store: new AssetNodeStore({
        publicRoot: join(dir, "public"),
        provenanceRoot: join(dir, "provenance"),
      }),
      providers: [provider],
      persist: (activeLog) => createPersister(activeLog, { storyPath, logPath })(),
    });
    const authorized = buildMcpTools(world, editLog, {
      runId: "test",
      persist: createPersister(editLog, { storyPath, logPath }),
      assetHost: host,
    });
    expect(authorized.find((candidate) => candidate.name === "generate-asset")).toBeDefined();
    const server = buildMcpServer(authorized);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "asset-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({
        name: "generate-asset",
        arguments: {
          id: "scene",
          destination: "audio/scene.pcm",
          request: {
            kind: "audio",
            prompt: secret,
            role: "voice",
            outputFormat: "pcm",
            voice: "alloy",
          },
        },
      })) as CallToolResult;

      expect(result.isError).toBe(false);
      expect(envelope(result)).toMatchObject({
        success: true,
        data: { asset: { id: "scene", src: "/assets/t/audio/scene.pcm", kind: "audio" } },
      });
      expect(validateStory(JSON.parse(readFileSync(storyPath, "utf8"))).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await client.close();
      await server.close();
    }
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
