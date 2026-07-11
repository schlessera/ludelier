import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AssetGenerationRequest,
  AssetGenerationResult,
  AssetProvider,
  AudioModelTarget,
} from "@ludelier/assets";
import { AssetNodeStore } from "@ludelier/assets-node";
import { validateStory } from "@ludelier/schema";
import { createWorld, EditLog } from "@ludelier/world";
import { createAssetHost, defaultAssetStoreRoots } from "../src/assets";
import { run } from "../src/index";

const story = {
  meta: { id: "story-1", title: "Asset test", start: "start" },
  characters: [{ id: "n", name: "N" }],
  assets: [],
  nodes: [{ id: "start", body: [{ op: "say", who: "n", text: "hi" }] }],
};

const request: AssetGenerationRequest = {
  kind: "audio",
  prompt: "Prompt that must never escape the host",
  role: "voice",
  outputFormat: "pcm",
  voice: "alloy",
};

const target: AudioModelTarget = {
  providerId: "fake-audio",
  modelId: "fake-audio-model",
  kind: "audio",
  endpoint: "https://fake-audio.example/v1",
  capabilities: { outputFormats: ["pcm"], voices: ["alloy"] },
};

const pcm = new Uint8Array([0, 1, 2, 3]);

function fakeProvider(
  result: AssetGenerationResult = {
    bytes: pcm,
    mimeType: "audio/pcm",
    extension: "pcm",
    createdAt: "2026-07-10T00:00:00.000Z",
    contentTypeValidated: true,
  },
): AssetProvider {
  return {
    id: "fake-audio",
    capabilities: { kinds: ["audio"] },
    targets: [target],
    generate: vi.fn(async () => result),
  };
}

function newLog(): EditLog {
  const parsed = validateStory(story);
  if (!parsed.success) throw new Error("fixture must validate");
  return new EditLog(createWorld(), parsed.data);
}

function destination(assetId: string): string {
  return `audio/${assetId}.pcm`;
}

function tempStore(): { root: string; store: AssetNodeStore } {
  const root = mkdtempSync(path.join(tmpdir(), "ludelier-cli-assets-"));
  return {
    root,
    store: new AssetNodeStore({
      publicRoot: path.join(root, "public"),
      provenanceRoot: path.join(root, "provenance"),
    }),
  };
}

