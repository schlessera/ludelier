import Dexie, { type Table } from "dexie";
import type { GameState } from "@ludelier/engine";

/**
 * Bump when the persisted `GameState` shape changes. A resumed save is restored blindly
 * into the running Simulation, so a stale shape (or a stale story — see `storyHash`) must
 * be discarded rather than trusted: with the PWA auto-updating underneath saved games, a
 * changed story can otherwise strand the cursor on a node that no longer exists.
 */
export const SAVE_VERSION = 1;

interface SaveRow {
  storyId: string;
  state: GameState;
  updatedAt: number;
  /** Fingerprint of the story the state was produced by (engine `hashState(story)`). */
  storyHash: string;
  saveVersion: number;
}

/** Local-first save store. Cloud sync (Dexie Cloud) is the planned P4 upsell — drop-in on top of this. */
class SaveDB extends Dexie {
  saves!: Table<SaveRow, string>;
  constructor() {
    super("ludelier");
    this.version(1).stores({ saves: "storyId" });
  }
}

const db = new SaveDB();

export async function saveState(storyId: string, storyHash: string, state: GameState): Promise<void> {
  await db.saves.put({ storyId, state, updatedAt: Date.now(), storyHash, saveVersion: SAVE_VERSION });
}

/**
 * Load a save only if it matches the current story + save format — anything else
 * (older format, edited story, pre-versioning row) is treated as no save.
 */
export async function loadSave(storyId: string, storyHash: string): Promise<GameState | null> {
  const row = await db.saves.get(storyId);
  if (!row) return null;
  if (row.saveVersion !== SAVE_VERSION || row.storyHash !== storyHash) return null;
  return row.state;
}

export async function clearSave(storyId: string): Promise<void> {
  await db.saves.delete(storyId);
}
