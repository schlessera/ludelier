import { z } from "zod";
import { Simulation, type Action } from "@ludelier/engine";
import type { Task } from "../registry";
import { ok } from "../result";
import { compareStr } from "../sort";

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADVANCE") }),
  z.object({ type: z.literal("CHOOSE"), index: z.number().int().min(0) }),
]);

/**
 * Deterministic headless run wrapping `engine.Simulation`. `reached` is NOT on the
 * Simulation surface (the engine tracks no visited-node set) — it is accumulated here
 * from each step's cursor and sorted for determinism.
 */
export const simulateTask: Task = {
  name: "simulate",
  kind: "understand",
  description: "Run the story headlessly with an explicit actions list and seed.",
  params: z.object({ actions: z.array(ActionSchema), seed: z.number().int().optional() }),
  run: (story, params) => {
    const p = params as { actions: Action[]; seed?: number };
    const sim = new Simulation(story, p.seed !== undefined ? { seed: p.seed } : {});
    const reached = new Set<string>([sim.state.cursor.node]);
    for (const action of p.actions) {
      sim.dispatch(action);
      reached.add(sim.state.cursor.node);
    }
    return ok({
      finalState: sim.state,
      transcript: sim.transcript(),
      hash: sim.hash(),
      reached: [...reached].sort(compareStr),
    });
  },
};
