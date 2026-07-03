# @ludelier/editor-web

## 0.2.0

### Minor Changes

- 6da3f7a: Replace the agent's step-budget with a run-until-done model: stream progress, interrupt anytime, checkpoint periodically.

  A fixed `maxSteps` cap made large tasks fail as "incomplete" and forced the user to guess a number. The new model lets the agent run as long as the work takes, with the human in the loop instead of a budget:

  - **`runAgent` runs until it finishes** (a clean `done`), the caller **interrupts** (`signal`), or a periodic **checkpoint** declines to continue (`onCheckpoint`, default every 500 turns). `maxSteps` is now an optional absolute backstop with no default (used by tests / non-interactive callers). The graph-health self-correction gate is unchanged.
  - **Streamed progress** via `onEvent` (`AgentEvent`: turn / assistant / edit / query / verify / stop) and a `stopReason` + `aborted` on the result. The provider now forwards an `AbortSignal` to its HTTP call so an interrupt cancels the in-flight request.
  - **System prompt** steers the agent to build **depth-first** — finish and wire each node before creating the next, never leaving empty placeholder nodes — so an interrupted or partial run degrades gracefully instead of leaving a skeleton.
  - **Editor** (`editor-web`): the chat panel shows a **live work feed**, an **Interrupt** button (with the current turn), and a **checkpoint prompt** (Continue / Stop); the per-run max-steps input is gone. `editor-core`'s `chat()` forwards `signal` / `onEvent` / `onCheckpoint` / `checkpointEvery`.
  - **CLI** (`author run`): streams edits to stderr, aborts on SIGINT, and reports `stop=<reason>`.

- 69a1f0b: Embed the live Pixi play preview in the editor, closing the edit → see loop.

  - New `PlayCanvas` mounts the display-only `@ludelier/renderer-pixi` renderer and replays the session's current story (from its start) on every edit — background, sprites, dialog, and choices render live beside the editing surface. Advancing/choosing drives a throwaway `Simulation`, never the authored story. The renderer lifecycle is StrictMode-safe (destroy is deferred until async `mount()` completes). Assets are served from the shared `runtime-web/public` (`publicDir`), loaded once and reused across replays.
  - Replaced the `+ Node` `prompt()`/`alert()` with an inline node-id input + inline error (better UX; no blocking dialogs).

  Verified in a headless browser: renders the café scene; a manual `create-node` updates the node list, graph-health (flags the new node unreachable + dead end), history, and the preview live; undo reverts it; clean load reports no console errors.

- 734ddb3: New `@ludelier/editor-web` package: the React editor shell (slice 1).

  A Vite + React app — a thin view bound to `@ludelier/editor-core`'s `EditorSession` — that makes the agent-native editor visible:

  - **Agent chat** panel (BYOK OpenRouter key + model slug) that runs `session.chat(...)`, then shows the run's edits, clean/completed status, any unreachable/dead-end problems, and a **Revert this run** button.
  - **Story inspector** — node list with start / unreachable / dead-end badges; click a node to see its statements.
  - **Graph health + history** — validity, reachability counts, unreachable/dead-end lists, the edit-log records, and a copy-edit-log (JSONL) action.
  - **Toolbar** — validity badge, undo/redo (gated on `canUndo`/`canRedo`), and add-node — demonstrating that manual edits and agent edits share one undoable history.

  Verified live: builds (tsc + vite), renders in a headless browser, and the reactive binding (`subscribe` → re-render) updates inspector + graph health on selection and edits. The build is wired into `just build` / `just check`.

- 50ab9ec: Add a read-only **story map** to the editor — a flow diagram of the branching structure.

  The center column now shows an auto-laid-out graph (React Flow + dagre, layered top-down): one box per node, a labelled directed edge for every `choice` / `jump` / `branch` (conditional edges styled distinctly), and start / unreachable / dead-end badges read from the session's graph analysis. Clicking a node opens a read-only, screenplay-style **script lens** of its statements (with stable ids surfaced) and plays the embedded preview **from that node**. The map, lens, and preview re-render on every session change (agent edit, undo, redo, revert). It replaces the old text-list inspector; editing stays agent-only, and node positions are always auto-computed, never stored in the story.

### Patch Changes

