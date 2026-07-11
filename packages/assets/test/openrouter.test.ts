import { describe, expect, it, vi } from "vitest";
import {
  AssetError,
  assertOpenRouterRequestSupported,
  openRouterAssetProvider,
  resolveAssetTarget,
} from "../src/index";
import type { AssetProvider } from "../src/index";

const now = () => new Date("2026-07-10T12:00:00.000Z");
const modelIndex = {
  data: [
    {
      id: "acme/illustrator",
    },
  ],
};
const compatibleEndpoint = {
  endpoints: [
    {
      supported_parameters: {
        background: { type: "enum", values: ["opaque", "transparent"] },
        output_format: { type: "enum", values: ["png", "jpeg", "webp"] },
        size: { type: "enum", values: ["1024x1024"] },
        quality: { type: "enum", values: ["standard", "high"] },
        seed: { type: "integer" },
      },
    },
  ],
};

const resolutionEndpoint = {
  endpoints: [
    {
      supported_parameters: {
        background: { type: "enum", values: ["opaque", "transparent"] },
        output_format: { type: "enum", values: ["png", "jpeg", "webp"] },
        resolution: { type: "enum", values: ["1K", "2K"] },
      },
    },
  ],
};

function resolveImage(provider: AssetProvider, overrides: Record<string, unknown> = {}) {
  const resolved = resolveAssetTarget([provider], {
    kind: "image",
    prompt: "A transparent lantern",
    role: "sprite",
    outputFormat: "png",
    background: "transparent",
    ...overrides,
  });
  if (resolved.kind !== "image") throw new Error("Expected an image request.");
  return resolved;
}

function discoveryFetchFor(models: readonly string[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/images/models") {
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }));
    }
    if (url.endsWith("/endpoints")) return new Response(JSON.stringify(compatibleEndpoint));
    throw new Error(`Unexpected discovery URL: ${url}`);
  }) as unknown as typeof fetch;
}

