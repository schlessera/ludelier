import { describe, expect, it } from "vitest";
import { openAiProvider, openRouterProvider } from "../src/index";
import { openAiCompatibleProvider } from "../src/providers/openai-compatible";

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

interface ToolCapture {
  url: string;
  body: Record<string, unknown>;
}

/** A fetch stand-in that records request bodies and returns a caller-supplied response. */
function toolFetch(response: unknown) {
  const calls: ToolCapture[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function toolProvider(fetchImpl: typeof fetch) {
  return openAiCompatibleProvider({ id: "test", baseUrl: "http://example.test/v1", apiKey: "k", model: "m", fetchImpl });
}

const tools = [{ name: "foo", description: "does foo", parameters: { type: "object" } }];

describe("OpenAI-compatible tool calling (U5)", () => {
  it("includes tools in the POST body when offered", async () => {
    const { impl, calls } = toolFetch({ model: "m", choices: [{ message: { content: "hi" } }] });
    await toolProvider(impl).complete({ messages: [{ role: "user", content: "hi" }], tools });
    const body = calls[0]!.body as { tools?: { function?: { name?: string } }[] };
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0]!.function!.name).toBe("foo");
  });

  it("parses tool_calls into toolCalls with JSON-parsed arguments", async () => {
    const { impl } = toolFetch({
      model: "m",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "foo", arguments: '{"x":1}' } }] } }],
    });
    const res = await toolProvider(impl).complete({ messages: [{ role: "user", content: "hi" }], tools });
    expect(res.toolCalls?.[0]).toEqual({ id: "c1", name: "foo", arguments: { x: 1 } });
  });

  it("round-trips a tool-result message and an assistant tool_calls echo into the body", async () => {
    const { impl, calls } = toolFetch({ model: "m", choices: [{ message: { content: "ok" } }] });
    await toolProvider(impl).complete({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "foo", arguments: { x: 1 } }] },
        { role: "tool", content: '{"ok":true}', toolCallId: "c1" },
      ],
    });
    const msgs = calls[0]!.body.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    expect(msgs[0]!.tool_calls![0]!.id).toBe("c1");
    expect(msgs[1]!.role).toBe("tool");
    expect(msgs[1]!.tool_call_id).toBe("c1");
  });

  it("omits tools and returns a normal completion when none are offered (back-compat)", async () => {
    const { impl, calls } = toolFetch({ model: "m", choices: [{ message: { content: "hello" } }] });
    const res = await toolProvider(impl).complete({ messages: [{ role: "user", content: "hi" }] });
    expect((calls[0]!.body as { tools?: unknown }).tools).toBeUndefined();
    expect(res.text).toBe("hello");
    expect(res.toolCalls).toBeUndefined();
  });

  it("falls back to the raw string on malformed argument JSON rather than throwing", async () => {
    const { impl } = toolFetch({
      model: "m",
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "foo", arguments: "{bad" } }] } }],
    });
    const res = await toolProvider(impl).complete({ messages: [{ role: "user", content: "hi" }], tools });
    expect(res.toolCalls?.[0]!.arguments).toBe("{bad");
  });
});
