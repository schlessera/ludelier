import Dexie, { type Table } from "dexie";
import type { GameState } from "@ludelier/engine";

interface SaveRow {
  storyId: string;
  state: GameState;
  updatedAt: number;
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

export async function saveState(storyId: string, state: GameState): Promise<void> {
  await db.saves.put({ storyId, state, updatedAt: Date.now() });
}

export async function loadSave(storyId: string): Promise<GameState | null> {
  const row = await db.saves.get(storyId);
  return row?.state ?? null;
}

export async function clearSave(storyId: string): Promise<void> {
  await db.saves.delete(storyId);
}
