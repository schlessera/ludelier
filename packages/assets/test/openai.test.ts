import { describe, expect, it } from "vitest";
import {
  AssetError,
  classifyAssetError,
  openAiAssetProvider,
  resolveAssetTarget,
  retryAssetFetch,
} from "../src/index";
import type { AssetProvider } from "../src/index";

const now = () => new Date("2026-07-10T12:00:00.000Z");

function resolveImage(provider: AssetProvider, overrides: Record<string, unknown> = {}) {
  return resolveAssetTarget([provider], {
    kind: "image",
    prompt: "An opaque lighthouse",
    role: "background",
    outputFormat: "png",
    ...overrides,
  });
}

function resolveSpeech(provider: AssetProvider, overrides: Record<string, unknown> = {}) {
  return resolveAssetTarget([provider], {
    kind: "audio",
    prompt: "Welcome to Ludelier.",
    role: "voice",
    outputFormat: "mp3",
    ...overrides,
  });
}

describe("OpenAI asset provider", () => {
  it("uses the fixed image endpoint and GPT Image b64 payload without a DALL-E response format", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = openAiAssetProvider({
      apiKey: "sk-test-secret",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ b64_json: "AAEC" }] }), { status: 200 });
      }) as typeof fetch,
      now,
    });

    const result = await provider.generate(resolveImage(provider));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer sk-test-secret");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-image-2",
      prompt: "An opaque lighthouse",
      n: 1,
      size: "1024x1024",
      quality: "auto",
      background: "opaque",
      output_format: "png",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("response_format");
    expect(result).toMatchObject({
      bytes: new Uint8Array([0, 1, 2]),
      mimeType: "image/png",
      extension: "png",
      createdAt: "2026-07-10T12:00:00.000Z",
    });
    expect(provider.targets.find((target) => target.modelId === "gpt-image-1.5")?.deprecated).toBe(true);
  });

  it("requires explicit legacy model selection for transparent generation and rejects automatic transparent selection before fetch", async () => {
    let calls = 0;
    const provider = openAiAssetProvider({
      apiKey: "sk-test-secret",
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }));
      }) as typeof fetch,
    });

    expect(() => resolveImage(provider, { background: "transparent" })).toThrowError(AssetError);
    expect(calls).toBe(0);

    const explicit = resolveImage(provider, {
      modelId: "gpt-image-1.5",
      background: "transparent",
      outputFormat: "webp",
    });
    await provider.generate(explicit);
    expect(calls).toBe(1);
  });

  it("posts bounded TTS JSON and returns only the binary payload and safe format metadata", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = openAiAssetProvider({
      apiKey: "sk-test-secret",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }) as typeof fetch,
      now,
    });

    const result = await provider.generate(resolveSpeech(provider, { voice: "coral", speed: 1.5 }));
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Welcome to Ludelier.",
      voice: "coral",
      response_format: "mp3",
      speed: 1.5,
      stream_format: "audio",
    });
    expect(result).toMatchObject({
      bytes: new Uint8Array([9, 8, 7]),
      mimeType: "audio/mpeg",
      extension: "mp3",
      contentTypeValidated: true,
    });

    const oversized = { ...resolveSpeech(provider), prompt: "a".repeat(4_097) };
    await expect(provider.generate(oversized)).rejects.toMatchObject({ code: "invalid-request" });
    expect(calls).toHaveLength(1);
  });

  it("rejects successful TTS bodies whose Content-Type is not the canonical selected format", async () => {
    for (const [label, outputFormat, contentType, body] of [
      ["HTML", "mp3", "text/html", "<html>not audio</html>"],
      ["JSON", "mp3", "application/json", JSON.stringify({ error: "not audio" })],
      ["wrong audio format", "mp3", "audio/ogg", new Uint8Array([0x4f, 0x67, 0x67, 0x53])],
      ["PCM requires PCM Content-Type", "pcm", "audio/mpeg", new Uint8Array([1, 0, 2, 0])],
    ] as const) {
      let calls = 0;
      const provider = openAiAssetProvider({
        apiKey: "sk-test-secret",
        fetchImpl: (async () => {
          calls += 1;
          return new Response(body, { status: 200, headers: { "content-type": contentType } });
        }) as typeof fetch,
      });

      await expect(provider.generate(resolveSpeech(provider, { outputFormat }))).rejects.toMatchObject({
        code: "invalid-provider-response",
        mayHaveCharged: true,
      });
      expect(calls, label).toBe(1);
    }
  });

  it("maps invalid responses and ambiguous dispatched failures to redacted AssetErrors", async () => {
    const secret = "sk-secret-never-returned";
    const invalidPayloadProvider = openAiAssetProvider({
      apiKey: secret,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ url: `https://bad.test/${secret}` }] }))) as typeof fetch,
    });
    await expect(invalidPayloadProvider.generate(resolveImage(invalidPayloadProvider))).rejects.toMatchObject(
      {
        code: "invalid-provider-response",
        mayHaveCharged: true,
      },
    );

    const networkProvider = openAiAssetProvider({
      apiKey: secret,
      fetchImpl: (async () => {
        throw new Error(`network body ${secret}`);
      }) as typeof fetch,
      retry: { maxRetries: 0 },
    });
    try {
      await networkProvider.generate(resolveImage(networkProvider));
      throw new Error("Expected asset error.");
    } catch (error) {
      expect(error).toBeInstanceOf(AssetError);
      if (error instanceof AssetError) {
        expect(error).toMatchObject({ code: "network-failure", mayHaveCharged: true });
        expect(JSON.stringify(classifyAssetError(error))).not.toContain(secret);
      }
    }

    let moderationCalls = 0;
    const moderationProvider = openAiAssetProvider({
      apiKey: secret,
      fetchImpl: (async () => {
        moderationCalls += 1;
        return new Response(JSON.stringify({ error: { code: "content_policy_violation" } }), { status: 400 });
      }) as typeof fetch,
      retry: { maxRetries: 2 },
    });
    await expect(moderationProvider.generate(resolveImage(moderationProvider))).rejects.toMatchObject({
      code: "content-rejected",
      mayHaveCharged: false,
    });
    expect(moderationCalls).toBe(1);
  });

  it("does not replay any paid OpenAI image or TTS POST after a 429, 5xx, or transport failure", async () => {
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
      let calls = 0;
      const provider = openAiAssetProvider({
        apiKey: "sk-test-secret",
        fetchImpl: (async () => {
          calls += 1;
          return outcome.response();
        }) as typeof fetch,
        retry: {
          maxRetries: 2,
          retryStatuses: [429, 500, 503],
          sleep: async () => {
            throw new Error("generation should not sleep before a replay");
          },
        },
      });

      for (const resolveRequest of [resolveImage, resolveSpeech]) {
        await expect(provider.generate(resolveRequest(provider))).rejects.toMatchObject({
          code: outcome.code,
        });
        expect(calls).toBe(resolveRequest === resolveImage ? 1 : 2);
      }
    }
  });
});

