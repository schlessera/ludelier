import type { Story } from "@ludelier/schema";
import type { Registry } from "./registry";
import { applyEdit, validateWorld } from "./applyEdit";
import { fail, ok, type Result } from "./result";
import { normalizeStatementIds, nextStatementId } from "./statement-id";

/**
 * One event in the authoring history. The canonical fold uses only these fields —
 * no wall-clock — so log replay reproduces a canonically-identical Story (KTD-6).
 */
export interface EditRecord {
  seq: number;
  runId: string;
  command: string;
  params: unknown;
}

/**
 * Event-sourced authoring document: `{ baseStory, records }` with a head index.
 * `currentStory = fold(applyEdit, baseStory, records[0..head])`. History is strictly
 * linear (KTD-11): a new edit after `undo` discards the orphaned redo tail; `revertRun`
 * only drops a contiguous tail. `runId` is caller-supplied and assumed unique per run.
 */
export class EditLog {
  readonly baseStory: Story;
  private readonly world: Registry;
  private records: EditRecord[] = [];
  /** Number of active records: records[0..head-1] are folded into currentStory. */
  private head = 0;
  /**
   * Memoized fold at the current head (KTD-2 fix). `apply` sets it to the new tip directly (no
   * refold), so a sequence of N edits is O(N), not O(N²). Head-moving ops that can't cheaply
   * derive the tip (undo/redo/revertRun) clear it to `null`, forcing one lazy refold on next read.
   */
  private current: Story | null;

  constructor(world: Registry, baseStory: Story) {
    this.world = world;
    // Every statement carries a stable id from here on — so edits can target by identity, and
    // a refold reproduces identical ids (the appended ones are baked into each record's params).
    this.baseStory = normalizeStatementIds(baseStory);
    this.current = this.baseStory; // head === 0 ⇒ current story is the base
  }

  /** O(n) refold over the active records — only run when the memo was invalidated. */
  private fold(): Story {
    let story = this.baseStory;
    for (let i = 0; i < this.head; i++) {
      const rec = this.records[i]!;
      const res = applyEdit(this.world, story, rec.command, rec.params);
      if (!res.success) {
        throw new Error(`fold failed at seq ${rec.seq} (${rec.command}): ${JSON.stringify(res.issues)}`);
      }
      story = res.data;
    }
    return story;
  }

  /** The folded story at the current head (memoized — see `current`). */
  currentStory(): Story {
    if (this.current === null) this.current = this.fold();
    return this.current;
  }

  /** Apply a command on the current story; append a record on success (log unchanged on failure). */
  apply(command: string, params: unknown, opts: { runId: string }): Result<Story> {
    // add-statement creates a new statement; bake a deterministic stable id into the record (seq
    // is the seq this record will take — post-truncation length === head) so a refold reproduces
    // it. A re-applied/imported record already carries its id, so we never overwrite one.
    const seq = this.head;
    let finalParams = params;
    if (command === "add-statement") {
      const sp = params as { statement?: { id?: string } };
      if (sp.statement && sp.statement.id === undefined) {
        finalParams = { ...(params as Record<string, unknown>), statement: { ...sp.statement, id: nextStatementId(seq) } };
      }
    }
    const res = applyEdit(this.world, this.currentStory(), command, finalParams);
    if (!res.success) return res;
    // Linear-history (KTD-11): a new edit after undo discards the orphaned redo tail.
    if (this.head < this.records.length) this.records = this.records.slice(0, this.head);
    this.records.push({ seq: this.records.length, runId: opts.runId, command, params: finalParams });
    this.head = this.records.length;
    this.current = res.data; // the applied result IS the new tip — keep the memo warm (no refold)
    return res;
  }

  /** Whether there is an active record to undo (head > 0). */
  canUndo(): boolean {
    return this.head > 0;
  }

  /** Whether there is an undone record to redo (an orphaned tail past the head). */
  canRedo(): boolean {
    return this.head < this.records.length;
  }

  undo(): Story {
    if (this.head > 0) this.head--;
    this.current = null; // head moved back — refold lazily
    return this.currentStory();
  }

  redo(): Story {
    if (this.head < this.records.length) this.head++;
    this.current = null; // head moved forward — refold lazily
    return this.currentStory();
  }

  /**
   * Drop a run's records. Defined only when the run's records form a **contiguous tail**
   * of the active history (KTD-11) — otherwise it fails rather than dropping unrelated records.
   */
  revertRun(runId: string): Result<Story> {
    const active = this.records.slice(0, this.head);
    const firstIdx = active.findIndex((r) => r.runId === runId);
    if (firstIdx === -1) {
      return fail([{ path: "runId", message: `no active records for run "${runId}"` }]);
    }
    for (let i = firstIdx; i < active.length; i++) {
      if (active[i]!.runId !== runId) {
        return fail([
          { path: "runId", message: `run "${runId}" is not a contiguous tail (interleaved at seq ${active[i]!.seq})` },
        ]);
      }
    }
    this.records = this.records.slice(0, firstIdx);
    this.head = this.records.length;
    this.current = null; // history truncated — refold lazily
    return ok(this.currentStory());
  }

  /** The active records (records[0..head]) — what export emits and review inspects. */
  recordsView(): EditRecord[] {
    return this.records.slice(0, this.head);
  }

  /** JSONL of the active records (one per line). */
  export(): string {
    return this.recordsView().map((r) => JSON.stringify(r)).join("\n");
  }
}

/**
 * Rebuild an EditLog from a base story + a JSONL export. The base is checked with the
 * **stricter** validator (validateStory + say.who, KTD-3) so the always-valid invariant
 * covers the base and imported logs, not only incremental edits.
 */
export function importLog(world: Registry, base: unknown, jsonl: string): Result<EditLog> {
  const baseRes = validateWorld(base);
  if (!baseRes.success) return baseRes;
  const log = new EditLog(world, baseRes.data);
  const lines = jsonl.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const rec = JSON.parse(line) as EditRecord;
    const res = log.apply(rec.command, rec.params, { runId: rec.runId });
    if (!res.success) return res;
  }
  return ok(log);
}
