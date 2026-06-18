import { describe, expect, it } from "vitest";
import { generateStory } from "../src/author";
import type { CompletionRequest, LLMProvider } from "../src/provider";

const validStory = JSON.stringify({
  meta: { id: "t", title: "T", start: "a", seed: 1 },
  characters: [{ id: "n", name: "N" }],
  nodes: [{ id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] }],
});

/** A provider that returns scripted responses in order and records every request. */
function scripted(responses: string[]): { provider: LLMProvider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  let i = 0;
  const provider: LLMProvider = {
    id: "mock",
    capabilities: { jsonSchema: true },
    async complete(req) {
      calls.push(req);
      const text = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return { text, model: "mock" };
    },
  };
  return { provider, calls };
}

describe("generateStory self-correction loop", () => {
  it("returns a validated story on the first valid response", async () => {
    const { provider, calls } = scripted([validStory]);
    const res = await generateStory({ provider, prompt: "make a café story" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempts).toBe(1);
      expect(res.story.meta.id).toBe("t");
    }
    expect(calls).toHaveLength(1);
  });

  it("constrains output with the Story JSON schema and a system instruction", async () => {
    const { provider, calls } = scripted([validStory]);
    await generateStory({ provider, prompt: "x" });
    const req = calls[0]!;
    expect(req.jsonSchema?.name).toBe("Story");
    expect(req.messages[0]!.role).toBe("system");
    expect(req.messages[1]).toEqual({ role: "user", content: "x" });
  });

  it("recovers from invalid JSON by feeding back a correction", async () => {
    const { provider, calls } = scripted(["sorry, here is your story!", validStory]);
    const res = await generateStory({ provider, prompt: "x" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(2);
    const lastReq = calls[1]!;
    const lastUser = lastReq.messages[lastReq.messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    expect(lastUser.content.toLowerCase()).toContain("invalid");
  });

  it("feeds back cross-reference validation issues for self-correction", async () => {
    const badRef = JSON.stringify({
      meta: { id: "t", title: "T", start: "a" },
      nodes: [{ id: "a", body: [{ op: "jump", goto: "ghost" }] }],
    });
    const { provider, calls } = scripted([badRef, validStory]);
    const res = await generateStory({ provider, prompt: "x" });
    expect(res.ok).toBe(true);
    expect(calls[1]!.messages.at(-1)!.content).toContain("ghost");
  });

  it("tolerates a fenced ```json code block", async () => {
    const { provider } = scripted(["```json\n" + validStory + "\n```"]);
    const res = await generateStory({ provider, prompt: "x" });
    expect(res.ok).toBe(true);
  });

  it("gives up after maxAttempts and returns the last issues", async () => {
    const { provider, calls } = scripted(["nope"]);
    const res = await generateStory({ provider, prompt: "x", maxAttempts: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(3);
      expect(res.issues.length).toBeGreaterThan(0);
    }
    expect(calls).toHaveLength(3);
  });
});
