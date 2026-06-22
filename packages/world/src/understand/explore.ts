import { z } from "zod";
import { exploreStory, type ExploreReport } from "@ludelier/engine";
import type { Task } from "../registry";
import { ok } from "../result";

export type { ExploreReport } from "@ludelier/engine";

/**
 * Behavioural coverage: deterministically *runs* every reachable path (honouring `if`
 * conditions) and reports which nodes are actually reached, whether an ending is reachable,
 * and choices that gate themselves off. The runtime counterpart to the static `graph` task —
 * `graph` answers "is it wired?", `explore` answers "does it actually play through?".
 */
export const exploreTask: Task = {
  name: "explore",
  kind: "understand",
  description:
    "Run every reachable path (respecting if-conditions) and report reached nodes, whether an ending is reachable, and self-gated dead ends.",
  params: z.object({ seed: z.number().int().optional(), maxStates: z.number().int().min(1).optional() }),
  run: (story, params) => {
    const p = params as { seed?: number; maxStates?: number };
    const report: ExploreReport = exploreStory(story, p);
    return ok(report);
  },
};
