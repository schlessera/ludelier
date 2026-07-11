import sharp from "sharp";
import { assetOutputMediaForFormat, openAiAssetProvider, resolveAssetTarget } from "@ludelier/assets";
import { describe, expect, it } from "vitest";
import type {
  AssetGenerationResult,
  ResolvedAudioGenerationRequest,
  ResolvedImageGenerationRequest,
} from "@ludelier/assets";
import { processGeneratedAsset, postProcessingRecipe } from "../src/index";

const backgroundRequest: ResolvedImageGenerationRequest = {
  target: {
    providerId: "fixture-images",
    modelId: "fixture-model",
    kind: "image",
    endpoint: "https://images.example/v1",
    capabilities: {
      outputFormats: ["png", "webp"],
      backgrounds: ["opaque", "transparent"],
      sizes: [{ width: 24, height: 24 }],
    },
  },
  kind: "image",
  prompt: "Never persisted fixture prompt",
  role: "background",
  outputFormat: "webp",
  parameters: { background: "opaque", size: { width: 24, height: 24 } },
};

function imageResult(bytes: Uint8Array, extension = "png", mimeType = "image/png"): AssetGenerationResult {
  return {
    bytes,
    extension,
    mimeType,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function mp3Fixture(): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

function wavFixture(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00,
    0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function opusFixture(): Uint8Array {
  const bytes = new Uint8Array(47);
  bytes.set([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02], 0);
  bytes[26] = 1;
  bytes[27] = 19;
  bytes.set(new TextEncoder().encode("OpusHead"), 28);
  bytes[36] = 1;
  bytes[37] = 1;
  return bytes;
}

function aacFixture(): Uint8Array {
  return new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0xe0, 0xfc]);
}

function flacFixture(): Uint8Array {
  const bytes = new Uint8Array(42);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
  return bytes;
}

describe("Node image processing", () => {
  it("cover-fits backgrounds to the requested stage, strips source orientation metadata, and identifies the recipe", async () => {
    const source = await sharp({
      create: { width: 80, height: 40, channels: 3, background: { r: 220, g: 70, b: 40 } },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();

    const processed = await processGeneratedAsset(backgroundRequest, imageResult(source));
    const metadata = await sharp(processed.bytes).metadata();

    expect(processed).toMatchObject({ mimeType: "image/webp", extension: "webp" });
    expect(metadata).toMatchObject({ format: "webp", width: 24, height: 24 });
    expect(metadata.orientation).toBeUndefined();
    expect(postProcessingRecipe(backgroundRequest)).toEqual({
      recipe: "ludelier.image.background-cover",
      version: 1,
      parameters: {
        width: 24,
        height: 24,
        fit: "cover",
        position: "centre",
        outputFormat: "webp",
      },
    });
  });

  it("preserves alpha while trimming transparent sprite margins", async () => {
    const opaqueSprite = await sharp({
      create: { width: 4, height: 6, channels: 4, background: { r: 20, g: 180, b: 250, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const source = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: opaqueSprite, left: 7, top: 5 }])
      .png()
      .toBuffer();
    const request: ResolvedImageGenerationRequest = {
      ...backgroundRequest,
      role: "sprite",
      outputFormat: "png",
      parameters: { background: "transparent", size: { width: 20, height: 20 } },
    };

    const processed = await processGeneratedAsset(request, imageResult(source));
    const metadata = await sharp(processed.bytes).metadata();

    expect(processed).toMatchObject({ mimeType: "image/png", extension: "png" });
    expect(metadata).toMatchObject({ format: "png", width: 4, height: 6, hasAlpha: true });
    expect(postProcessingRecipe(request)).toEqual({
      recipe: "ludelier.image.sprite-alpha-trim",
      version: 1,
      parameters: { alpha: "preserve", trim: "transparent-margin", outputFormat: "png" },
    });
  });

  it("rejects source MIME and extension conflicts before accepting provider bytes", async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();

    await expect(
      processGeneratedAsset(backgroundRequest, imageResult(source, "mp3", "audio/mpeg")),
    ).rejects.toMatchObject({ code: "invalid-output" });
  });

  it("keeps audio bytes unchanged while enforcing canonical MIME and extension metadata", async () => {
    const request: ResolvedAudioGenerationRequest = {
      target: {
        providerId: "fixture-audio",
        modelId: "fixture-audio-model",
        kind: "audio",
        endpoint: "https://audio.example/v1",
        capabilities: { outputFormats: ["mp3"] },
      },
      kind: "audio",
      prompt: "Audio fixture prompt",
      role: "music",
      outputFormat: "mp3",
      parameters: {},
    };
    const bytes = mp3Fixture();

    const processed = await processGeneratedAsset(request, {
      bytes,
      mimeType: "audio/mpeg",
      extension: "mp3",
      createdAt: "2026-07-10T00:00:00.000Z",
    });

    expect(processed).toEqual({ bytes, mimeType: "audio/mpeg", extension: "mp3" });
    expect(processed.bytes).toBe(bytes);
    expect(postProcessingRecipe(request)).toEqual({ recipe: "ludelier.audio.noop", version: 1 });
    await expect(
      processGeneratedAsset(request, {
        bytes,
        mimeType: "audio/wav",
        extension: "mp3",
        createdAt: "2026-07-10T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid-output" });
  });

  it("processes every direct OpenAI TTS output with the same canonical MIME metadata", async () => {
    const samples = [
      { format: "mp3", bytes: mp3Fixture() },
      { format: "wav", bytes: wavFixture() },
      { format: "opus", bytes: opusFixture() },
      { format: "aac", bytes: aacFixture() },
      { format: "flac", bytes: flacFixture() },
      { format: "pcm", bytes: new Uint8Array([1, 0, 2, 0]) },
    ] as const;

    for (const { format, bytes } of samples) {
      const expected = assetOutputMediaForFormat(format);
      if (expected === undefined) throw new Error(`Missing portable media for ${format}.`);
      const provider = openAiAssetProvider({
        apiKey: "sk-test-secret",
        fetchImpl: (async () =>
          new Response(bytes.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: { "content-type": expected.mimeType },
          })) as typeof fetch,
      });
      const request = resolveAssetTarget([provider], {
        kind: "audio",
        prompt: "Portable format matrix.",
        role: "voice",
        outputFormat: format,
      });

      const processed = await processGeneratedAsset(request, await provider.generate(request));
      expect(processed).toEqual({ bytes, mimeType: expected.mimeType, extension: expected.extension });
    }
  });

  it("rejects structurally truncated audio containers while accepting complete representative fixtures", async () => {
    const request: ResolvedAudioGenerationRequest = {
      target: {
        providerId: "fixture-audio",
        modelId: "fixture-audio-model",
        kind: "audio",
        endpoint: "https://audio.example/v1",
        capabilities: { outputFormats: ["mp3", "wav", "opus", "aac", "flac"] },
      },
      kind: "audio",
      prompt: "Audio fixture prompt",
      role: "music",
      outputFormat: "mp3",
      parameters: {},
    };
    const truncated = [
      { format: "mp3", bytes: mp3Fixture().subarray(0, 416) },
      { format: "wav", bytes: wavFixture().subarray(0, 45) },
      { format: "opus", bytes: opusFixture().subarray(0, 46) },
      { format: "aac", bytes: aacFixture().subarray(0, 6) },
      { format: "flac", bytes: flacFixture().subarray(0, 41) },
    ] as const;

    for (const { format, bytes } of truncated) {
      const expected = assetOutputMediaForFormat(format);
      if (expected === undefined) throw new Error(`Missing portable media for ${format}.`);
      await expect(
        processGeneratedAsset(
          { ...request, outputFormat: format },
          {
            bytes,
            mimeType: expected.mimeType,
            extension: expected.extension,
            createdAt: "2026-07-10T00:00:00.000Z",
          },
        ),
      ).rejects.toMatchObject({ code: "invalid-output" });
    }
  });

  it("rejects non-audio 2xx bodies and raw PCM without a provider Content-Type validation marker", async () => {
    const request: ResolvedAudioGenerationRequest = {
      target: {
        providerId: "fixture-audio",
        modelId: "fixture-audio-model",
        kind: "audio",
        endpoint: "https://audio.example/v1",
        capabilities: { outputFormats: ["mp3", "pcm"] },
      },
      kind: "audio",
      prompt: "Audio fixture prompt",
      role: "music",
      outputFormat: "mp3",
      parameters: {},
    };

    for (const bytes of [
      new TextEncoder().encode("<html><body>not audio</body></html>"),
      new TextEncoder().encode(JSON.stringify({ error: "not audio" })),
    ]) {
      await expect(
        processGeneratedAsset(request, {
          bytes,
          mimeType: "audio/mpeg",
          extension: "mp3",
          createdAt: "2026-07-10T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "invalid-output" });
    }

    await expect(
      processGeneratedAsset(
        { ...request, outputFormat: "pcm" },
        {
          bytes: new Uint8Array([1, 0, 2, 0]),
          mimeType: "audio/pcm",
          extension: "pcm",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-output" });
  });
});
