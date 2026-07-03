import { z } from "zod";
import { StoryObject, type Story } from "@ludelier/schema";
import type { Task } from "../registry";
import { ok } from "../result";
import { stableStringify } from "../canonical";
import { compareStr } from "../sort";

export interface IdSetDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface StoryDiff {
  meta: "unchanged" | "changed";
  nodes: IdSetDiff;
  characters: IdSetDiff;
  assets: IdSetDiff;
}

function eq(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function diffById<T extends { id: string }>(from: T[], to: T[]): IdSetDiff {
  const fm = new Map(from.map((x) => [x.id, x] as const));
  const tm = new Map(to.map((x) => [x.id, x] as const));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const id of tm.keys()) if (!fm.has(id)) added.push(id);
  for (const id of fm.keys()) if (!tm.has(id)) removed.push(id);
  for (const [id, x] of fm) {
    const y = tm.get(id);
    if (y && !eq(x, y)) changed.push(id);
  }
  return {
    added: added.sort(compareStr),
    removed: removed.sort(compareStr),
    changed: changed.sort(compareStr),
  };
}

export function diffStories(from: Story, to: Story): StoryDiff {
  return {
    meta: eq(from.meta, to.meta) ? "unchanged" : "changed",
    nodes: diffById(from.nodes, to.nodes),
    characters: diffById(from.characters, to.characters),
    assets: diffById(from.assets, to.assets),
  };
}

/**
 * Structural diff from a baseline story (`from`) to the task's story. Sorted output is
 * stable regardless of authored order. Feeds run review (U7): `diff(base, current)`.
 */
export const diffTask: Task = {
  name: "diff",
  kind: "understand",
  description: "Structural diff (added/removed/changed) from a baseline story to this one.",
  params: z.object({ from: StoryObject }),
  run: (story, params) => {
    const { from } = params as { from: Story };
    return ok(diffStories(from, story));
  },
};
