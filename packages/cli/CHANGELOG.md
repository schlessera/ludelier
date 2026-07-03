# @ludelier/cli

## 0.2.0

### Minor Changes

- c994198: Give the agent loop more room and clearer steering.

  - `runAgent`'s default `maxSteps` is raised from 12 to 24 so a run has room for self-correction rounds (a live gpt-5-mini run hit the old cap while recovering).
  - The agent system prompt now spells out the graph-health contract the `done` gate enforces: inspect first, make every new node reachable, give endings an `end`, never delete an existing `end` without replacing it, and verify with the `graph` tool before calling `done`.
  - `cli author run` gains a `--max-steps <n>` flag (positive integer) to override the per-run cap.

- 6da3f7a: Replace the agent's step-budget with a run-until-done model: stream progress, interrupt anytime, checkpoint periodically.

  A fixed `maxSteps` cap made large tasks fail as "incomplete" and forced the user to guess a number. The new model lets the agent run as long as the work takes, with the human in the loop instead of a budget:

  - **`runAgent` runs until it finishes** (a clean `done`), the caller **interrupts** (`signal`), or a periodic **checkpoint** declines to continue (`onCheckpoint`, default every 500 turns). `maxSteps` is now an optional absolute backstop with no default (used by tests / non-interactive callers). The graph-health self-correction gate is unchanged.
  - **Streamed progress** via `onEvent` (`AgentEvent`: turn / assistant / edit / query / verify / stop) and a `stopReason` + `aborted` on the result. The provider now forwards an `AbortSignal` to its HTTP call so an interrupt cancels the in-flight request.
  - **System prompt** steers the agent to build **depth-first** — finish and wire each node before creating the next, never leaving empty placeholder nodes — so an interrupted or partial run degrades gracefully instead of leaving a skeleton.
  - **Editor** (`editor-web`): the chat panel shows a **live work feed**, an **Interrupt** button (with the current turn), and a **checkpoint prompt** (Continue / Stop); the per-run max-steps input is gone. `editor-core`'s `chat()` forwards `signal` / `onEvent` / `onCheckpoint` / `checkpointEvery`.
  - **CLI** (`author run`): streams edits to stderr, aborts on SIGINT, and reports `stop=<reason>`.

- e6ec2c4: World API & agent harness — slice 1 (CLI-first).

  - New `@ludelier/world` package: a self-describing task registry (`describe()` manifest) of understand tasks (validate, graph, list-characters/assets/variables, get-node, find-references, simulate, diff) and a manipulate spine (create/delete-node, set-meta, add-character, register-asset, append-{say,show,choice,jump,end}, remove-statement, rewire-goto) applied through an always-valid `applyEdit` (validateStory + a world-local `say.who` check). Event-sourced `EditLog` with linear-history undo/redo, contiguous-tail `revertRun`, and JSONL export/import. Uniform `{success}` result envelope and a canonical `hashStory`.
  - `@ludelier/authoring`: additive provider tool-calling (`ToolDefinition`, `tools`/`toolCalls`, `role:"tool"` messages) on the OpenAI-compatible provider; a `worldTools`/`dispatch` tool adapter; and an autonomous `runAgent` loop that edits under one runId, self-verifies (validate + graph + simulate), and returns a reviewable, revertable result.
  - `@ludelier/cli`: registry-derived `world describe|query|edit|undo|redo|export` and `author run` subcommands; the entrypoint is now an exported `run(argv)`.
  - `@ludelier/schema`: extracted a shared `toJsonSchema(schema)` helper (used by the world manifest); `storyJsonSchema()` now calls it.

### Patch Changes

- 1faa3b4: Close the agent self-correction loop: feed graph self-verification back into `runAgent`.

  - `runAgent` now treats the `done` tool as a verification gate. When the model signals completion, the run is re-checked against a pre-run baseline; if the edits introduced any **new** unreachable or dead-end nodes (or invalidity), those problems are returned as `done` issues (or a feedback message when the model stops calling tools) so the model self-corrects, and the loop keeps going. Comparing against a baseline keeps the agent focused on its own edits — it is never asked to fix problems that already existed in the story it was handed.
  - `AgentRunResult.ok` now means **clean** (Zod-valid _and_ no new unreachable / dead-end nodes), not merely Zod-valid; `completed` is true only when the agent verified a clean run. This stops the loop from silently shipping a valid-but-broken story (e.g. a disconnected node, or a regression that deletes an existing `end`).
  - `cli author run` surfaces `ok` and any unreachable / dead-end nodes in its run summary.

- Updated dependencies [c994198]
- Updated dependencies [6da3f7a]
- Updated dependencies [1faa3b4]
- Updated dependencies [b4beead]
- Updated dependencies [e2da20a]
- Updated dependencies [8b9d9d4]
- Updated dependencies [0c00a17]
- Updated dependencies [b4beead]
- Updated dependencies [b8a118d]
- Updated dependencies [354782d]
- Updated dependencies [d746333]
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/authoring@0.2.0
  - @ludelier/schema@0.2.0
  - @ludelier/engine@0.2.0
  - @ludelier/world@0.2.0

## 0.1.0

### Minor Changes

- 00a221d: P0 headless core: deterministic Redux-style engine (seeded RNG, stable-hash snapshots, JSONL trace record/replay), Zod-validated Story DSL (`say`/`set`/`add`/`roll`/`choice`/`jump`/`end` + cross-reference validation + JSON Schema export), and a `validate`/`simulate`/`replay` CLI. No renderer yet.

### Patch Changes

- fd44662: P1 backgrounds + character sprites. Story DSL gains a central `assets` declaration and three non-blocking statements — `scene` (set/clear background, clears sprites), `show` (sprite in a named slot at left/center/right), `hide` — all cross-reference validated. The engine tracks a persistent `stage` (background + id-sorted sprites) threaded through the reducer and folded into the deterministic state hash, so replay covers visual state. The PixiJS renderer preloads declared assets, draws a cover-fit background and bottom-anchored sprites under the dialog UI on dedicated (configurable) layer z-indices, and crossfades background/sprite changes with a settle signal for screenshot tests. The runtime preloads assets and the `cafe` example now plays as a real visual novel (café background + character). `cli simulate` reports `stage`.
- Updated dependencies [00a221d]
- Updated dependencies [fd44662]
  - @ludelier/schema@0.1.0
  - @ludelier/engine@0.1.0
