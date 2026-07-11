import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { hashAssetPrompt, hashAssetRequest, redactResolvedAssetRequest } from "@ludelier/assets";
import type { AssetProvenanceTarget, ResolvedAssetGenerationRequest } from "@ludelier/assets";
import {
  AssetNodeStore,
  persistBrowserGeneratedAsset,
  postProcessingRecipe,
  preflightBrowserGeneratedAsset,
} from "../src/index";
import type { BrowserGeneratedAssetPreflightInput } from "../src/index";

const createdAt = "2026-07-10T12:00:00.000Z";

const imageRequest: ResolvedAssetGenerationRequest = {
  target: {
    providerId: "openai",
    modelId: "gpt-image-2",
    kind: "image",
    endpoint: "https://API.OPENAI.COM/v1/images/generations/",
    capabilities: {
      outputFormats: ["png", "webp"],
      backgrounds: ["opaque"],
      sizes: [{ width: 24, height: 24 }],
      qualities: ["auto"],
    },
  },
  kind: "image",
  prompt: "Prompt that must never enter Vite ingress payloads or sidecars",
  role: "background",
  outputFormat: "webp",
  parameters: {
    background: "opaque",
    size: { width: 24, height: 24 },
    quality: "auto",
  },
};

const audioRequest: ResolvedAssetGenerationRequest = {
  target: {
    providerId: "openai",
    modelId: "gpt-4o-mini-tts",
    kind: "audio",
    endpoint: "https://API.OPENAI.COM/v1/audio/speech/",
    capabilities: {
      outputFormats: ["mp3"],
      voices: ["coral"],
      speed: { min: 0.25, max: 4 },
    },
  },
  kind: "audio",
  prompt: "Audio prompt that stays outside the ingress payload",
  role: "voice",
  outputFormat: "mp3",
  parameters: { voice: "coral", speed: 1 },
};

const openRouterRequest: ResolvedAssetGenerationRequest = {
  target: {
    providerId: "openrouter",
    modelId: "acme/illustrator",
    kind: "image",
    endpoint: "https://OPENROUTER.AI/api/v1/images/",
    capabilities: {
      outputFormats: ["png"],
      backgrounds: ["transparent"],
    },
  },
  kind: "image",
  prompt: "OpenRouter prompt kept before browser hash calculation",
  role: "sprite",
  outputFormat: "png",
  parameters: { background: "transparent" },
};

const destination = {
  storyId: "story-1",
  assetId: "asset-1",
  relativePath: "generated/asset.webp",
};

async function temporaryStore(): Promise<{ readonly root: string; readonly store: AssetNodeStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "ludelier-browser-ingress-"));
  return {
    root,
    store: new AssetNodeStore({
      publicRoot: path.join(root, "public"),
      provenanceRoot: path.join(root, "provenance"),
    }),
  };
}

async function browserInput(
  store: AssetNodeStore,
  resolved: ResolvedAssetGenerationRequest,
  nextDestination = destination,
): Promise<BrowserGeneratedAssetPreflightInput> {
  const target: AssetProvenanceTarget = {
    providerId: resolved.target.providerId,
    modelId: resolved.target.modelId,
    kind: resolved.target.kind,
    endpoint: resolved.target.endpoint,
  };
  return {
    store,
    target,
    request: redactResolvedAssetRequest(resolved),
    requestHash: await hashAssetRequest(resolved, postProcessingRecipe(resolved)),
    promptHash: await hashAssetPrompt(resolved.prompt),
    destination: nextDestination,
  };
}

async function fixtureImage(): Promise<Uint8Array> {
  return sharp({
    create: { width: 48, height: 24, channels: 3, background: { r: 30, g: 90, b: 190 } },
  })
    .png()
    .toBuffer();
}

function mp3Fixture(): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

