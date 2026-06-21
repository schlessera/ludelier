import type { Story } from "@ludelier/schema";
import type { Registry } from "./registry";
import { applyEdit, validateWorld } from "./applyEdit";
import { fail, ok, type Result } from "./result";

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

  constructor(world: Registry, baseStory: Story) {
    this.world = world;
    this.baseStory = baseStory;
  }

  /** O(n) refold over the active records (KTD-2 — accepted for slice-1 sizes). */
  currentStory(): Story {
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

  /** Apply a command on the current story; append a record on success (log unchanged on failure). */
  apply(command: string, params: unknown, opts: { runId: string }): Result<Story> {
    const res = applyEdit(this.world, this.currentStory(), command, params);
    if (!res.success) return res;
    // Linear-history (KTD-11): a new edit after undo discards the orphaned redo tail.
    if (this.head < this.records.length) this.records = this.records.slice(0, this.head);
    this.records.push({ seq: this.records.length, runId: opts.runId, command, params });
    this.head = this.records.length;
    return res;
  }

  undo(): Story {
    if (this.head > 0) this.head--;
    return this.currentStory();
  }

  redo(): Story {
    if (this.head < this.records.length) this.head++;
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
