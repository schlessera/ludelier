# @ludelier/editor-core

## 0.2.0

### Minor Changes

- 6da3f7a: Replace the agent's step-budget with a run-until-done model: stream progress, interrupt anytime, checkpoint periodically.

  A fixed `maxSteps` cap made large tasks fail as "incomplete" and forced the user to guess a number. The new model lets the agent run as long as the work takes, with the human in the loop instead of a budget:

  - **`runAgent` runs until it finishes** (a clean `done`), the caller **interrupts** (`signal`), or a periodic **checkpoint** declines to continue (`onCheckpoint`, default every 500 turns). `maxSteps` is now an optional absolute backstop with no default (used by tests / non-interactive callers). The graph-health self-correction gate is unchanged.
  - **Streamed progress** via `onEvent` (`AgentEvent`: turn / assistant / edit / query / verify / stop) and a `stopReason` + `aborted` on the result. The provider now forwards an `AbortSignal` to its HTTP call so an interrupt cancels the in-flight request.
  - **System prompt** steers the agent to build **depth-first** — finish and wire each node before creating the next, never leaving empty placeholder nodes — so an interrupted or partial run degrades gracefully instead of leaving a skeleton.
  - **Editor** (`editor-web`): the chat panel shows a **live work feed**, an **Interrupt** button (with the current turn), and a **checkpoint prompt** (Continue / Stop); the per-run max-steps input is gone. `editor-core`'s `chat()` forwards `signal` / `onEvent` / `onCheckpoint` / `checkpointEvery`.
  - **CLI** (`author run`): streams edits to stderr, aborts on SIGINT, and reports `stop=<reason>`.

- 8b9d9d4: New `@ludelier/editor-core` package: the editor's headless session façade.

  `EditorSession` is the single parity surface a human UI and the agent both drive (AGENTS.md: anything a human can do in the editor, the agent can do through the same tasks). It owns the current `Story` as an event-sourced `EditLog`, routes reads to the world's understand tasks (`query`) and writes to the manipulate tasks (`edit`) through the always-valid `applyEdit` chokepoint, exposes `undo`/`redo`/`revertRun` + `canUndo`/`canRedo`, emits `change` events for a view to re-render, round-trips through `exportLog`/`fromLog`, and runs the agent `chat` loop **on the session's own log** so generated edits join the same undoable history. Pure — no DOM/React/network of its own (the LLM provider is injected); tested in Vitest without a browser. The React editor shell will be a thin view bound to it.

  Supporting changes:

  - `@ludelier/world`: `EditLog` gains `canUndo()` / `canRedo()`.
  - `@ludelier/authoring`: `runAgent` accepts an existing `log` to append the run onto (and measures its baseline/diff against that log's current story), so a session's chat edits integrate with its history.

- b4beead: Close the three open robustness issues from the architecture review.

  - **Defined comparison semantics (no silent coercion).** `compare` (engine reducer) no longer casts operands: `eq`/`ne` stay strict, and the ordered ops (`gt`/`lt`/`gte`/`lte`) are number-only — a non-number operand yields `false` instead of a coerced/lexical surprise. New `conditionTypeIssues` (world) statically flags ordered comparisons that can't behave as intended (a non-number literal, or a var `set` to a non-number elsewhere); `runAgent`'s gate surfaces newly-introduced ones so the agent fixes them before `done`.
  - **EditorSession run lock.** An agent `chat` run mutates the shared log across `await` boundaries and snapshots a pre-run baseline, so a concurrent human edit would corrupt the run's diff and break `revertRun`. `edit`/`revertRun` now refuse (return a failure) and `undo`/`redo`/a second `chat` throw while a run is in flight; a new `busy` getter lets the UI disable its controls. Reads stay allowed.
  - **Recoverable runtime cycle.** The reducer now throws a typed `StatementBudgetError` (exported from `@ludelier/engine`) on an infinite jump loop. The web player (`runtime-web`) and the editor play preview (`editor-web`) catch it — and any playback throw — and show a recoverable error (with a restart) instead of white-screening.

### Patch Changes

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
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/authoring@0.2.0
  - @ludelier/schema@0.2.0
  - @ludelier/world@0.2.0
