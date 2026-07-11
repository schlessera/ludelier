# @ludelier/editor-core

## 0.3.0

### Minor Changes

- a7a9d91: Add multi-provider AI image and audio generation with model-capability routing, redacted provenance, verified host persistence, and cache recovery. Extend Story media metadata and deterministic audio cues, then expose the same authorized asset workflow through the CLI, MCP, editor panel, and agent chat. Browser playback now uses the shared Howler adapter with image-only Pixi preload, generated-voice disclosure, and save compatibility gating.
- a7a9d91: Surface bounded all-paths runtime coverage in the editor. `EditorSession.snapshot()` now
  carries an `explore` report (played-through nodes, whether an ending is reachable, self-gated
  `stuck` nodes, and `truncated`/`crashed` flags) alongside the static `graph` — computed via the
  same `explore` task the agent's `done` gate verifies against, so the human editor has parity
  with what the agent sees.

  The editor **Health** tab renders it beside the static wiring, including the actionable
  static-vs-runtime divergence (nodes statically wired but never played, warning-grade) and folds
  the blocking runtime signals (no ending reachable, stuck, crashed) into the Health-tab warning
  dot. `HealthPanel` is extracted to a pure, prop-driven component.

  Also adds a jsdom + React Testing Library component-test harness for the editor, covering
  `HealthPanel`, the manifest-driven `TaskForm`, and the `ScriptLens`.

### Patch Changes

- Updated dependencies [a7a9d91]
  - @ludelier/schema@0.3.0
  - @ludelier/world@0.3.0
  - @ludelier/authoring@0.3.0

## 0.2.0

### Minor Changes

- 6da3f7a: Replace the agent's step-budget with a run-until-done model: stream progress, interrupt anytime, checkpoint periodically.

  A fixed `maxSteps` cap made large tasks fail as "incomplete" and forced the user to guess a number. The new model lets the agent run as long as the work takes, with the human in the loop instead of a budget:

  - **`runAgent` runs until it finishes** (a clean `done`), the caller **interrupts** (`signal`), or a periodic **checkpoint** declines to continue (`onCheckpoint`, default every 500 turns). `maxSteps` is now an optional absolute backstop with no default (used by tests / non-interactive callers). The graph-health self-correction gate is unchanged.
  - **Streamed progress** via `onEvent` (`AgentEvent`: turn / assistant / edit / query / verify / stop) and a `stopReason` + `aborted` on the result. The provider now forwards an `AbortSignal` to its HTTP call so an interrupt cancels the in-flight request.
  - **System prompt** steers the agent to build **depth-first** — finish and wire each node before creating the next, never leaving empty placeholder nodes — so an interrupted or partial run degrades gracefully instead of leaving a skeleton.
  - **Editor** (`editor-web`): the chat panel shows a **live work feed**, an **Interrupt** button (with the current turn), and a **checkpoint prompt** (Continue / Stop); the per-run max-steps input is gone. `editor-core`'s `chat()` forwards `signal` / `onEvent` / `onCheckpoint` / `checkpointEvery`.
  - **CLI** (`author run`): streams edits to stderr, aborts on SIGINT, and reports `stop=<reason>`.

- 9ffb0ae: Parity payoff: manifest-driven human edit forms + story open/save/new/import in the editor.

  Until now the only manual edits were add-node and undo/redo — everything else needed the
  agent chat, undercutting the repo's core "agent-native parity" claim in the human direction.
  Two features close that gap (repo review §3):

  - **Manifest-driven edit forms.** A pure derivation layer (`editor-web/src/forms/model.ts`)
    turns each manipulate task's `describe()` JSON Schema into a form-field model — objects,
    string/number/boolean/enum fields, nested objects, scalar (VarValue) inputs, and `oneOf`
    unions discriminated on `op` (the statement union renders as an op selector driving the
    variant's fields). Anything unsupported (e.g. `choice.options` arrays) degrades to a
    raw-JSON textarea — never a dead end. A generic `<TaskForm>` renders the model and submits
    through `EditorSession.edit()` — the same always-valid chokepoint the agent uses, so form
    edits are undoable and `{success:false}` issues (including the new choice-is-terminal rule)
    render inline as path + message. A future manipulate task gets a working human form with
    zero editor code.
  - **Context-aware entry points.** The script lens grows per-statement _edit_ (update-statement
    prefilled with the statement's current value + id) and _delete_ (remove-statement) buttons
    plus an _add statement_ form on the selected node; the side panel lists every manipulate
    task as a collapsible form (set-meta prefilled from live meta).
  - **Story open / save / new / log import.** Toolbar: _Open_ (`.story.json` → parse +
    `validateStory`; an invalid file reports its issues and keeps the current session), _Save_
    (pretty-printed download named `<meta.id>.story.json`), _New_ (minimal valid scaffold —
    start node with a say + end + narrator). Side panel: _Import log_ replays an exported
    `.log.jsonl` onto the current session's base story via `EditorSession.fromLog`. Sessions
    swap at runtime; the play preview remounts per swap, surfaces missing-asset preloads as its
    inline error, and now detects cross-story asset-id collisions (same id, different src)
    instead of silently rendering the previous story's texture.
  - **editor-core:** new `EditorSession.baseStory` getter — the (id-normalized) story that
    `exportLog()` JSONL replays on, so a UI can pair the two for import.

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
- Updated dependencies [6eddc7e]
- Updated dependencies [8b9d9d4]
- Updated dependencies [f82d28c]
- Updated dependencies [0c00a17]
- Updated dependencies [b4beead]
- Updated dependencies [b8fe968]
- Updated dependencies [b8a118d]
- Updated dependencies [354782d]
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/authoring@0.2.0
  - @ludelier/schema@0.2.0
  - @ludelier/world@0.2.0