describe("OpenRouter image asset provider", () => {
  it("discovers only declared capabilities and posts buffered b64_json image generation", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === "https://openrouter.ai/api/v1/images/models")
        return new Response(JSON.stringify(modelIndex));
      if (url === "https://openrouter.ai/api/v1/images/models/acme/illustrator/endpoints") {
        return new Response(JSON.stringify(compatibleEndpoint));
      }
      if (url === "https://openrouter.ai/api/v1/images") {
        return new Response(
          JSON.stringify({
            data: [{ b64_json: "AAEC" }],
            usage: { cost: 0.004 },
          }),
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const provider = await openRouterAssetProvider({ apiKey: "or-secret", fetchImpl, now });
    expect(provider.targets).toEqual([
      expect.objectContaining({
        providerId: "openrouter",
        modelId: "acme/illustrator",
        endpoint: "https://openrouter.ai/api/v1/images",
        capabilities: expect.objectContaining({
          backgrounds: ["opaque", "transparent"],
          outputFormats: ["png", "jpeg", "webp"],
        }),
      }),
    ]);

    const result = await provider.generate(resolveImage(provider, { seed: 7, quality: "high" }));
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(new Headers(calls[2]?.init.headers).get("authorization")).toBe("Bearer or-secret");
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      model: "acme/illustrator",
      prompt: "A transparent lantern",
      n: 1,
      size: "1024x1024",
      quality: "high",
      seed: 7,
      background: "transparent",
      output_format: "png",
      response_format: "b64_json",
    });
    expect(result).toMatchObject({
      bytes: new Uint8Array([0, 1, 2]),
      mimeType: "image/png",
      extension: "png",
      billing: { chargeStatus: "charged", cost: { kind: "reported", amount: 0.004, currency: "USD" } },
    });
  });

  it("uses the requested output format instead of optional provider MIME metadata", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/images/models")) return new Response(JSON.stringify(modelIndex));
      if (url.endsWith("/endpoints")) return new Response(JSON.stringify(compatibleEndpoint));
      return new Response(JSON.stringify({ data: [{ b64_json: "AAEC", mime_type: "image/webp" }] }));
    }) as typeof fetch;
    const provider = await openRouterAssetProvider({ apiKey: "or-secret", fetchImpl, now });

    await expect(provider.generate(resolveImage(provider))).resolves.toMatchObject({
      bytes: new Uint8Array([0, 1, 2]),
      mimeType: "image/png",
      extension: "png",
    });
  });

  it("maps K resolution capabilities to portable square sizes and posts their declared token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === "https://openrouter.ai/api/v1/images/models") {
        return new Response(JSON.stringify({ data: [{ id: "sourceful/riverflow-v2.5-fast" }] }));
      }
      if (url.endsWith("/sourceful/riverflow-v2.5-fast/endpoints")) {
        return new Response(JSON.stringify(resolutionEndpoint));
      }
      if (url === "https://openrouter.ai/api/v1/images") {
        return new Response(JSON.stringify({ data: [{ b64_json: "AAEC", mime_type: "image/png" }] }));
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const provider = await openRouterAssetProvider({ apiKey: "or-secret", fetchImpl, now });
    expect(provider.targets).toEqual([
      expect.objectContaining({
        modelId: "sourceful/riverflow-v2.5-fast",
        capabilities: expect.objectContaining({
          sizes: [
            { width: 1024, height: 1024 },
            { width: 2048, height: 2048 },
          ],
        }),
        defaultParameters: expect.objectContaining({ size: { width: 1024, height: 1024 } }),
      }),
    ]);

    const defaultResolved = resolveImage(provider);
    expect(defaultResolved.parameters.size).toEqual({ width: 1024, height: 1024 });
    expect(resolveImage(provider, { size: { width: 2048, height: 2048 } }).parameters.size).toEqual({
      width: 2048,
      height: 2048,
    });

    await provider.generate(defaultResolved);
    const body = JSON.parse(String(calls[2]?.init.body));
    expect(body).toMatchObject({
      model: "sourceful/riverflow-v2.5-fast",
      resolution: "1K",
      background: "transparent",
      output_format: "png",
      response_format: "b64_json",
    });
    expect(body).not.toHaveProperty("size");
  });

  it("retries both OpenRouter discovery GET contracts only as explicit discovery operations", async () => {
    const calls = new Map<string, number>();
    let sleepCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const call = (calls.get(url) ?? 0) + 1;
      calls.set(url, call);
      if (url === "https://openrouter.ai/api/v1/images/models") {
        return call === 1 ? new Response("", { status: 503 }) : new Response(JSON.stringify(modelIndex));
      }
      if (url === "https://openrouter.ai/api/v1/images/models/acme/illustrator/endpoints") {
        return call === 1
          ? new Response("", { status: 503 })
          : new Response(JSON.stringify(compatibleEndpoint));
      }
      throw new Error(`Unexpected discovery URL: ${url}`);
    }) as typeof fetch;

    const provider = await openRouterAssetProvider({
      apiKey: "or-secret",
      fetchImpl,
      retry: {
        maxRetries: 1,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    });

    expect(provider.targets).toHaveLength(1);
    expect(calls.get("https://openrouter.ai/api/v1/images/models")).toBe(2);
    expect(calls.get("https://openrouter.ai/api/v1/images/models/acme/illustrator/endpoints")).toBe(2);
    expect(sleepCalls).toBe(2);
  });

  it("uses configured OpenRouter model preference, then a stable de-duplicated target identity fallback", async () => {
    const modelPreference = ["acme/omega"];
    const first = await openRouterAssetProvider({
      apiKey: "or-secret",
      fetchImpl: discoveryFetchFor(["acme/beta", "acme/alpha", "acme/omega", "acme/alpha"]),
      modelPreference,
    });
    const reversed = await openRouterAssetProvider({
      apiKey: "or-secret",
      fetchImpl: discoveryFetchFor(["acme/alpha", "acme/omega", "acme/alpha", "acme/beta"]),
      modelPreference,
    });
    const lexicalFallback = await openRouterAssetProvider({
      apiKey: "or-secret",
      fetchImpl: discoveryFetchFor(["acme/alpha", "acme/omega", "acme/alpha", "acme/beta"]),
    });

    expect(lexicalFallback.targets.map((target) => target.modelId)).toEqual([
      "acme/alpha",
      "acme/beta",
      "acme/omega",
    ]);
    expect(resolveImage(lexicalFallback).target.modelId).toBe("acme/alpha");

    const expectedOrder = ["acme/omega", "acme/alpha", "acme/beta"];
    expect(first.targets.map((target) => target.modelId)).toEqual(expectedOrder);
    expect(reversed.targets.map((target) => target.modelId)).toEqual(expectedOrder);
    expect(resolveImage(first).target.modelId).toBe("acme/omega");
    expect(resolveImage(first, { modelId: "acme/beta" }).target.modelId).toBe("acme/beta");
  });

  it("rejects an explicit OpenRouter audio selection before discovery I/O", () => {
    const discoveryFetch = vi.fn() as unknown as typeof fetch;

    let error: unknown;
    try {
      assertOpenRouterRequestSupported({ providerId: "openrouter", kind: "audio" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "unsupported-capability",
      context: { providerId: "openrouter", kind: "audio" },
    });

    expect(() => {
      assertOpenRouterRequestSupported({ providerId: "openrouter", kind: "audio" });
      void openRouterAssetProvider({ apiKey: "or-secret", fetchImpl: discoveryFetch });
    }).toThrowError(AssetError);
    expect(discoveryFetch).not.toHaveBeenCalled();
  });

  it("does not guess absent capabilities and rejects transparent JPEG-only declarations before generation fetch", async () => {
    let generationCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/images/models") {
        return new Response(
          JSON.stringify({
            data: [{ id: "acme/unknown" }, { id: "acme/jpeg" }],
          }),
        );
      }
      if (url.endsWith("acme/unknown/endpoints"))
        return new Response(JSON.stringify({ endpoints: [{ supported_parameters: {} }] }));
      if (url.endsWith("acme/jpeg/endpoints")) {
        return new Response(
          JSON.stringify({
            endpoints: [
              {
                supported_parameters: {
                  background: { type: "enum", values: ["opaque", "transparent"] },
                  output_format: { type: "enum", values: ["jpeg"] },
                },
              },
            ],
          }),
        );
      }
      generationCalls += 1;
      return new Response("unexpected");
    }) as typeof fetch;

    const provider = await openRouterAssetProvider({ apiKey: "or-secret", fetchImpl });
    expect(provider.targets).toHaveLength(1);
    expect(provider.targets[0]?.modelId).toBe("acme/jpeg");
    expect(provider.targets[0]?.kind === "image" && provider.targets[0].capabilities.backgrounds).toEqual([
      "opaque",
    ]);
    expect(() => resolveImage(provider)).toThrowError(AssetError);
    expect(generationCalls).toBe(0);
  });

  it("rejects malformed generated media without retaining raw response", async () => {
    const secret = "or-secret-never-returned";
    const malformedPayloads = [
      { label: "missing data", payload: {} },
      {
        label: "multiple images",
        payload: { data: [{ b64_json: "AAEC" }, { b64_json: "AAEC" }] },
      },
      { label: "missing base64", payload: { data: [{}] } },
      { label: "non-string base64", payload: { data: [{ b64_json: 0 }] } },
      { label: "invalid base64", payload: { data: [{ b64_json: `not-valid-${secret}` }] } },
    ] as const;

    for (const { label, payload } of malformedPayloads) {
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/images/models")) return new Response(JSON.stringify(modelIndex));
        if (url.endsWith("/endpoints")) return new Response(JSON.stringify(compatibleEndpoint));
        return new Response(JSON.stringify(payload));
      }) as typeof fetch;
      const provider = await openRouterAssetProvider({ apiKey: secret, fetchImpl });

      let error: unknown;
      try {
        await provider.generate(resolveImage(provider));
      } catch (caught) {
        error = caught;
      }

      expect(error, label).toMatchObject({
        code: "invalid-provider-response",
        mayHaveCharged: true,
      });
      expect(JSON.stringify(error), label).not.toContain(secret);
    }
  });

  it("does not replay a paid OpenRouter image POST after a 429, 5xx, or transport failure", async () => {
    const outcomes = [
      { code: "rate-limited", response: () => new Response("", { status: 429 }) },
      { code: "provider-failure", response: () => new Response("", { status: 503 }) },
      {
        code: "network-failure",
        response: () => {
          throw new Error("post-dispatch transport failure");
        },
      },
    ] as const;

    for (const outcome of outcomes) {
      let generationCalls = 0;
      const provider = await openRouterAssetProvider({
        apiKey: "or-secret",
        fetchImpl: (async () => {
          generationCalls += 1;
          return outcome.response();
        }) as typeof fetch,
        discoveryFetchImpl: (async (input) => {
          const url = String(input);
          if (url === "https://openrouter.ai/api/v1/images/models") {
            return new Response(JSON.stringify(modelIndex));
          }
          if (url === "https://openrouter.ai/api/v1/images/models/acme/illustrator/endpoints") {
            return new Response(JSON.stringify(compatibleEndpoint));
          }
          throw new Error("unexpected discovery URL");
        }) as typeof fetch,
        retry: {
          maxRetries: 2,
          retryStatuses: [429, 500, 503],
          sleep: async () => {
            throw new Error("generation should not sleep before a replay");
          },
        },
      });

      await expect(provider.generate(resolveImage(provider))).rejects.toMatchObject({ code: outcome.code });
      expect(generationCalls).toBe(1);
    }
  });
});
