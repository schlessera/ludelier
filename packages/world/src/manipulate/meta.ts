import { z } from "zod";
import type { Task } from "../registry";
import { ok } from "../result";
import { slugId } from "./ids";

export const setMetaTask: Task = {
  name: "set-meta",
  kind: "manipulate",
  description: "Patch story meta (title, start node, seed).",
  params: z.object({
    title: z.string().min(1).optional(),
    start: slugId.optional(),
    seed: z.number().int().optional(),
  }),
  apply: (story, params) => {
    const p = params as { title?: string; start?: string; seed?: number };
    return ok({
      ...story,
      meta: {
        ...story.meta,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.start !== undefined ? { start: p.start } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
      },
    });
  },
};
