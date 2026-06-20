export * from "./result";
export * from "./canonical";
export * from "./registry";

import { Registry } from "./registry";

/**
 * Build a fresh world with every task registered. The single registry is the
 * source for `describe()`, the CLI subcommands, and the agent's toolset (parity).
 * Tasks are added by U2/U3/U4/U10/U11/U12 as they land.
 */
export function createWorld(): Registry {
  const world = new Registry();
  return world;
}

/** The default shared world instance. */
export const world = createWorld();