describe("defaultAssetStoreRoots", () => {
  it("places root-relative Story URLs in the runtime public assets directory", () => {
    expect(defaultAssetStoreRoots("/workspace")).toEqual({
      publicRoot: "/workspace/packages/runtime-web/public/assets",
      provenanceRoot: "/workspace/.ludelier/asset-provenance",
    });
  });
});
describe("CLI asset host", () => {
  it("stores controlled public bytes and private provenance before atomically registering valid Story metadata", async () => {
    const { root, store } = tempStore();
    const provider = fakeProvider();
    const log = newLog();
    const storyPath = path.join(root, "story.json");
    try {
      const host = createAssetHost({
        store,
        providers: [provider],
        persist: (activeLog) => writeFileSync(storyPath, JSON.stringify(activeLog.currentStory())),
      });
      const result = await host.generate({
        log,
        runId: "test",
        id: "scene",
        destination: destination("scene"),
        request,
      });

      expect(result).toMatchObject({
        success: true,
        data: {
          status: "stored",
          asset: { id: "scene", src: "/assets/story-1/audio/scene.pcm", kind: "audio" },
        },
      });
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(validateStory(JSON.parse(readFileSync(storyPath, "utf8"))).success).toBe(true);
      expect(log.currentStory().assets).toEqual([
        { id: "scene", src: "/assets/story-1/audio/scene.pcm", kind: "audio", generated: true },
      ]);
      expect(existsSync(path.join(root, "public", "story-1", "audio", "scene.pcm"))).toBe(true);
      const sidecar = readFileSync(
        path.join(root, "provenance", "story-1", "audio", "scene.pcm.json"),
        "utf8",
      );
      expect(sidecar).not.toContain(request.prompt);
      expect(JSON.stringify(result)).not.toContain(request.prompt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats --log as reusable asset output after the Story has been rewritten", async () => {
    const { root } = tempStore();
    const storyPath = path.join(root, "story.json");
    const logPath = path.join(root, "asset.jsonl");
    const publicRoot = path.join(root, "public");
    const provenanceRoot = path.join(root, "provenance");
    const originalFetch = globalThis.fetch;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      writeFileSync(storyPath, JSON.stringify(story));
      process.env.OPENAI_API_KEY = "sk-test";
      delete process.env.OPENROUTER_API_KEY;
      globalThis.fetch = (async () =>
        new Response(new Uint8Array(pcm), {
          status: 200,
          headers: { "content-type": "audio/pcm" },
        })) as typeof fetch;
      const base = [
        "asset",
        "gen",
        "--story",
        storyPath,
        "--log",
        logPath,
        "--public-root",
        publicRoot,
        "--provenance-root",
        provenanceRoot,
        "--json",
        JSON.stringify(request),
      ];

      expect(await run([...base, "--id", "first", "--destination", destination("first")])).toBe(0);
      expect(await run([...base, "--id", "second", "--destination", destination("second")])).toBe(0);

      expect(
        JSON.parse(readFileSync(storyPath, "utf8")).assets.map((asset: { id: string }) => asset.id),
      ).toEqual(["first", "second"]);
    } finally {
      printed.mockRestore();
      globalThis.fetch = originalFetch;
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers a verified cache orphan without another provider call", async () => {
    const { root, store } = tempStore();
    const original = fakeProvider();
    const cached = fakeProvider();
    try {
      const first = createAssetHost({ store, providers: [original], persist: () => undefined });
      await first.generate({
        log: newLog(),
        runId: "first",
        id: "scene",
        destination: destination("scene"),
        request,
      });

      const log = newLog();
      const second = createAssetHost({ store, providers: [cached], persist: () => undefined });
      const result = await second.generate({
        log,
        runId: "second",
        id: "scene",
        destination: destination("scene"),
        request,
      });

      expect(result).toMatchObject({ success: true, data: { status: "cache-hit" } });
      expect(original.generate).toHaveBeenCalledTimes(1);
      expect(cached.generate).not.toHaveBeenCalled();
      expect(log.currentStory().assets[0]?.src).toBe("/assets/story-1/audio/scene.pcm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("force regenerates only a verified cache pair and reports the charge risk", async () => {
    const { root, store } = tempStore();
    const original = fakeProvider();
    const replacementBytes = new Uint8Array([8, 6, 7, 5]);
    const replacement = fakeProvider({
      bytes: replacementBytes,
      mimeType: "audio/pcm",
      extension: "pcm",
      createdAt: "2026-07-10T00:00:01.000Z",
      contentTypeValidated: true,
    });
    const cacheVerifier = fakeProvider();
    try {
      await createAssetHost({ store, providers: [original], persist: () => undefined }).generate({
        log: newLog(),
        runId: "seed",
        id: "seed",
        destination: destination("scene"),
        request,
      });

      const forced = await createAssetHost({
        store,
        providers: [replacement],
        persist: () => undefined,
      }).generate({
        log: newLog(),
        runId: "force",
        id: "scene",
        destination: destination("scene"),
        request,
        force: true,
      });
      const verified = await createAssetHost({
        store,
        providers: [cacheVerifier],
        persist: () => undefined,
      }).generate({
        log: newLog(),
        runId: "verify",
        id: "verify",
        destination: destination("scene"),
        request,
      });

      expect(forced).toMatchObject({ success: true, data: { status: "stored", mayHaveCharged: true } });
      expect(replacement.generate).toHaveBeenCalledTimes(1);
      expect(
        new Uint8Array(readFileSync(path.join(root, "public", "story-1", "audio", "scene.pcm"))),
      ).toEqual(replacementBytes);
      expect(verified).toMatchObject({ success: true, data: { status: "cache-hit", mayHaveCharged: false } });
      expect(cacheVerifier.generate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the verified cache pair when forced Story persistence fails", async () => {
    const { root, store } = tempStore();
    const original = fakeProvider();
    const replacement = fakeProvider({
      bytes: new Uint8Array([9, 9, 9, 9]),
      mimeType: "audio/pcm",
      extension: "pcm",
      createdAt: "2026-07-10T00:00:01.000Z",
      contentTypeValidated: true,
    });
    const verifier = fakeProvider();
    try {
      await createAssetHost({ store, providers: [original], persist: () => undefined }).generate({
        log: newLog(),
        runId: "seed",
        id: "seed",
        destination: destination("scene"),
        request,
      });

      const forced = await createAssetHost({
        store,
        providers: [replacement],
        persist: () => {
          throw new Error("Story write failed");
        },
      }).generate({
        log: newLog(),
        runId: "force",
        id: "scene",
        destination: destination("scene"),
        request,
        force: true,
      });
      const verified = await createAssetHost({
        store,
        providers: [verifier],
        persist: () => undefined,
      }).generate({
        log: newLog(),
        runId: "verify",
        id: "verify",
        destination: destination("scene"),
        request,
      });

      expect(forced).toMatchObject({
        success: false,
        issues: [{ path: "asset", message: expect.stringContaining("persistence-failed") }],
      });
      expect(
        new Uint8Array(readFileSync(path.join(root, "public", "story-1", "audio", "scene.pcm"))),
      ).toEqual(pcm);
      expect(verified).toMatchObject({ success: true, data: { status: "cache-hit" } });
      expect(verifier.generate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses force when another Story asset already references its controlled public URL", async () => {
    const { root, store } = tempStore();
    const provider = fakeProvider();
    const log = newLog();
    try {
      log.apply(
        "register-asset",
        { id: "other", src: "/assets/story-1/audio/scene.pcm", kind: "audio", generated: true },
        { runId: "fixture" },
      );

      const result = await createAssetHost({
        store,
        providers: [provider],
        persist: () => undefined,
      }).generate({
        log,
        runId: "force",
        id: "scene",
        destination: destination("scene"),
        request,
        force: true,
      });

      expect(result).toMatchObject({ success: false, issues: [{ path: "destination" }] });
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent generation transactions on one EditLog through persistence rollback", async () => {
    const { root, store } = tempStore();
    const provider = fakeProvider();
    const log = newLog();
    let announceFirstPersistence!: () => void;
    vi.spyOn(store, "prepareDestination").mockImplementation(async (nextDestination) => ({
      destination: { ...nextDestination },
      mediaPath: `/mock/media/${nextDestination.relativePath}`,
      provenancePath: `/mock/provenance/${nextDestination.relativePath}.json`,
      mediaDirectory: "/mock/media",
      provenanceDirectory: "/mock/provenance",
      publicUrl: `/assets/${nextDestination.storyId}/${nextDestination.relativePath}`,
    }));
    vi.spyOn(store, "lookupCache").mockResolvedValue({
      status: "miss",
      reason: "not-found",
      occupied: false,
    });
    vi.spyOn(store, "withDestinationReservation").mockImplementation(async (_paths, operation) =>
      operation(),
    );
    vi.spyOn(store, "stageAndCommit").mockResolvedValue();
    const firstPersistence = new Promise<void>((resolve) => {
      announceFirstPersistence = resolve;
    });
    let releaseFirstFailure!: () => void;
    const allowFirstFailure = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    let persistenceCalls = 0;
    const host = createAssetHost({
      store,
      providers: [provider],
      persist: async () => {
        persistenceCalls += 1;
        if (persistenceCalls !== 1) return;
        announceFirstPersistence();
        await allowFirstFailure;
        throw new Error("first Story write failed");
      },
    });
    try {
      const first = host.generate({
        log,
        runId: "first",
        id: "one",
        destination: destination("one"),
        request,
      });
      await firstPersistence;
      const second = host.generate({
        log,
        runId: "second",
        id: "two",
        destination: destination("two"),
        request,
      });

      for (let step = 0; step < 12; step += 1) await Promise.resolve();
      expect(log.currentStory().assets.map((asset) => asset.id)).toEqual(["one"]);
      releaseFirstFailure();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.success).toBe(false);
      expect(secondResult).toMatchObject({ success: true, data: { status: "stored" } });
      expect(log.currentStory().assets.map((asset) => asset.id)).toEqual(["two"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate metadata, malformed input, unverified force, and occupied destinations before provider dispatch", async () => {
    const { root, store } = tempStore();
    const provider = fakeProvider();
    try {
      const duplicateLog = newLog();
      duplicateLog.apply(
        "register-asset",
        { id: "scene", src: "/assets/story-1/old.pcm", kind: "audio", generated: true },
        { runId: "fixture" },
      );
      const host = createAssetHost({ store, providers: [provider], persist: () => undefined });
      const duplicate = await host.generate({
        log: duplicateLog,
        runId: "test",
        id: "scene",
        destination: destination("scene"),
        request,
        force: true,
      });
      const malformed = await host.generate({
        log: newLog(),
        runId: "test",
        id: "not/a-slug",
        destination: destination("scene"),
        request,
      });
      const forced = await host.generate({
        log: newLog(),
        runId: "test",
        id: "forced",
        destination: destination("forced"),
        request,
        force: true,
      });
      const paths = await store.prepareDestination(
        { storyId: "story-1", assetId: "occupied", relativePath: destination("occupied") },
        "pcm",
      );
      writeFileSync(paths.mediaPath, pcm);
      const occupied = await host.generate({
        log: newLog(),
        runId: "test",
        id: "occupied",
        destination: destination("occupied"),
        request,
        force: true,
      });

      expect(duplicate.success).toBe(false);
      expect(malformed.success).toBe(false);
      expect(forced).toMatchObject({ success: false, issues: [{ path: "force" }] });
      expect(occupied).toMatchObject({
        success: false,
        issues: [{ path: "asset", message: expect.stringContaining("destination-conflict") }],
      });
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists normal, orphaned, and corrupt controlled inventory without exposing private paths", async () => {
    const { root, store } = tempStore();
    const host = createAssetHost({ store, providers: [fakeProvider()], persist: () => undefined });
    try {
      await host.generate({
        log: newLog(),
        runId: "normal",
        id: "normal",
        destination: destination("normal"),
        request,
      });
      await host.generate({
        log: newLog(),
        runId: "sidecar",
        id: "sidecar",
        destination: destination("sidecar"),
        request,
      });
      unlinkSync(path.join(root, "public", "story-1", "audio", "sidecar.pcm"));

      const mediaOnly = await store.prepareDestination(
        { storyId: "story-1", assetId: "media", relativePath: destination("media") },
        "pcm",
      );
      writeFileSync(mediaOnly.mediaPath, pcm);
      const corrupt = await store.prepareDestination(
        { storyId: "story-1", assetId: "corrupt", relativePath: destination("corrupt") },
        "pcm",
      );
      writeFileSync(corrupt.mediaPath, pcm);
      writeFileSync(corrupt.provenancePath, "{");

      const result = await host.list("story-1");
      expect(result).toMatchObject({ success: true });
      if (!result.success) throw new Error("inventory should succeed");
      expect(result.data.map((entry) => [entry.src, entry.status])).toEqual(
        expect.arrayContaining([
          ["/assets/story-1/audio/normal.pcm", "valid"],
          ["/assets/story-1/audio/sidecar.pcm", "orphaned-sidecar"],
          ["/assets/story-1/audio/media.pcm", "orphaned-media"],
          ["/assets/story-1/audio/corrupt.pcm", "corrupt"],
        ]),
      );
      expect(JSON.stringify(result)).not.toContain(path.join(root, "provenance"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes human asset ls through the redacted Node inventory API", async () => {
    const { root, store } = tempStore();
    const storyPath = path.join(root, "story.json");
    const log = newLog();
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const generated = await createAssetHost({
        store,
        providers: [fakeProvider()],
        persist: (activeLog) => writeFileSync(storyPath, JSON.stringify(activeLog.currentStory())),
      }).generate({ log, runId: "fixture", id: "scene", destination: destination("scene"), request });
      expect(generated.success).toBe(true);

      expect(
        await run([
          "asset",
          "ls",
          "--story",
          storyPath,
          "--public-root",
          path.join(root, "public"),
          "--provenance-root",
          path.join(root, "provenance"),
        ]),
      ).toBe(0);
      const listed = JSON.parse(printed.mock.calls.map((call) => call[0]).join("\n")) as {
        src: string;
        status: string;
      }[];
      expect(listed).toEqual([
        {
          src: "/assets/story-1/audio/scene.pcm",
          status: "valid",
          extension: "pcm",
          byteSize: expect.any(Number),
          requestHash: expect.any(String),
          contentHash: expect.any(String),
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain(path.join(root, "provenance"));
    } finally {
      printed.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never points Story metadata at absent bytes when provider output or final persistence fails", async () => {
    const { root, store } = tempStore();
    const secret = "credential-never-returned";
    const invalidProvider = fakeProvider({
      bytes: new Uint8Array(),
      mimeType: "audio/pcm",
      extension: "pcm",
      createdAt: "2026-07-10T00:00:00.000Z",
      contentTypeValidated: true,
    });
    const invalidLog = newLog();
    const persistenceLog = newLog();
    try {
      const invalid = await createAssetHost({
        store,
        providers: [invalidProvider],
        persist: () => undefined,
      }).generate({
        log: invalidLog,
        runId: "invalid",
        id: "invalid",
        destination: destination("invalid"),
        request: { ...request, prompt: secret },
      });
      const persistence = await createAssetHost({
        store,
        providers: [fakeProvider()],
        persist: () => {
          throw new Error(`do not expose ${secret}`);
        },
      }).generate({
        log: persistenceLog,
        runId: "persist",
        id: "orphan",
        destination: destination("orphan"),
        request: { ...request, prompt: secret },
      });

      expect(invalid.success).toBe(false);
      expect(persistence.success).toBe(false);
      expect(invalidLog.currentStory().assets).toEqual([]);
      expect(persistenceLog.currentStory().assets).toEqual([]);
      expect(existsSync(path.join(root, "public", "story-1", "audio", "orphan.pcm"))).toBe(true);
      expect(existsSync(path.join(root, "provenance", "story-1", "audio", "orphan.pcm.json"))).toBe(true);
      expect(JSON.stringify([invalid, persistence])).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
