import { describe, expect, it, vi } from "vitest";
import {
  AssetError,
  resolveAssetTarget,
  sanitizeEndpointIdentity,
  selectAssetPostProcessingRecipe,
} from "../src/index";
import type {
  AssetProvider,
  AudioModelTarget,
  ImageModelTarget,
  ImageTargetCapabilities,
} from "../src/index";

const opaqueImageCapabilities: ImageTargetCapabilities = {
  outputFormats: ["png", "jpeg", "webp"],
  backgrounds: ["opaque"],
  sizes: [{ width: 1024, height: 1024 }],
  supportsSeed: false,
  qualities: ["standard"],
};

const transparentImageCapabilities: ImageTargetCapabilities = {
  outputFormats: ["png", "webp"],
  backgrounds: ["opaque", "transparent"],
  sizes: [{ width: 1024, height: 1024 }],
  supportsSeed: true,
  qualities: ["standard", "high"],
};

function imageTarget(
  providerId: string,
  modelId: string,
  capabilities: ImageTargetCapabilities,
  deprecated = false,
): ImageModelTarget {
  return {
    providerId,
    modelId,
    kind: "image",
    endpoint: `https://${providerId}.example/v1`,
    capabilities,
    ...(deprecated ? { deprecated: true } : {}),
  };
}

function audioTarget(providerId: string, modelId: string): AudioModelTarget {
  return {
    providerId,
    modelId,
    kind: "audio",
    endpoint: `https://${providerId}.example/v1`,
    capabilities: {
      outputFormats: ["mp3", "wav"],
      voices: ["alloy"],
      speed: { min: 0.5, max: 2 },
    },
  };
}

function provider(id: string, targets: readonly (ImageModelTarget | AudioModelTarget)[]): AssetProvider {
  return {
    id,
    capabilities: { kinds: [...new Set(targets.map((target) => target.kind))] },
    targets,
    generate: vi.fn(async () => ({
      bytes: new Uint8Array(),
      mimeType: "image/png",
      extension: "png",
      createdAt: "2026-07-10T00:00:00.000Z",
    })),
  };
}

function expectError(action: () => unknown, code: AssetError["code"]): void {
  try {
    action();
    throw new Error("Expected an AssetError.");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetError);
    if (error instanceof AssetError) expect(error.code).toBe(code);
  }
}

