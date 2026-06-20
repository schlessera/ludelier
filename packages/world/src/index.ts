export * from "./result";
export * from "./canonical";
export * from "./registry";
export * from "./sort";

import { Registry } from "./registry";
import { validateTask } from "./understand/validate";
import { listCharactersTask, listAssetsTask, listVariablesTask } from "./understand/lists";
import { getNodeTask } from "./understand/get-node";
import { findReferencesTask } from "./understand/references";

/**
 * Build a fresh world with every task registered. The single registry is the
 * source for `describe()`, the CLI subcommands, and the agent's toolset (parity).
 * Tasks are added by U3/U4/U10/U11/U12 as they land.
 */
export function createWorld(): Registry {
  const world = new Registry();
  // U2 — understand (pure reads)
  world.register(validateTask);
  world.register(listCharactersTask);
  world.register(listAssetsTask);
  world.register(listVariablesTask);
  world.register(getNodeTask);
  world.register(findReferencesTask);
  return world;
}

/** The default shared world instance. */
export const world = createWorld();
