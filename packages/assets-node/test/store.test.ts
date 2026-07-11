import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { hashAssetRequest, resolveAssetTarget } from "@ludelier/assets";
import type {
  AssetGenerationRequest,
  AssetGenerationResult,
  AssetProvider,
  ImageModelTarget,
} from "@ludelier/assets";
import {
  AssetNodeStore,
  generateAndStoreAsset,
  postProcessingRecipe,
  preflightAssetGeneration,
} from "../src/index";
import type { AssetNodeGenerationResult } from "../src/index";

const request: AssetGenerationRequest = {
  kind: "image",
  prompt: "Fixture prompt that must not reach disk",
  role: "background",
  outputFormat: "webp",
  size: { width: 24, height: 24 },
};

const destination = {
  storyId: "story-1",
  assetId: "scene-1",
  relativePath: "backgrounds/scene.webp",
};

const target: ImageModelTarget = {
  providerId: "fixtures",
  modelId: "fixture-image-model",
  kind: "image",
  endpoint: "https://fixtures.example/v1",
  capabilities: {
    outputFormats: ["png", "webp"],
    backgrounds: ["opaque"],
    sizes: [{ width: 24, height: 24 }],
  },
};

async function fixtureImage(): Promise<Uint8Array> {
  return sharp({
    create: { width: 48, height: 24, channels: 3, background: { r: 30, g: 90, b: 190 } },
  })
    .png()
    .toBuffer();
}

function fakeProvider(bytes: Uint8Array, beforeResult?: () => Promise<void>): AssetProvider {
  return {
    id: "fixtures",
    capabilities: { kinds: ["image"] },
    targets: [target],
    generate: vi.fn(async (): Promise<AssetGenerationResult> => {
      await beforeResult?.();
      return {
        bytes,
        mimeType: "image/png",
        extension: "png",
        createdAt: "2026-07-10T00:00:00.000Z",
      };
    }),
  };
}

async function temporaryStore(): Promise<{ readonly root: string; readonly store: AssetNodeStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "ludelier-assets-node-"));
  return {
    root,
    store: new AssetNodeStore({
      publicRoot: path.join(root, "public"),
      provenanceRoot: path.join(root, "provenance"),
    }),
  };
}