describe("resolveAssetTarget", () => {
  it("uses the first compatible target in configured provider order", () => {
    const opaque = provider("opaque", [imageTarget("opaque", "opaque-model", opaqueImageCapabilities)]);
    const alpha = provider("alpha", [imageTarget("alpha", "alpha-model", transparentImageCapabilities)]);

    const opaqueResult = resolveAssetTarget([opaque, alpha], {
      kind: "image",
      prompt: "A lighthouse at dusk",
      role: "background",
      outputFormat: "webp",
    });
    const transparentResult = resolveAssetTarget([opaque, alpha], {
      kind: "image",
      prompt: "A glass icon",
      role: "sprite",
      outputFormat: "png",
      background: "transparent",
    });

    expect(opaqueResult.target).toMatchObject({ providerId: "opaque", modelId: "opaque-model" });
    expect(transparentResult.target).toMatchObject({ providerId: "alpha", modelId: "alpha-model" });
    expect(transparentResult.kind === "image" && transparentResult.parameters.background).toBe("transparent");
  });

  it("fails explicit incompatible provider/model overrides without invoking a provider", () => {
    const configured = provider("opaque", [imageTarget("opaque", "opaque-model", opaqueImageCapabilities)]);

    expectError(
      () =>
        resolveAssetTarget([configured], {
          kind: "image",
          providerId: "opaque",
          modelId: "opaque-model",
          prompt: "A transparent icon",
          role: "sprite",
          outputFormat: "png",
          background: "transparent",
        }),
      "unsupported-capability",
    );
    expect(configured.generate).not.toHaveBeenCalled();
  });

  it("rejects alpha JPEG and unsupported seed or size before a provider call", () => {
    const configured = provider("images", [imageTarget("images", "image-model", opaqueImageCapabilities)]);

    expectError(
      () =>
        resolveAssetTarget([configured], {
          kind: "image",
          prompt: "A transparent icon",
          role: "sprite",
          outputFormat: "jpeg",
          background: "transparent",
        }),
      "unsupported-capability",
    );
    expectError(
      () =>
        resolveAssetTarget([configured], {
          kind: "image",
          prompt: "Seeded illustration",
          role: "background",
          outputFormat: "png",
          seed: 7,
        }),
      "no-compatible-target",
    );
    expectError(
      () =>
        resolveAssetTarget([configured], {
          kind: "image",
          prompt: "Oversized illustration",
          role: "background",
          outputFormat: "png",
          size: { width: 2048, height: 2048 },
        }),
      "no-compatible-target",
    );
    expect(configured.generate).not.toHaveBeenCalled();
  });

  it("rejects unsupported audio voice before a provider call", () => {
    const configured = provider("audio", [audioTarget("audio", "tts-model")]);

    expectError(
      () =>
        resolveAssetTarget([configured], {
          kind: "audio",
          prompt: "Welcome to the story.",
          role: "voice",
          outputFormat: "mp3",
          voice: "unsupported",
        }),
      "no-compatible-target",
    );
    expect(configured.generate).not.toHaveBeenCalled();
  });

  it("never chooses a deprecated target as an automatic default", () => {
    const configured = provider("images", [
      imageTarget("images", "legacy-model", opaqueImageCapabilities, true),
      imageTarget("images", "current-model", opaqueImageCapabilities),
    ]);

    const resolved = resolveAssetTarget([configured], {
      kind: "image",
      prompt: "An opaque scene",
      role: "background",
      outputFormat: "png",
    });

    expect(resolved.target.modelId).toBe("current-model");
  });

  it("selects the shared complete post-processing recipe from resolved output fields", () => {
    const background = resolveAssetTarget(
      [
        provider("image", [
          {
            ...imageTarget("image", "background-model", opaqueImageCapabilities),
            defaultParameters: { background: "opaque", size: { width: 1024, height: 1024 } },
          },
        ]),
      ],
      {
        kind: "image",
        prompt: "A landscape",
        role: "background",
        outputFormat: "webp",
      },
    );
    const sprite = resolveAssetTarget(
      [provider("sprite", [imageTarget("sprite", "sprite-model", transparentImageCapabilities)])],
      {
        kind: "image",
        prompt: "A glass icon",
        role: "sprite",
        outputFormat: "png",
        background: "transparent",
      },
    );
    const audio = resolveAssetTarget([provider("audio", [audioTarget("audio", "tts-model")])], {
      kind: "audio",
      prompt: "Welcome.",
      role: "voice",
      outputFormat: "mp3",
    });

    expect(selectAssetPostProcessingRecipe(background)).toEqual({
      recipe: "ludelier.image.background-cover",
      version: 1,
      parameters: { width: 1024, height: 1024, fit: "cover", position: "centre", outputFormat: "webp" },
    });
    expect(selectAssetPostProcessingRecipe(sprite)).toEqual({
      recipe: "ludelier.image.sprite-alpha-trim",
      version: 1,
      parameters: { alpha: "preserve", trim: "transparent-margin", outputFormat: "png" },
    });
    expect(selectAssetPostProcessingRecipe(audio)).toEqual({ recipe: "ludelier.audio.noop", version: 1 });

    if (background.kind !== "image" || sprite.kind !== "image") throw new Error("Expected image requests.");
    expectError(
      () =>
        selectAssetPostProcessingRecipe({
          ...background,
          parameters: { ...background.parameters, size: undefined },
        }),
      "invalid-request",
    );
    expectError(
      () => selectAssetPostProcessingRecipe({ ...sprite, outputFormat: "jpeg" }),
      "unsupported-capability",
    );
  });
});

describe("sanitizeEndpointIdentity", () => {
  it("normalizes only non-secret HTTPS origin and path identities", () => {
    expect(sanitizeEndpointIdentity("https://API.example/v1/")).toBe("https://api.example/v1");

    for (const unsafe of [
      "http://api.example/v1",
      "https://user:secret@api.example/v1",
      "https://api.example/v1?api_key=secret",
      "https://api.example/v1#secret",
    ]) {
      expectError(() => sanitizeEndpointIdentity(unsafe), "invalid-request");
    }

    const unsafeTarget = provider("images", [
      {
        ...imageTarget("images", "unsafe-model", opaqueImageCapabilities),
        endpoint: "https://user:secret@api.example/v1",
      },
    ]);
    expectError(
      () =>
        resolveAssetTarget([unsafeTarget], {
          kind: "image",
          prompt: "Safe request, unsafe configured endpoint",
          role: "background",
          outputFormat: "png",
        }),
      "invalid-request",
    );
    expect(unsafeTarget.generate).not.toHaveBeenCalled();

    const canonicalTarget = provider("images", [
      {
        ...imageTarget("images", "canonical-model", opaqueImageCapabilities),
        endpoint: "https://API.example/v1/",
      },
    ]);
    expect(
      resolveAssetTarget([canonicalTarget], {
        kind: "image",
        prompt: "Canonical endpoint",
        role: "background",
        outputFormat: "png",
      }).target.endpoint,
    ).toBe("https://api.example/v1");
  });
});
