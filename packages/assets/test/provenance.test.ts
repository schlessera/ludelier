import { describe, expect, it } from "vitest";
import {
  AssetError,
  buildAssetProvenanceSidecar,
  buildRedactedAssetProvenanceSidecar,
  classifyAssetError,
  hashAssetContent,
  hashAssetPrompt,
  hashAssetRequest,
  isCanonicalEndpointIdentity,
  matchesAssetProvenanceRequest,
  isVerifiedAssetCacheHit,
  parseAssetProvenanceSidecar,
  sameCanonicalEndpointIdentity,
} from "../src/index";
import type { ResolvedImageGenerationRequest } from "../src/index";

const request: ResolvedImageGenerationRequest = {
  target: {
    providerId: "images",
    modelId: "image-model",
    kind: "image",
    endpoint: "https://images.example/v1",
    capabilities: {
      outputFormats: ["png", "webp"],
      backgrounds: ["opaque", "transparent"],
      sizes: [{ width: 1024, height: 1024 }],
      supportsSeed: true,
    },
  },
  kind: "image",
  prompt: "A lantern reflected in rain",
  role: "background",
  outputFormat: "webp",
  parameters: {
    background: "opaque",
    size: { width: 1024, height: 1024 },
    seed: 42,
  },
};

const recipe = {
  recipe: "background-cover-fit",
  version: 1,
  parameters: { position: "center", quality: 82 },
} as const;

async function sidecar() {
  const requestHash = await hashAssetRequest(request, recipe);
  const promptHash = await hashAssetPrompt(request.prompt);
  const contentHash = await hashAssetContent(new TextEncoder().encode("asset bytes"));
  return buildAssetProvenanceSidecar({
    requestHash,
    promptHash,
    contentHash,
    request,
    metadata: {
      mimeType: "image/webp",
      extension: "webp",
      createdAt: "2026-07-10T12:00:00.000Z",
      billing: {
        chargeStatus: "charged",
        cost: { kind: "estimated", amount: 0.04, currency: "USD", basis: "configured model price" },
      },
    },
    byteSize: 11,
    postProcessing: recipe,
  });
}