describe("asset retry transport", () => {
  it("retries configured transient responses for explicit discovery operations", async () => {
    const delays: number[] = [];
    let calls = 0;
    const response = await retryAssetFetch(
      (async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "120" } })
          : new Response("ok");
      }) as typeof fetch,
      "https://provider.test/images",
      { method: "GET" },
      {
        operation: "discovery",
        maxRetries: 1,
        maxRetryAfterMs: 2_000,
        sleep: async (delay: number) => void delays.push(delay),
      },
    );
    expect(response.ok).toBe(true);
    expect(delays).toEqual([2_000]);

    calls = 0;
    delays.length = 0;
    await retryAssetFetch(
      (async () => {
        calls += 1;
        return calls === 1
          ? new Response("", { status: 503, headers: { "Retry-After": "not-a-delay" } })
          : new Response("ok");
      }) as typeof fetch,
      "https://provider.test/images",
      { method: "GET" },
      {
        operation: "discovery",
        maxRetries: 1,
        baseDelayMs: 7,
        sleep: async (delay: number) => void delays.push(delay),
      },
    );
    expect(delays).toEqual([7]);

    calls = 0;
    delays.length = 0;
    const extended5xx = await retryAssetFetch(
      (async () => {
        calls += 1;
        return calls === 1 ? new Response("", { status: 520 }) : new Response("ok");
      }) as typeof fetch,
      "https://provider.test/images",
      { method: "GET" },
      {
        operation: "discovery",
        maxRetries: 1,
        sleep: async (delay: number) => void delays.push(delay),
      },
    );
    expect(extended5xx.ok).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });

  it("does not replay a 503 POST when operation is omitted", async () => {
    let calls = 0;
    let sleepCalls = 0;
    const response = await retryAssetFetch(
      (async () => {
        calls += 1;
        return calls === 1 ? new Response("", { status: 503 }) : new Response("unexpected retry");
      }) as typeof fetch,
      "https://provider.test/images",
      { method: "POST" },
      {
        maxRetries: 2,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    expect(response.status).toBe(503);
    expect(calls).toBe(1);
    expect(sleepCalls).toBe(0);
  });

  it("does not dispatch/retry aborted or non-transient client errors", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      retryAssetFetch(
        (async () => {
          calls += 1;
          return new Response("ok");
        }) as typeof fetch,
        "https://provider.test/images",
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "request-aborted", mayHaveCharged: false });
    expect(calls).toBe(0);

    const response = await retryAssetFetch(
      (async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
      }) as typeof fetch,
      "https://provider.test/images",
      { method: "POST" },
      { maxRetries: 2, sleep: async () => {} },
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      retryAssetFetch(
        (async () => {
          calls += 1;
          throw new Error("network failed after dispatch");
        }) as typeof fetch,
        "https://provider.test/images",
        { method: "POST" },
        { maxRetries: 2, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "network-failure", mayHaveCharged: true });
    expect(calls).toBe(1);

    calls = 0;
    let sleepCalls = 0;
    const secret = "abort-detail-must-not-leak";
    const error = await retryAssetFetch(
      (async () => {
        calls += 1;
        throw new DOMException(secret, "AbortError");
      }) as typeof fetch,
      "https://provider.test/images",
      { method: "POST" },
      {
        maxRetries: 2,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    ).then(
      () => new Error("Expected request abort."),
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AssetError);
    expect(error).toMatchObject({ code: "request-aborted", mayHaveCharged: true });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(calls).toBe(1);
    expect(sleepCalls).toBe(0);
  });
});
