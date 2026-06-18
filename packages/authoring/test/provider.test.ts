import { describe, expect, it } from "vitest";
import { openAiProvider, openRouterProvider } from "../src/index";

interface Capture {
  url?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** A fake `fetch` that records the request and returns a canned chat completion. */
function fakeFetch(capture: Capture, content = '{"hello":true}'): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init?.headers as Record<string, string>;
    capture.body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    return new Response(
      JSON.stringify({
        model: "m",
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("OpenAI-compatible providers", () => {
  it("openai provider posts to the OpenAI endpoint with a json_schema response_format", async () => {
    const cap: Capture = {};
    const p = openAiProvider({ apiKey: "k", model: "gpt-x", fetchImpl: fakeFetch(cap) });
    const r = await p.complete({
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: { name: "Story", schema: { type: "object" } },
    });
    expect(cap.url).toBe("https://api.openai.com/v1/chat/completions");
    const body = cap.body as Record<string, any>;
    expect(body.model).toBe("gpt-x");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("Story");
    expect(cap.headers?.Authorization).toBe("Bearer k");
    expect(r.text).toContain("hello");
    expect(r.usage?.completionTokens).toBe(7);
  });

  it("openrouter provider targets the OpenRouter base url and adds attribution headers", async () => {
    const cap: Capture = {};
    const p = openRouterProvider({
      apiKey: "k",
      model: "openai/gpt-x",
      appUrl: "https://ludelier.dev",
      appName: "Ludelier",
      fetchImpl: fakeFetch(cap),
    });
    await p.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(cap.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(cap.headers?.["HTTP-Referer"]).toBe("https://ludelier.dev");
    expect(cap.headers?.["X-Title"]).toBe("Ludelier");
  });

  it("throws a useful error on a non-2xx response", async () => {
    const errFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 })) as unknown as typeof fetch;
    const p = openAiProvider({ apiKey: "k", model: "x", fetchImpl: errFetch });
    await expect(p.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/bad model/);
  });
});
