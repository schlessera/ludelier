export * from "./result";
export * from "./canonical";
export * from "./registry";
export * from "./sort";
export * from "./applyEdit";
export * from "./log";
export * from "./statement-id";
export type { GraphReport } from "./understand/graph";
export type { Reference } from "./understand/references";
export { diffStories, type StoryDiff, type IdSetDiff } from "./understand/diff";
export { exploreTask, type ExploreReport } from "./understand/explore";
export { unwrittenVarReads, conditionTypeIssues } from "./understand/variables";

import { Registry } from "./registry";
import { validateTask } from "./understand/validate";
import { listCharactersTask, listAssetsTask, listVariablesTask } from "./understand/lists";
import { getNodeTask } from "./understand/get-node";
import { findReferencesTask } from "./understand/references";
import { graphTask } from "./understand/graph";
import { simulateTask } from "./understand/simulate";
import { exploreTask } from "./understand/explore";
import { diffTask } from "./understand/diff";
import { createNodeTask, deleteNodeTask } from "./manipulate/nodes";
import { setMetaTask } from "./manipulate/meta";
import { addCharacterTask } from "./manipulate/characters";
import { registerAssetTask } from "./manipulate/assets";
import { rewireGotoTask } from "./manipulate/flow";
import {
  addStatementTask,
  updateStatementTask,
  moveStatementTask,
  removeStatementTask,
} from "./manipulate/statements";

/**
 * Build a fresh world with every task registered. The single registry is the
 * source for `describe()`, the CLI subcommands, and the agent's toolset (parity).
 * Tasks are added by U4/U10/U11/U12 as they land.
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
  // U10/U11/U12 — understand (graph, simulate, diff) + explore (behavioural coverage)
  world.register(graphTask);
  world.register(simulateTask);
  world.register(exploreTask);
  world.register(diffTask);
  // U3 — manipulate (the spine)
  world.register(createNodeTask);
  world.register(deleteNodeTask);
  world.register(setMetaTask);
  world.register(addCharacterTask);
  world.register(registerAssetTask);
  world.register(rewireGotoTask);
  // Generic statement ops (one `add-statement` covers every kind — flat as the DSL grows).
  world.register(addStatementTask);
  world.register(updateStatementTask);
  world.register(moveStatementTask);
  world.register(removeStatementTask);
  return world;
}

/** The default shared world instance. */
export const world = createWorld();