describe("browser-generated asset ingress", () => {
  it("accepts and canonicalizes only fixed OpenAI and OpenRouter identities, including audio", async () => {
    const { root, store } = await temporaryStore();
    try {
      const audio = await preflightBrowserGeneratedAsset(
        await browserInput(store, audioRequest, {
          storyId: "story-1",
          assetId: "voice-1",
          relativePath: "generated/voice.mp3",
        }),
      );
      const openRouter = await preflightBrowserGeneratedAsset(
        await browserInput(store, openRouterRequest, {
          storyId: "story-1",
          assetId: "sprite-1",
          relativePath: "generated/sprite.png",
        }),
      );

      expect(audio).toMatchObject({
        status: "ready",
        preflight: { target: { endpoint: "https://api.openai.com/v1/audio/speech" } },
      });
      expect(openRouter).toMatchObject({
        status: "ready",
        preflight: { target: { endpoint: "https://openrouter.ai/api/v1/images" } },
      });

      if (audio.status !== "ready") throw new Error("Expected ready audio preflight");
      const persisted = await persistBrowserGeneratedAsset({
        preflight: audio.preflight,
        bytes: mp3Fixture(),
        metadata: { mimeType: "audio/mpeg", extension: "mp3", createdAt },
      });
      expect(persisted).toMatchObject({
        status: "stored",
        asset: { extension: "mp3", mimeType: "audio/mpeg" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects raw PCM browser ingress even when the client claims Content-Type validation", async () => {
    const { root, store } = await temporaryStore();
    const pcmRequest: ResolvedAssetGenerationRequest = {
      ...audioRequest,
      target: {
        ...audioRequest.target,
        capabilities: { ...audioRequest.target.capabilities, outputFormats: ["pcm"] },
      },
      outputFormat: "pcm",
    };
    try {
      const preflight = await preflightBrowserGeneratedAsset(
        await browserInput(store, pcmRequest, {
          storyId: "story-1",
          assetId: "voice-pcm",
          relativePath: "generated/voice.pcm",
        }),
      );

      expect(preflight).toMatchObject({
        status: "failed",
        failure: { code: "invalid-request", mayHaveCharged: false },
      });
      expect(await store.listInventory()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects prompt-bearing payloads, unsafe or unknown targets, malformed requests, and unsafe destinations before final files exist", async () => {
    const { root, store } = await temporaryStore();
    try {
      const input = await browserInput(store, imageRequest);
      const unsafe = await preflightBrowserGeneratedAsset({
        ...input,
        target: { ...input.target, endpoint: "https://user:secret@api.openai.com/v1/images/generations" },
      });
      const queried = await preflightBrowserGeneratedAsset({
        ...input,
        target: {
          ...input.target,
          endpoint: "https://api.openai.com/v1/images/generations?token=not-accepted",
        },
      });
      const unknown = await preflightBrowserGeneratedAsset({
        ...input,
        target: { ...input.target, endpoint: "https://assets.example.test/v1/images" },
      });
      const malformedRequest: unknown = {
        ...input.request,
        parameters: { ...input.request.parameters, sourceUrl: "https://not-accepted.test" },
      };
      const malformed = await preflightBrowserGeneratedAsset({
        ...input,
        request: malformedRequest as BrowserGeneratedAssetPreflightInput["request"],
      });
      const promptBearingInput: unknown = { ...input, prompt: imageRequest.prompt };
      const promptBearing = await preflightBrowserGeneratedAsset(
        promptBearingInput as BrowserGeneratedAssetPreflightInput,
      );
      const traversal = await preflightBrowserGeneratedAsset({
        ...input,
        destination: { ...input.destination, relativePath: "../asset.webp" },
      });

      expect(unsafe).toMatchObject({
        status: "failed",
        failure: { code: "invalid-request", mayHaveCharged: false },
      });
      expect(queried).toMatchObject({
        status: "failed",
        failure: { code: "invalid-request", mayHaveCharged: false },
      });
      expect(unknown).toMatchObject({
        status: "failed",
        failure: { code: "invalid-request", mayHaveCharged: false },
      });
      expect(malformed).toMatchObject({
        status: "failed",
        failure: { code: "invalid-request", mayHaveCharged: false },
      });
      expect(promptBearing).toMatchObject({
        status: "failed",
        failure: { code: "invalid-request", mayHaveCharged: false },
      });
      expect(traversal).toMatchObject({
        status: "failed",
        failure: { code: "invalid-path", mayHaveCharged: false },
      });
      expect(await store.listInventory()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a verified cache hit before a second byte persist and writes only prompt hashes to provenance", async () => {
    const { root, store } = await temporaryStore();
    const stage = vi.spyOn(store, "stageAndCommit");
    try {
      const input = await browserInput(store, imageRequest);
      const first = await preflightBrowserGeneratedAsset(input);
      if (first.status !== "ready") throw new Error("Expected ready image preflight");

      const persisted = await persistBrowserGeneratedAsset({
        preflight: first.preflight,
        bytes: await fixtureImage(),
        metadata: { mimeType: "image/png", extension: "png", createdAt },
      });
      const rechecked = await persistBrowserGeneratedAsset({
        preflight: first.preflight,
        bytes: new Uint8Array([0]),
        metadata: { mimeType: "image/png", extension: "png", createdAt },
      });
      const second = await preflightBrowserGeneratedAsset(input);
      const paths = await store.prepareDestination(destination, "webp");
      const sidecar = await readFile(paths.provenancePath, "utf8");
      await writeFile(paths.provenancePath, "{");
      const corrupt = await preflightBrowserGeneratedAsset(input);

      expect(persisted).toMatchObject({
        status: "stored",
        asset: { publicUrl: "/assets/story-1/generated/asset.webp" },
      });
      expect(second).toMatchObject({
        status: "cache-hit",
        asset: { publicUrl: "/assets/story-1/generated/asset.webp" },
      });
      expect(rechecked).toMatchObject({
        status: "cache-hit",
        asset: { publicUrl: "/assets/story-1/generated/asset.webp" },
      });
      expect(corrupt).toMatchObject({
        status: "failed",
        cache: "invalid-sidecar",
        failure: { code: "destination-conflict", mayHaveCharged: false },
      });
      expect(stage).toHaveBeenCalledTimes(1);
      expect(sidecar).toContain(input.promptHash);
      expect(sidecar).not.toContain(imageRequest.prompt);
      expect(JSON.stringify(first)).not.toContain(imageRequest.prompt);
      expect(JSON.stringify(persisted)).not.toContain(imageRequest.prompt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no final or staged files when image processing rejects browser bytes", async () => {
    const { root, store } = await temporaryStore();
    try {
      const input = await browserInput(store, imageRequest);
      const preflight = await preflightBrowserGeneratedAsset(input);
      if (preflight.status !== "ready") throw new Error("Expected ready image preflight");

      const result = await persistBrowserGeneratedAsset({
        preflight: preflight.preflight,
        bytes: new Uint8Array([0, 1, 2]),
        metadata: { mimeType: "image/png", extension: "png", createdAt },
      });
      const paths = await store.prepareDestination(destination, "webp");
      const entries = await readdir(paths.mediaDirectory);

      expect(result).toMatchObject({
        status: "failed",
        failure: { phase: "processing", code: "processing-failed", mayHaveCharged: true },
      });
      await expect(readFile(paths.mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(paths.provenancePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      expect(await store.listInventory()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