describe("Node asset store", () => {
  it("rejects traversal, extension conflicts, and occupied destinations before fake providers run", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    const provider = fakeProvider(bytes);
    try {
      const traversal = await generateAndStoreAsset({
        store,
        providers: [provider],
        request,
        destination: { ...destination, relativePath: "../scene.webp" },
      });
      const wrongExtension = await generateAndStoreAsset({
        store,
        providers: [provider],
        request,
        destination: { ...destination, relativePath: "backgrounds/scene.png" },
      });
      const paths = await store.prepareDestination(destination, "webp");
      await writeFile(paths.mediaPath, "existing controlled media");
      const conflict = await generateAndStoreAsset({ store, providers: [provider], request, destination });

      expect(traversal).toMatchObject({ status: "failed", failure: { code: "invalid-path" } });
      expect(wrongExtension).toMatchObject({ status: "failed", failure: { code: "invalid-path" } });
      expect(conflict).toMatchObject({ status: "failed", failure: { code: "destination-conflict" } });
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses a byte-verified cache entry without invoking a second provider and writes redacted private provenance", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    const original = fakeProvider(bytes);
    const neverCalled = fakeProvider(bytes);
    try {
      const first = await generateAndStoreAsset({ store, providers: [original], request, destination });
      const second = await generateAndStoreAsset({ store, providers: [neverCalled], request, destination });
      const paths = await store.prepareDestination(destination, "webp");
      const persistedSidecar = await readFile(paths.provenancePath, "utf8");

      expect(first).toMatchObject({
        status: "stored",
        asset: { publicUrl: "/assets/story-1/backgrounds/scene.webp" },
      });
      expect(second).toMatchObject({
        status: "cache-hit",
        asset: { publicUrl: "/assets/story-1/backgrounds/scene.webp" },
      });
      expect(original.generate).toHaveBeenCalledTimes(1);
      expect(neverCalled.generate).not.toHaveBeenCalled();
      expect(persistedSidecar).not.toContain(request.prompt);
      expect(paths.provenancePath).toContain(`${path.sep}provenance${path.sep}`);
      expect(paths.provenancePath).not.toContain(`${path.sep}public${path.sep}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes same-destination paid generation and lets the waiter recheck as a cache hit", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    let announceProviderStart!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      announceProviderStart = resolve;
    });
    let releaseProvider!: () => void;
    const providerMayFinish = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = fakeProvider(bytes, async () => {
      announceProviderStart();
      await providerMayFinish;
    });
    const samePublicDestination = { ...destination, assetId: "scene-duplicate" };
    try {
      const first = generateAndStoreAsset({ store, providers: [provider], request, destination });
      await providerStarted;
      const second = generateAndStoreAsset({
        store,
        providers: [provider],
        request,
        destination: samePublicDestination,
      });
      releaseProvider();

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({ status: "stored" });
      expect(secondResult).toMatchObject({ status: "cache-hit" });
      expect(provider.generate).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not serialize independent destinations behind one paid-generation lease", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    let started = 0;
    let announceBothStarts!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      announceBothStarts = resolve;
    });
    let releaseProviders!: () => void;
    const providersMayFinish = new Promise<void>((resolve) => {
      releaseProviders = resolve;
    });
    const provider = fakeProvider(bytes, async () => {
      started += 1;
      if (started === 2) announceBothStarts();
      await providersMayFinish;
    });
    const otherDestination = {
      ...destination,
      assetId: "scene-2",
      relativePath: "backgrounds/scene-2.webp",
    };
    try {
      const first = generateAndStoreAsset({ store, providers: [provider], request, destination });
      const second = generateAndStoreAsset({
        store,
        providers: [provider],
        request,
        destination: otherDestination,
      });
      await bothStarted;
      releaseProviders();

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({ status: "stored" });
      expect(secondResult).toMatchObject({ status: "stored" });
      expect(provider.generate).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports corrupt and content-mismatched cache data as recoverable occupied misses without overwriting bytes", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    const original = fakeProvider(bytes);
    const replacement = fakeProvider(bytes);
    try {
      await generateAndStoreAsset({ store, providers: [original], request, destination });
      const paths = await store.prepareDestination(destination, "webp");
      await writeFile(paths.provenancePath, "{");
      const corrupt = await preflightAssetGeneration({
        store,
        providers: [replacement],
        request,
        destination,
      });
      await generateAndStoreAsset({
        store,
        providers: [original],
        request,
        destination: { ...destination, assetId: "scene-2", relativePath: "backgrounds/second.webp" },
      });
      const secondPaths = await store.prepareDestination(
        { ...destination, assetId: "scene-2", relativePath: "backgrounds/second.webp" },
        "webp",
      );
      await writeFile(secondPaths.mediaPath, "tampered final bytes");
      const resolved = resolveAssetTarget([replacement], request);
      const postProcessing = postProcessingRecipe(resolved);
      const mismatch = await store.lookupCache(
        secondPaths,
        resolved,
        await hashAssetRequest(resolved, postProcessing),
        postProcessing,
      );

      expect(corrupt).toMatchObject({
        status: "failed",
        cache: "invalid-sidecar",
        failure: { code: "destination-conflict" },
      });
      expect(replacement.generate).not.toHaveBeenCalled();
      expect(mismatch).toMatchObject({ status: "miss", reason: "content-mismatch", occupied: true });
      expect(await readFile(secondPaths.mediaPath, "utf8")).toBe("tampered final bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves competing bytes and retains a detectable provenance orphan after no-replace publication conflicts", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    const paths = await store.prepareDestination(destination, "webp");
    const provider = fakeProvider(bytes, async () => writeFile(paths.mediaPath, "racing writer"));
    try {
      const result = await generateAndStoreAsset({ store, providers: [provider], request, destination });
      const temporaryEntries = (await readdir(paths.mediaDirectory)).filter((entry) =>
        entry.endsWith(".tmp"),
      );

      expect(result).toMatchObject({ status: "failed", failure: { phase: "write", code: "write-failed" } });
      expect(temporaryEntries).toEqual([]);
      expect(await readFile(paths.mediaPath, "utf8")).toBe("racing writer");
      expect(JSON.parse(await readFile(paths.provenancePath, "utf8"))).toMatchObject({
        requestHash: expect.any(String),
      });
      await rm(paths.mediaPath);
      expect(await store.listInventory()).toMatchObject([
        {
          storyId: destination.storyId,
          relativePath: destination.relativePath,
          status: "orphaned-provenance",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans owned partial temporary files after parallel normal and forced staging writes fail", async () => {
    const { root, store } = await temporaryStore();
    const bytes = await fixtureImage();
    const normalDestination = { ...destination, assetId: "normal", relativePath: "backgrounds/normal.webp" };
    const forcedDestination = { ...destination, assetId: "forced", relativePath: "backgrounds/forced.webp" };
    try {
      const normalPaths = await store.prepareDestination(normalDestination, "webp");
      await chmod(normalPaths.provenanceDirectory, 0o500);
      let normal: AssetNodeGenerationResult;
      try {
        normal = await generateAndStoreAsset({
          store,
          providers: [fakeProvider(bytes)],
          request,
          destination: normalDestination,
        });
      } finally {
        await chmod(normalPaths.provenanceDirectory, 0o700);
      }

      await generateAndStoreAsset({
        store,
        providers: [fakeProvider(bytes)],
        request,
        destination: forcedDestination,
      });
      const forcedPaths = await store.prepareDestination(forcedDestination, "webp");
      await chmod(forcedPaths.provenanceDirectory, 0o500);
      let forced: AssetNodeGenerationResult;
      try {
        forced = await generateAndStoreAsset({
          store,
          providers: [fakeProvider(bytes)],
          request,
          destination: forcedDestination,
          force: true,
        });
      } finally {
        await chmod(forcedPaths.provenanceDirectory, 0o700);
      }

      expect(normal).toMatchObject({ status: "failed", failure: { phase: "write", code: "write-failed" } });
      expect(forced).toMatchObject({ status: "failed", failure: { phase: "write", code: "write-failed" } });
      expect((await readdir(normalPaths.mediaDirectory)).filter((entry) => entry.endsWith(".tmp"))).toEqual(
        [],
      );
      expect((await readdir(forcedPaths.mediaDirectory)).filter((entry) => entry.endsWith(".tmp"))).toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns inspectable orphan data when caller-owned final persistence fails", async () => {
    const { root, store } = await temporaryStore();
    const provider = fakeProvider(await fixtureImage());
    try {
      const result = await generateAndStoreAsset({
        store,
        providers: [provider],
        request,
        destination,
        persist: async () => {
          throw new Error("Story transaction failed");
        },
      });

      expect(result).toMatchObject({
        status: "orphaned",
        orphan: {
          reason: "persistence-failed",
          asset: { publicUrl: "/assets/story-1/backgrounds/scene.webp" },
        },
      });
      if (result.status === "orphaned") {
        const media = await readFile(path.join(root, "public", "story-1", "backgrounds", "scene.webp"));
        expect(media.byteLength).toBeGreaterThan(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked destination directories that resolve outside controlled roots before provider dispatch", async () => {
    const { root, store } = await temporaryStore();
    const provider = fakeProvider(await fixtureImage());
    try {
      const publicRoot = path.join(root, "public");
      await store.prepareDestination(destination, "webp");
      await mkdir(path.join(root, "outside"));
      await rm(path.join(publicRoot, destination.storyId), { recursive: true });
      await symlink(path.join(root, "outside"), path.join(publicRoot, destination.storyId));

      const result = await preflightAssetGeneration({ store, providers: [provider], request, destination });

      expect(result).toMatchObject({ status: "failed", failure: { code: "invalid-path" } });
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a crash-left reservation after proving its owner identity is stale", async () => {
    const { root, store } = await temporaryStore();
    const provider = fakeProvider(await fixtureImage());
    const lockName = `${createHash("sha256")
      .update(destination.storyId)
      .update("\u0000")
      .update(destination.relativePath)
      .digest("hex")}.lock`;
    try {
      await mkdir(path.join(root, "provenance", ".locks"), { recursive: true });
      await writeFile(
        path.join(root, "provenance", ".locks", lockName),
        JSON.stringify({ version: 1, host: hostname(), pid: process.pid, processStartTicks: "0" }),
      );

      const result = await generateAndStoreAsset({ store, providers: [provider], request, destination });

      expect(result).toMatchObject({ status: "stored" });
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(await store.listInventory()).toMatchObject([
        { storyId: destination.storyId, relativePath: destination.relativePath, status: "valid" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never treats a just-published malformed legacy lock as stale while its creator could be live", async () => {
    const { root, store } = await temporaryStore();
    const provider = fakeProvider(await fixtureImage());
    const lockName = `${createHash("sha256")
      .update(destination.storyId)
      .update("\u0000")
      .update(destination.relativePath)
      .digest("hex")}.lock`;
    try {
      await mkdir(path.join(root, "provenance", ".locks"), { recursive: true });
      await writeFile(path.join(root, "provenance", ".locks", lockName), "");

      const result = await generateAndStoreAsset({ store, providers: [provider], request, destination });

      expect(result).toMatchObject({
        status: "failed",
        failure: { phase: "preflight", code: "write-failed", mayHaveCharged: false },
      });
      expect(provider.generate).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists a sorted redacted inventory without following unsafe entries", async () => {
    const { root, store } = await temporaryStore();
    const provider = fakeProvider(await fixtureImage());
    const mediaOnly = { ...destination, assetId: "media-only", relativePath: "backgrounds/media-only.webp" };
    const provenanceOnly = {
      ...destination,
      assetId: "provenance-only",
      relativePath: "backgrounds/provenance-only.webp",
    };
    const invalid = { ...destination, assetId: "invalid", relativePath: "backgrounds/invalid.webp" };
    const mismatched = { ...destination, assetId: "mismatched", relativePath: "backgrounds/mismatched.webp" };
    const unsafe = { ...destination, assetId: "unsafe", relativePath: "backgrounds/unsafe.webp" };
    try {
      await generateAndStoreAsset({ store, providers: [provider], request, destination });
      const mediaOnlyPaths = await store.prepareDestination(mediaOnly, "webp");
      await writeFile(mediaOnlyPaths.mediaPath, "media-only");

      await generateAndStoreAsset({ store, providers: [provider], request, destination: provenanceOnly });
      const provenanceOnlyPaths = await store.prepareDestination(provenanceOnly, "webp");
      await rm(provenanceOnlyPaths.mediaPath);

      await generateAndStoreAsset({ store, providers: [provider], request, destination: invalid });
      const invalidPaths = await store.prepareDestination(invalid, "webp");
      await writeFile(
        invalidPaths.provenancePath,
        JSON.stringify({ prompt: request.prompt, apiKey: "private" }),
      );

      await generateAndStoreAsset({ store, providers: [provider], request, destination: mismatched });
      const mismatchedPaths = await store.prepareDestination(mismatched, "webp");
      await writeFile(mismatchedPaths.mediaPath, "mismatched-media");

      const unsafePaths = await store.prepareDestination(unsafe, "webp");
      const outside = path.join(root, "outside-media");
      await writeFile(outside, "host-private-media");
      await symlink(outside, unsafePaths.mediaPath);
      await writeFile(path.join(root, "public", "story-1", "bad name.webp"), "ignored");
      await mkdir(path.join(root, "provenance", ".locks"), { recursive: true });
      await writeFile(path.join(root, "provenance", ".locks", "opaque.lock"), "private reservation");
      await writeFile(
        path.join(mediaOnlyPaths.mediaDirectory, ".media-only.webp.interrupted.tmp"),
        "private stage",
      );

      const inventory = await store.listInventory();
      const records = new Map(inventory.map((record) => [record.relativePath, record]));

      expect(inventory.map((record) => `${record.storyId}/${record.relativePath}`)).toEqual([
        "story-1/backgrounds/invalid.webp",
        "story-1/backgrounds/media-only.webp",
        "story-1/backgrounds/mismatched.webp",
        "story-1/backgrounds/provenance-only.webp",
        "story-1/backgrounds/scene.webp",
        "story-1/backgrounds/unsafe.webp",
      ]);
      expect(records.get("backgrounds/scene.webp")).toMatchObject({
        status: "valid",
        publicUrl: "/assets/story-1/backgrounds/scene.webp",
        extension: "webp",
      });
      expect(records.get("backgrounds/media-only.webp")).toMatchObject({ status: "orphaned-media" });
      expect(records.get("backgrounds/provenance-only.webp")).toMatchObject({
        status: "orphaned-provenance",
      });
      expect(records.get("backgrounds/invalid.webp")).toMatchObject({ status: "invalid" });
      expect(records.get("backgrounds/mismatched.webp")).toMatchObject({ status: "invalid" });
      expect(records.get("backgrounds/unsafe.webp")).toMatchObject({ status: "unsafe" });
      expect(records.has("bad name.webp")).toBe(false);

      const serialized = JSON.stringify(inventory);
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain(outside);
      expect(serialized).not.toContain(request.prompt);
      expect(serialized).not.toContain("apiKey");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
