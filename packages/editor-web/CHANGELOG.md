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

- 69a1f0b: Embed the live Pixi play preview in the editor, closing the edit → see loop.

  - New `PlayCanvas` mounts the display-only `@ludelier/renderer-pixi` renderer and replays the session's current story (from its start) on every edit — background, sprites, dialog, and choices render live beside the editing surface. Advancing/choosing drives a throwaway `Simulation`, never the authored story. The renderer lifecycle is StrictMode-safe (destroy is deferred until async `mount()` completes). Assets are served from the shared `runtime-web/public` (`publicDir`), loaded once and reused across replays.
  - Replaced the `+ Node` `prompt()`/`alert()` with an inline node-id input + inline error (better UX; no blocking dialogs).

  Verified in a headless browser: renders the café scene; a manual `create-node` updates the node list, graph-health (flags the new node unreachable + dead end), history, and the preview live; undo reverts it; clean load reports no console errors.

- e62fdf9: Editor UX: per-run revert in History, play position survives edits, a crash boundary, and an opt-in remembered key.

  - **Per-run revert.** The History panel now groups the edit log by run (chat runs, form edits, CLI-style manual runs) and offers Revert on the run that can actually be reverted — `revertRun` is defined only for a contiguous tail of the history, so exactly one group is actionable. The chat panel's revert stays, but is no longer the only (and no longer an ephemeral) path.
  - **The play preview holds its position across edits.** The preview records its own ADVANCE/CHOOSE history and replays it against the edited story instead of restarting from the top on every change; the reducer's guards make stale actions harmless, and only an engine throw (an edit introduced a loop on the replayed path) falls back to a clean restart. Restart and play-from-here explicitly drop the history.
  - **Error boundary.** A render crash anywhere in the editor tree now shows a recoverable "reload the editor" screen (with a your-story-is-safe note) instead of a white page.
  - **Remember key (opt-in).** A labelled checkbox persists the BYOK OpenRouter key in localStorage — off by default, clearly marked as unencrypted, cleared by unticking.
  - **Forms fix:** an optional object whose required enum was still at its pre-selected seed (e.g. a choice option's untouched `if` condition, `cmp` at "eq") no longer collects as an empty condition the world then rejects.

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

- 4693d1d: Playwright smoke coverage for the editor shell: a second `editor` e2e project (port 5180, same SwiftShader Chromium) drives the real UI end-to-end — load (valid badge + café title), story map nodes with start/unreachable/dead-end badges, click-to-open script lens, toolbar create-node + undo, a manifest-driven `set-meta` form edit that updates the toolbar title, and the live play-preview canvas.

  - **Functional-only, concrete waits.** No visual baseline (the Pixi canvas is visually covered by runtime-web); every wait is a real signal — a new `data-ready` flag flips after the shell's first render, everything else waits on selectors/text, never timeouts.
  - **Minimal stable hooks** added to the shell: `data-testid` on the validity badge, story title, new-node input, map nodes (`map-node-<id>`), and the script lens.
  - **Both server-management paths covered:** `just e2e` now starts + curl-health-checks both dev servers and cleans up by port (the WSL2 connect-hang pattern, STATUS §11); CI keeps plain `pnpm e2e` via Playwright's `webServer` array.

- 43f7d84: Responsive editor layout + correct story-map framing on story switch.

  - The three-column layout now adapts: below 1280px the center column (preview + map + lens) goes full-width with chat and the side panel sharing a row beneath (and the page scrolls instead of pinning to the viewport); below 820px everything stacks in a single column, center first, with a wrapping toolbar.
  - The story map is keyed by the session-swap counter: Open/New now re-frames the new story instead of keeping the previous story's pan/zoom over a different graph. Within a session, edits still deliberately preserve the viewport — the map controls' fit button re-frames on demand.

- f82d28c: The agent gate gains a non-blocking warnings channel; the always-valid invariant gains a fuzz harness.

  - **Runtime-unreached warnings.** `Verification` now reports `runtimeUnreached` — nodes that are statically reachable but that no condition-honouring play-through ever visits (every path in is gated off). Newly-introduced ones surface as **warnings** delivered _with_ an accepted `done` (`{ok:true, warnings:[…]}`) and on the `verify` event — visible to the model and in the editor's feed, but never wedging the loop, since a branch awaiting its unlock legitimately looks like this mid-build. (Closes the last open follow-up from `docs/architecture-risks.md`.)
  - **Seeded fuzz over `applyEdit`** (world tests): 2×400 randomly generated commands — colliding ids, dangling refs, stale statement targets, interleaved undo/redo — asserting the story validates after every single apply, nothing ever throws, and the surviving history refolds byte-identically through export → import. Deterministic via the engine's own PRNG, so any failure reproduces from its seed.

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

- 7e4c2be: Repo-review correctness batch (presentation): character names/colors render, asset failures surface, saves invalidate, preview error recovery, reachable checkpoints.

  Five fixes from the 2026-07-03 repo review (see `docs/plans/2026-07-03-001-repo-review-implementation.md`):

  - **Dialog shows the declared character, not its id.** The engine's `pending.who` is the character _id_; the renderer displayed it verbatim in one hardcoded blue, so the schema's `Character.name`/`color` were dead at runtime ("narrator" instead of "Narrator", no per-character colors). New `PixiRenderer.setCharacters()` declares the cast; dialog resolves id → display name + color (fallback unchanged). The player wires it at startup, the editor preview re-wires per edit. Visual baseline regenerated.
  - **Asset-load failure shows the error overlay.** `renderer.mount()`/`preload()` ran outside the player's try/catch — a 404'd asset was an unhandled rejection with neither `data-ready` nor `data-error` ever set. Both now route through the recoverable `fatal()` overlay.
  - **Saves are bound to their story.** A resumed save was restored blindly; with the PWA auto-updating underneath saved games, a changed story could strand the cursor on a node that no longer exists. Save rows now carry a story fingerprint (`hashState(story)`) + a `SAVE_VERSION`; a mismatch (including all pre-existing rows) is treated as no save.
  - **Preview error recovery no longer draws into a detached node.** The editor's play preview replaced the Pixi host div with the error message; after recovery the canvas could live in a detached element. The host now stays mounted and the error overlays it.
  - **The checkpoint prompt is reachable.** The editor chat never passed `checkpointEvery`, so the run-loop default (500 turns) made the entire Continue/Stop checkpoint UI dead code. It now checkpoints every 25 turns, and a run ending while the prompt is showing (e.g. via Interrupt, which no longer hangs — see the core batch) clears it.

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
- Updated dependencies [6eddc7e]
- Updated dependencies [9ffb0ae]
- Updated dependencies [8b9d9d4]
- Updated dependencies [f82d28c]
- Updated dependencies [0c00a17]
- Updated dependencies [b4beead]
- Updated dependencies [092ca2f]
- Updated dependencies [b8fe968]
- Updated dependencies [7e4c2be]
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
  - @ludelier/renderer-pixi@0.2.0
