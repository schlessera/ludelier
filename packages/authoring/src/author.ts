import { storyJsonSchema, validateStory } from "@ludelier/schema";
import type { Issue, Story } from "@ludelier/schema";
import type { ChatMessage, LLMProvider } from "./provider";

export interface AuthorOptions {
  provider: LLMProvider;
  /** Natural-language description of the game/story to author. */
  prompt: string;
  /** Override the provider's default model. */
  model?: string;
  temperature?: number;
  /** Max generate→validate→correct rounds before giving up. */
  maxAttempts?: number;
  /** Override the default system instruction (advanced). */
  system?: string;
}

export type AuthorResult =
  | { ok: true; story: Story; attempts: number; transcript: ChatMessage[] }
  | { ok: false; issues: Issue[]; attempts: number; transcript: ChatMessage[] };

const DEFAULT_MAX_ATTEMPTS = 4;

/** The system instruction: how to emit a valid Story, plus the JSON Schema itself. */
export function defaultSystemPrompt(schema: unknown): string {
  return [
    "You are a visual-novel author for the Ludelier engine.",
    "Output a SINGLE Story as a JSON object and nothing else — no prose, no markdown code fences.",
    "",
    "Hard rules (the Story is rejected otherwise):",
    "- `meta.start` must equal the `id` of one of the `nodes`.",
    "- Every `jump.goto` and every choice option `goto` must reference an existing node id.",
    "- Every `scene.bg` and every `show.asset` must reference an `id` declared in `assets`.",
    "- Statement ops: say {who,text}, set {var,value}, add {var,amount}, roll {var,min,max},",
    "  choice {prompt?,options:[{label,goto,if?}]}, jump {goto}, branch {cond,goto}, end,",
    "  scene {bg?}, show {sprite,asset,at?: left|center|right}, hide {sprite}.",
    "- `branch` is a conditional jump: if `cond` ({var,cmp,value}) holds it continues at `goto`,",
    "  otherwise it falls through to the next statement (use it for state-driven endings).",
    "- `who` in a `say` should be a declared character id.",
    "- Use only fields defined by the schema; keep the story self-contained and deterministic.",
    "",
    "The Story must conform to this JSON Schema:",
    JSON.stringify(schema),
    "",
    "Return ONLY the JSON object for the Story.",
  ].join("\n");
}

function correctionMessage(issues: Issue[]): string {
  const lines = issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
  return [
    "The Story JSON you returned is invalid. Fix ALL of these issues and return the",
    "corrected, complete Story JSON object only (no prose, no code fences):",
    lines,
  ].join("\n");
}

/** Tolerantly extract a JSON object from a model response (strips fences / prose). */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1]!.trim();
  if (!s.startsWith("{")) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Generate a Zod-valid Story from a natural-language prompt. Constrains the model
 * with the Story JSON Schema, runs `validateStory()`, and feeds any issues back for
 * self-correction until the Story is valid or `maxAttempts` is reached. The whole
 * loop is provider-agnostic and never throws on invalid model output — it returns a
 * discriminated result mirroring `validateStory`.
 */
export async function generateStory(opts: AuthorOptions): Promise<AuthorResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const schema = storyJsonSchema();
  const transcript: ChatMessage[] = [
    { role: "system", content: opts.system ?? defaultSystemPrompt(schema) },
    { role: "user", content: opts.prompt },
  ];

  let issues: Issue[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const completion = await opts.provider.complete({
      // Snapshot: the request reflects the conversation at call time, not later mutations.
      messages: [...transcript],
      model: opts.model,
      temperature: opts.temperature,
      jsonSchema: { name: "Story", schema },
    });
    transcript.push({ role: "assistant", content: completion.text });

    const parsed = parseJson(completion.text);
    if (!parsed.ok) {
      issues = [{ path: "(root)", message: `response was not valid JSON: ${parsed.error}` }];
    } else {
      const result = validateStory(parsed.value);
      if (result.success) {
        return { ok: true, story: result.data, attempts: attempt, transcript };
      }
      issues = result.issues;
    }

    if (attempt < maxAttempts) {
      transcript.push({ role: "user", content: correctionMessage(issues) });
    }
  }
  return { ok: false, issues, attempts: maxAttempts, transcript };
}