describe("asset canonical hashes", () => {
  it("hashes equivalent canonical requests identically and cache-relevant changes differently", async () => {
    const reordered: ResolvedImageGenerationRequest = {
      prompt: request.prompt,
      outputFormat: request.outputFormat,
      role: request.role,
      parameters: { seed: 42, size: { height: 1024, width: 1024 }, background: "opaque" },
      kind: "image",
      target: {
        endpoint: "https://images.example/v1",
        kind: "image",
        modelId: "image-model",
        providerId: "images",
        capabilities: request.target.capabilities,
      },
    };

    const base = await hashAssetRequest(request, recipe);
    expect(await hashAssetRequest(reordered, recipe)).toBe(base);
    expect(await hashAssetRequest({ ...request, prompt: `${request.prompt} ` }, recipe)).not.toBe(base);
    expect(
      await hashAssetRequest({ ...request, target: { ...request.target, modelId: "other-model" } }, recipe),
    ).not.toBe(base);
    expect(await hashAssetRequest({ ...request, outputFormat: "png" }, recipe)).not.toBe(base);
    expect(await hashAssetRequest(request, { ...recipe, version: 2 })).not.toBe(base);
    expect(await hashAssetPrompt(request.prompt)).not.toBe(await hashAssetPrompt(`${request.prompt} `));
  });

  it("uses browser Web Crypto SHA-256 for final content", async () => {
    expect(await hashAssetContent(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("asset provenance sidecars", () => {
  it("round-trips a redacted sidecar and labels estimated, reported, and unavailable cost", async () => {
    const estimated = await sidecar();
    const parsed = parseAssetProvenanceSidecar(JSON.parse(JSON.stringify(estimated)));
    expect(parsed).toEqual({ success: true, data: estimated });
    expect(estimated.cost).toEqual({
      kind: "estimated",
      amount: 0.04,
      currency: "USD",
      basis: "configured model price",
    });

    const requestHash = await hashAssetRequest(request, recipe);
    const promptHash = await hashAssetPrompt(request.prompt);
    const contentHash = await hashAssetContent(new TextEncoder().encode("asset bytes"));
    const common = {
      requestHash,
      promptHash,
      contentHash,
      request,
      byteSize: 11,
      postProcessing: recipe,
    };
    const unavailable = buildAssetProvenanceSidecar({
      ...common,
      metadata: {
        mimeType: "image/webp",
        extension: "webp",
        createdAt: "2026-07-10T12:00:00.000Z",
      },
    });
    const reported = buildAssetProvenanceSidecar({
      ...common,
      metadata: {
        mimeType: "image/webp",
        extension: "webp",
        createdAt: "2026-07-10T12:00:00.000Z",
        billing: {
          chargeStatus: "charged",
          cost: { kind: "reported", amount: 0.03, currency: "USD" },
        },
      },
    });

    expect(unavailable.cost).toEqual({ kind: "unavailable" });
    expect(reported.cost).toEqual({ kind: "reported", amount: 0.03, currency: "USD" });
  });

  it("rejects malformed or secret-bearing sidecars and never persists plaintext prompt", async () => {
    const built = await sidecar();
    const serialized = JSON.stringify(built);

    expect(serialized).not.toContain(request.prompt);
    expect(serialized).toContain(built.promptHash);
    expect(parseAssetProvenanceSidecar({ ...built, apiKey: "sk-secret" }).success).toBe(false);
    expect(
      parseAssetProvenanceSidecar({ ...built, rawResponse: { authorization: "Bearer secret" } }).success,
    ).toBe(false);
    expect(
      parseAssetProvenanceSidecar({
        ...built,
        request: { ...built.request, prompt: request.prompt },
      }).success,
    ).toBe(false);
    expect(parseAssetProvenanceSidecar({ ...built, contentHash: "bad" }).success).toBe(false);
    const relabelled = { ...built, mimeType: "image/png", extension: "png" };
    expect(parseAssetProvenanceSidecar(relabelled).success).toBe(false);
    expect(matchesAssetProvenanceRequest(relabelled, request)).toBe(false);
  });

  it("rejects unsafe or merely canonicalizable endpoint identities and exposes only strict comparisons", async () => {
    const built = await sidecar();
    const unsafeEndpoints = [
      "http://images.example/v1",
      "https://user:password@images.example/v1",
      "https://images.example/v1?credential=secret",
      "https://images.example/v1#token",
      "https://IMAGES.example/v1/",
    ];

    for (const endpoint of unsafeEndpoints) {
      expect(parseAssetProvenanceSidecar({ ...built, target: { ...built.target, endpoint } }).success).toBe(
        false,
      );
      expect(isCanonicalEndpointIdentity(endpoint)).toBe(false);
    }

    expect(isCanonicalEndpointIdentity(built.target.endpoint)).toBe(true);
    expect(sameCanonicalEndpointIdentity(built.target.endpoint, "https://images.example/v1")).toBe(true);
    expect(sameCanonicalEndpointIdentity(built.target.endpoint, "https://images.example/v1/")).toBe(false);
  });

  it("builds provenance from strict redacted input without inventing a plaintext prompt", async () => {
    const built = await sidecar();
    const redacted = buildRedactedAssetProvenanceSidecar({
      requestHash: built.requestHash,
      promptHash: built.promptHash,
      contentHash: built.contentHash,
      target: built.target,
      request: built.request,
      metadata: {
        mimeType: built.mimeType,
        extension: built.extension,
        createdAt: built.createdAt,
        billing: { chargeStatus: "charged", cost: built.cost },
      },
      byteSize: built.byteSize,
      postProcessing: built.postProcessing,
    });

    expect(redacted).toEqual(built);
    expect(JSON.stringify(redacted)).not.toContain(request.prompt);
    expect(() =>
      buildRedactedAssetProvenanceSidecar({
        requestHash: built.requestHash,
        promptHash: built.promptHash,
        contentHash: built.contentHash,
        target: { ...built.target, endpoint: "https://images.example/v1?secret=never-persisted" },
        request: built.request,
        metadata: {
          mimeType: built.mimeType,
          extension: built.extension,
          createdAt: built.createdAt,
        },
        byteSize: built.byteSize,
        postProcessing: built.postProcessing,
      }),
    ).toThrowError(AssetError);
  });

  it("accepts a cache hit only with matching request and externally verified content hashes", async () => {
    const built = await sidecar();

    expect(isVerifiedAssetCacheHit(built, built.requestHash, built.contentHash)).toBe(true);
    expect(isVerifiedAssetCacheHit(built, "0".repeat(64), built.contentHash)).toBe(false);
    expect(isVerifiedAssetCacheHit(built, built.requestHash, "f".repeat(64))).toBe(false);
    expect(isVerifiedAssetCacheHit(built, built.requestHash, undefined)).toBe(false);
    expect(matchesAssetProvenanceRequest(built, request)).toBe(true);
    expect(
      matchesAssetProvenanceRequest(
        { ...built, target: { ...built.target, modelId: "tampered-model" } },
        request,
      ),
    ).toBe(false);
    expect(
      matchesAssetProvenanceRequest(
        {
          ...built,
          request: {
            ...built.request,
            parameters: { ...built.request.parameters, background: "transparent" },
          },
        },
        request,
      ),
    ).toBe(false);
  });
});

describe("redacted asset errors", () => {
  it("classifies unknown and typed errors without exposing raw provider data", () => {
    const secret = "sk-live-not-for-output";
    const unknown = classifyAssetError(new Error(`provider body included ${secret}`));
    const typed = classifyAssetError(
      new AssetError("rate-limited", { context: { providerId: "images", modelId: "image-model" } }),
    );

    expect(unknown).toMatchObject({
      code: "provider-failure",
      retryable: false,
      mayHaveCharged: true,
    });
    expect(JSON.stringify(unknown)).not.toContain(secret);
    expect(typed).toEqual({
      code: "rate-limited",
      message: "Asset provider rate limit reached.",
      retryable: true,
      mayHaveCharged: false,
      context: { providerId: "images", modelId: "image-model" },
    });
  });
});
