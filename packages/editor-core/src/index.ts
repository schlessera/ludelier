import {
  createWorld,
  EditLog,
  importLog,
  diffStories,
  parseParams,
  ok,
  fail,
  type Registry,
  type EditRecord,
  type Result,
  type GraphReport,
  type StoryDiff,
} from "@ludelier/world";
import { validateStory, type Story, type Issue } from "@ludelier/schema";
import { runAgent, type AgentRunResult, type AgentEvent, type LLMProvider } from "@ludelier/authoring";

export type { AgentEvent, StopReason, AgentRunResult } from "@ludelier/authoring";

/**
 * Options for an agent chat turn. The provider is BYOK (caller-supplied); everything else
 * mirrors `runAgent` but the story + log are bound to this session (so chat edits join the
 * session history and are undoable / revertable). The run streams progress via `onEvent`, can
 * be interrupted via `signal`, and pauses every `checkpointEvery` turns to ask `onCheckpoint`.
 */
export interface ChatOptions {
  provider: LLMProvider;
  model?: string;
  temperature?: number;
  /** Run id for this chat turn (groups its records for `revertRun`). Defaults to a generated one. */
  runId?: string;
  system?: string;
  /** Absolute hard cap on turns (optional; the run is otherwise bounded by interrupt/checkpoint). */
  maxSteps?: number;
  checkpointEvery?: number;
  onCheckpoint?: (step: number) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

/** A read-only view of the session state — what a UI renders and re-renders on `change`. */
export interface EditorSnapshot {
  story: Story;
  valid: boolean;
  issues: Issue[];
  canUndo: boolean;
  canRedo: boolean;
  records: EditRecord[];
  graph: GraphReport;
}

/** Subscriber notified after any state change (edit / undo / redo / revert / chat). */
export type EditorListener = (session: EditorSession) => void;

/**
 * The editor's headless session — the single parity surface a human UI and the agent both
 * drive (AGENTS.md: "anything a human can do in the editor UI, the agent can do through the
 * same tasks"). It owns the current `Story` as an event-sourced `EditLog`, routes reads to
 * the world's understand tasks and writes to the manipulate tasks through the always-valid
 * `applyEdit` chokepoint, exposes undo/redo, and runs the agent chat loop *on the session's
 * own log* so generated edits become part of the same undoable history.
 *
 * Pure: no DOM, no React, no network of its own (the LLM provider is injected). Testable in
 * Vitest without a browser (golden rule 4); the React shell is a thin view bound to it.
 */
export class EditorSession {
  readonly world: Registry;
  private log: EditLog;
  private readonly listeners = new Set<EditorListener>();
  private manualRuns = 0;
  /**
   * True while an agent `chat` run is in flight. The run mutates the session log across `await`
   * boundaries (and snapshots a pre-run baseline for its diff / revert), so a concurrent human
   * mutation would corrupt the run's accounting and break `revertRun`'s contiguous-tail rule.
   * The mutator methods refuse while busy; reads stay allowed. A UI should also disable its
   * edit controls during a run (see `busy`).
   */
  private running = false;

  /** Wrap an already-validated story. Throws if the story is invalid (validate before calling). */
  constructor(initial: Story, opts: { world?: Registry } = {}) {
    this.world = opts.world ?? createWorld();
    const v = validateStory(initial);
    if (!v.success) {
      throw new Error(`EditorSession: initial story is invalid: ${JSON.stringify(v.issues)}`);
    }
    this.log = new EditLog(this.world, v.data);
  }

  /** Open a session from a base story + a JSONL edit log (round-trips `exportLog()`). */
  static fromLog(base: unknown, jsonl: string, opts: { world?: Registry } = {}): Result<EditorSession> {
    const world = opts.world ?? createWorld();
    const restored = importLog(world, base, jsonl);
    if (!restored.success) return restored;
    // Build over the restored current story, then adopt the log so its history is preserved.
    const session = new EditorSession(restored.data.currentStory(), { world });
    session.log = restored.data;
    return ok(session);
  }

  // ── reads ────────────────────────────────────────────────────────────────
  /** The current folded story. */
  get story(): Story {
    return this.log.currentStory();
  }

  /**
   * The session's base story (statement ids normalized). Exposed so a UI can persist the
   * `exportLog()` JSONL alongside the story it replays on — `fromLog(baseStory, jsonl)`
   * needs exactly this story, not the folded tip.
   */
  get baseStory(): Story {
    return this.log.baseStory;
  }

  /** The task manifest — the same list that drives the CLI and the agent toolset (parity). */
  describe() {
    return this.world.describe();
  }