- e2da20a: Add the `branch` statement — state-driven conditional flow — and extend the demo to use it.

  `branch` is a conditional jump: if its `cond` ({var,cmp,value}) holds it continues at `goto`, otherwise it falls through to the next statement. It is the missing control-flow primitive for basic visual novels — until now the only way to branch was a player `choice`, so computed state (accumulated trust, a dice roll) couldn't change the story by itself. Chain several `branch`es for if/elif/else. Unlike `jump` it is not terminal, so statements may follow it.

  Wired end-to-end through the existing layers:

  - **schema** — `BranchStatement` in the discriminated union; `validateStory` cross-refs `branch.goto` to a known node.
  - **engine** — the reducer takes the goto when the condition holds (reusing the type-safe `compare`), else falls through; covered by the statement-budget / determinism guards like any jump.
  - **world** — `graph` counts the branch goto as an edge (reachability + dead-end analysis see it), `find-references` and `rewire-goto` handle it, and the variable checks (`unwrittenVarReads` / `conditionTypeIssues`) now scan branch conditions too.
  - **authoring / editor** — the author and agent prompts document `branch`, and the editor inspector summarizes it.

  Demo (`examples/cafe.story.json`): the café story now uses `branch` for two state-driven outcomes — a luck-based "lucky" ending (the previously-dead `roll` of `luck` now matters) and a trust-based regret line on the leave path — adds `her` as a speaking character, and a new "Ask about her day" path. The opening frame and the existing play-through are unchanged (e2e green).

- 0c00a17: Replace the flattened append-_/insert-_ statement spine with generic statement tools.

  The per-kind × per-position command design (append-say, append-show, …, insert-say, …) grew the toolset toward 50+ as statement kinds multiply — and the long tail (set/add/roll/scene/hide) was never even built. It was a hedge against LLMs mis-filling a discriminated union; that no longer holds (Zod 4 emits a clean `oneOf`, and a prototype confirmed gpt-5-mini fills the union reliably across kinds).

  - `add-statement {nodeId, statement, before?}` — one tool for every statement kind (and every future kind): `statement` is the schema's `Statement` union; appends at the end, or inserts before `before` (a statement id).
  - `update-statement {nodeId, statementId, statement}` — replace a statement in place (keeps its id).
  - `move-statement {nodeId, statementId, before?}` — reorder.
  - `remove-statement` / `rewire-goto` unchanged (target by id).

  Manipulate tools drop from 15 to 10 and stay flat as the DSL grows. All guardrails are unchanged (terminal-position rule, say.who, cross-refs); the EditLog now bakes the stable id into `params.statement.id` for `add-statement`. The agent prompt and the editor's edit feed are updated for the new tools.

- b4beead: Close the three open robustness issues from the architecture review.

  - **Defined comparison semantics (no silent coercion).** `compare` (engine reducer) no longer casts operands: `eq`/`ne` stay strict, and the ordered ops (`gt`/`lt`/`gte`/`lte`) are number-only — a non-number operand yields `false` instead of a coerced/lexical surprise. New `conditionTypeIssues` (world) statically flags ordered comparisons that can't behave as intended (a non-number literal, or a var `set` to a non-number elsewhere); `runAgent`'s gate surfaces newly-introduced ones so the agent fixes them before `done`.
  - **EditorSession run lock.** An agent `chat` run mutates the shared log across `await` boundaries and snapshots a pre-run baseline, so a concurrent human edit would corrupt the run's diff and break `revertRun`. `edit`/`revertRun` now refuse (return a failure) and `undo`/`redo`/a second `chat` throw while a run is in flight; a new `busy` getter lets the UI disable its controls. Reads stay allowed.
  - **Recoverable runtime cycle.** The reducer now throws a typed `StatementBudgetError` (exported from `@ludelier/engine`) on an infinite jump loop. The web player (`runtime-web`) and the editor play preview (`editor-web`) catch it — and any playback throw — and show a recoverable error (with a restart) instead of white-screening.

- b8a118d: Stable statement ids: target statement edits by identity, not by a fragile position.

  The agent kept miscounting statement positions — e.g. asked to replace a node's first line, it removed the wrong statement (a choice instead of the stale say) and left the old line behind, yet the run still verified "clean" (graph health was unaffected). Index-based targeting is the root cause.

  - **schema**: every statement gains an optional stable `id`. Optional, so authored/legacy stories stay valid; the world fills any gaps.
  - **world**: `normalizeStatementIds` assigns positional ids (`"<nodeId>#<i>"`) when a story is loaded into the `EditLog`; statement-creating commands get a monotonic `"s<seq>"` baked into their edit record, so a refold reproduces ids deterministically (collision-safe across remove+append — the determinism invariant holds, and `hashStory` now covers ids). `remove-statement` and `rewire-goto` now take a **`statementId`** (the old `index` param is gone); `get-node` surfaces the ids.
  - **authoring**: the agent system prompt instructs targeting existing statements by their `id` from `get-node`.
  - **editor-web**: the node inspector shows each statement's id, and the chat feed shows the targeted `statementId`.

  Verified live: asked to remove one statement from a node, the agent now removes exactly the right one by id; the others keep their ids.

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
  - @ludelier/editor-core@0.2.0
  - @ludelier/schema@0.2.0
  - @ludelier/engine@0.2.0
  - @ludelier/world@0.2.0
  - @ludelier/renderer-pixi@0.1.1