  /**
   * Run an understand (read-only) task against the current story. Manipulate tasks are
   * rejected here — they must go through `edit()` so every mutation passes the log.
   */
  query(task: string, params: unknown = {}): Result<unknown> {
    const t = this.world.get(task);
    if (!t) return fail([{ path: "task", message: `unknown task "${task}"` }]);
    if (t.kind !== "understand")
      return fail([{ path: "task", message: `"${task}" is not an understand task — use edit()` }]);
    if (!t.run) return fail([{ path: "task", message: `task "${task}" has no run handler` }]);
    const parsed = parseParams(t.params, params);
    if (!parsed.success) return parsed;
    return t.run(this.story, parsed.data);
  }

  /** Convenience: the graph report (reachability + dead ends). */
  graph(): GraphReport {
    const res = this.query("graph");
    if (!res.success) throw new Error(`graph task failed: ${JSON.stringify(res.issues)}`);
    return res.data as GraphReport;
  }

  /** Convenience: validity of the current story. */
  validate(): Result<Story> {
    return validateStory(this.story);
  }

  /** Whether an agent chat run is in flight (mutations are refused; UI should disable edits). */
  get busy(): boolean {
    return this.running;
  }

  get canUndo(): boolean {
    return this.log.canUndo();
  }

  get canRedo(): boolean {
    return this.log.canRedo();
  }

  /** The active edit records (this is what `exportLog()` serializes). */
  records(): EditRecord[] {
    return this.log.recordsView();
  }

  // ── writes (all through the log → always-valid applyEdit) ──────────────────
  /**
   * Apply a manipulate task. Each manual edit is its own single-record run (so undo drops it
   * cleanly). Returns the `{success}` envelope; the log and story are unchanged on failure.
   */
  edit(command: string, params: unknown = {}): Result<Story> {
    if (this.running)
      return fail([
        {
          path: "session",
          message: "busy with an agent run — edit refused until it finishes or is interrupted",
        },
      ]);
    const t = this.world.get(command);
    if (!t) return fail([{ path: "command", message: `unknown task "${command}"` }]);
    if (t.kind !== "manipulate")
      return fail([{ path: "command", message: `"${command}" is not a manipulate task — use query()` }]);
    const res = this.log.apply(command, params, { runId: `manual-${this.manualRuns++}` });
    if (res.success) this.emit();
    return res;
  }

  undo(): Story {
    this.assertIdle("undo");
    const story = this.log.undo();
    this.emit();
    return story;
  }

  redo(): Story {
    this.assertIdle("redo");
    const story = this.log.redo();
    this.emit();
    return story;
  }

  /** Drop a run's records (e.g. revert a chat turn). Only a contiguous tail run can be reverted. */
  revertRun(runId: string): Result<Story> {
    if (this.running)
      return fail([
        {
          path: "session",
          message: "busy with an agent run — revert refused until it finishes or is interrupted",
        },
      ]);
    const res = this.log.revertRun(runId);
    if (res.success) this.emit();
    return res;
  }

  /** Throw if a chat run is in flight — for the mutators that don't return a `Result`. */
  private assertIdle(op: string): void {
    if (this.running) {
      throw new Error(
        `EditorSession is busy with an agent run — ${op} is not allowed until it finishes or is interrupted`,
      );
    }
  }

  // ── agent chat ─────────────────────────────────────────────────────────────
  /**
   * Run an agent editing turn on this session's log. The run's records join the session
   * history under its `runId`, so the result is undoable and `revertRun(result.runId)` rolls
   * back exactly this turn. Self-correction (graph-health gate) applies as in `runAgent`.
   */
  async chat(prompt: string, opts: ChatOptions): Promise<AgentRunResult> {
    // One run at a time: a second concurrent run (or a human edit) on the shared log would
    // interleave records and corrupt each run's baseline/diff and `revertRun` contiguity.
    this.assertIdle("chat");
    this.running = true;
    this.emit(); // let the UI reflect the busy state immediately
    try {
      return await runAgent({
        provider: opts.provider,
        prompt,
        story: this.story,
        world: this.world,
        log: this.log,
        model: opts.model,
        maxSteps: opts.maxSteps,
        checkpointEvery: opts.checkpointEvery,
        onCheckpoint: opts.onCheckpoint,
        signal: opts.signal,
        onEvent: opts.onEvent,
        temperature: opts.temperature,
        runId: opts.runId,
        system: opts.system,
      });
    } finally {
      this.running = false;
      this.emit();
    }
  }

  // ── events + persistence ────────────────────────────────────────────────────
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(fn: EditorListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** JSONL of the active edit records — pairs with `fromLog(base, jsonl)`. */
  exportLog(): string {
    return this.log.export();
  }

  /** A diff from the session's base story to the current story. */
  diffFromBase(): StoryDiff {
    return diffStories(this.log.baseStory, this.story);
  }

  /** A render-ready snapshot of the whole session state. */
  snapshot(): EditorSnapshot {
    const story = this.story;
    const v = validateStory(story);
    return {
      story,
      valid: v.success,
      issues: v.success ? [] : v.issues,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      records: this.records(),
      graph: this.graph(),
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this);
  }
}
