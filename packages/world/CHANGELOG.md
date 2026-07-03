# @ludelier/world

## 0.2.0

### Minor Changes

- b4beead: Architecture-review hardening: faster fold, one definition of valid, wider hash, real coverage, more checks.

  Five fixes from the 2026-06-22 design review (see `docs/architecture-risks.md`):

  - **Memoized EditLog fold (engine of the editor).** `EditLog.currentStory()` re-folded every record from the base on each call — O(n²) over an editing session. It now caches the folded tip (`apply` sets it directly, no refold) and invalidates only on undo/redo/revertRun, so N edits are O(n). `importLog` drops from O(n²) to O(n). Behaviour is unchanged (round-trip + refold tests stay green).
  - **One definition of "valid".** The `say.who` cross-reference (a `say` must name a declared character) moved from a world-only check into `validateStory`, so authoring (`generateStory`) and the world edit gate now agree — a story that validates can always be loaded into an `EditLog`. `validateWorld` is now a thin alias; the redundant `say-who-check` module is gone.
  - **64-bit identity hash.** `hashState`/`hashStory` were FNV-1a **32-bit** (birthday collisions ~77k items) — too narrow for a content identity / cache key. Now a shared `fnv1a64` (BigInt, exact 64-bit, 16-hex) lives in `@ludelier/engine` and `@ludelier/world` imports it, so there is one hash implementation and no 32-vs-64 drift. Digests change width (pre-1.0; no stored goldens).
  - **Behavioural coverage in verify.** `runAgent`'s self-check ran `simulate(actions:[])`, which only walked the linear head and reported no real coverage. New deterministic, bounded, crash-safe `exploreStory` (engine) + `explore` world task actually play through every reachable path honouring `if` conditions; verify now reports true reached-node coverage, whether an ending is reachable, choices that gate themselves off (`stuck`), and runtime infinite loops (`crashed`) instead of throwing.
  - **More guardrails.** `validateStory` now rejects duplicate statement ids (backstops every id-generation path: a collision is caught by the always-valid re-validate). The agent gate additionally flags, relative to the pre-run baseline, variables read in a choice `if` but never written (`unwrittenVarReads`), self-gated choices, and stories that crash at runtime — each with a fix hint, so the agent self-corrects before `done`.

- e2da20a: Add the `branch` statement — state-driven conditional flow — and extend the demo to use it.

  `branch` is a conditional jump: if its `cond` ({var,cmp,value}) holds it continues at `goto`, otherwise it falls through to the next statement. It is the missing control-flow primitive for basic visual novels — until now the only way to branch was a player `choice`, so computed state (accumulated trust, a dice roll) couldn't change the story by itself. Chain several `branch`es for if/elif/else. Unlike `jump` it is not terminal, so statements may follow it.

  Wired end-to-end through the existing layers:

  - **schema** — `BranchStatement` in the discriminated union; `validateStory` cross-refs `branch.goto` to a known node.
  - **engine** — the reducer takes the goto when the condition holds (reusing the type-safe `compare`), else falls through; covered by the statement-budget / determinism guards like any jump.
  - **world** — `graph` counts the branch goto as an edge (reachability + dead-end analysis see it), `find-references` and `rewire-goto` handle it, and the variable checks (`unwrittenVarReads` / `conditionTypeIssues`) now scan branch conditions too.
  - **authoring / editor** — the author and agent prompts document `branch`, and the editor inspector summarizes it.

  Demo (`examples/cafe.story.json`): the café story now uses `branch` for two state-driven outcomes — a luck-based "lucky" ending (the previously-dead `roll` of `luck` now matters) and a trust-based regret line on the leave path — adds `her` as a speaking character, and a new "Ask about her day" path. The opening frame and the existing play-through are unchanged (e2e green).

- 8b9d9d4: New `@ludelier/editor-core` package: the editor's headless session façade.

  `EditorSession` is the single parity surface a human UI and the agent both drive (AGENTS.md: anything a human can do in the editor, the agent can do through the same tasks). It owns the current `Story` as an event-sourced `EditLog`, routes reads to the world's understand tasks (`query`) and writes to the manipulate tasks (`edit`) through the always-valid `applyEdit` chokepoint, exposes `undo`/`redo`/`revertRun` + `canUndo`/`canRedo`, emits `change` events for a view to re-render, round-trips through `exportLog`/`fromLog`, and runs the agent `chat` loop **on the session's own log** so generated edits join the same undoable history. Pure — no DOM/React/network of its own (the LLM provider is injected); tested in Vitest without a browser. The React editor shell will be a thin view bound to it.

  Supporting changes:

  - `@ludelier/world`: `EditLog` gains `canUndo()` / `canRedo()`.
  - `@ludelier/authoring`: `runAgent` accepts an existing `log` to append the run onto (and measures its baseline/diff against that log's current story), so a session's chat edits integrate with its history.

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

- 354782d: Add `deriveFlowEdges` + the `flow-edges` understand task — labelled node transitions for the editor's structure map.

  `GraphReport.edges` is bare `{from,to}` adjacency, which can't drive a map that labels and styles edges. `deriveFlowEdges(story)` walks each node's body (id-sorted for determinism) and returns one `FlowEdge` per `jump` / `branch` / `choice` option, carrying the edge `kind`, a human `label` (choice text, or the condition for a `branch` / gated option), a `conditional` flag, and the originating statement id. It is derived the same way the engine transitions between nodes, so the map matches real execution. Exposed both as a pure import and as the registered `flow-edges` task (agent-native parity — the agent can query the same edges the human sees). The existing `GraphReport` shape is unchanged.

- 93bb287: Reject dead code after a terminal statement, and add `insert-*` to add content before a statement.

  Asked to add sentences to an ending node, the agent appended them — but the node already ended with `end`, so the new lines landed _after_ it (dead code that never plays). `validateStory` accepted it (statement order wasn't checked) and the run verified "clean".

  - **schema**: a node's terminal statement (`end` / `jump`) must be its last — `validateStory` now flags any statement that follows one. This makes the always-valid `applyEdit` gate reject an append-after-terminal, so the agent self-corrects in-loop.
  - **world**: new `insert-say` / `insert-show` / `insert-choice` commands insert a statement **before** an existing one (target it by `beforeStatementId`, using the stable ids from `get-node`). Terminal kinds have no insert variant — inserting one mid-node would orphan the rest (now invalid); append a terminal at the end instead.
  - **authoring**: the agent prompt explains that `append-*` adds at the end (so a terminal must already be last) and to use `insert-*` to add before an existing statement.

  Verified live: "add a few closing sentences to the ending node" now inserts them before the `end` (all dialogue plays, then the story ends), valid and clean.

- e6ec2c4: World API & agent harness — slice 1 (CLI-first).

  - New `@ludelier/world` package: a self-describing task registry (`describe()` manifest) of understand tasks (validate, graph, list-characters/assets/variables, get-node, find-references, simulate, diff) and a manipulate spine (create/delete-node, set-meta, add-character, register-asset, append-{say,show,choice,jump,end}, remove-statement, rewire-goto) applied through an always-valid `applyEdit` (validateStory + a world-local `say.who` check). Event-sourced `EditLog` with linear-history undo/redo, contiguous-tail `revertRun`, and JSONL export/import. Uniform `{success}` result envelope and a canonical `hashStory`.
  - `@ludelier/authoring`: additive provider tool-calling (`ToolDefinition`, `tools`/`toolCalls`, `role:"tool"` messages) on the OpenAI-compatible provider; a `worldTools`/`dispatch` tool adapter; and an autonomous `runAgent` loop that edits under one runId, self-verifies (validate + graph + simulate), and returns a reviewable, revertable result.
  - `@ludelier/cli`: registry-derived `world describe|query|edit|undo|redo|export` and `author run` subcommands; the entrypoint is now an exported `run(argv)`.
  - `@ludelier/schema`: extracted a shared `toJsonSchema(schema)` helper (used by the world manifest); `storyJsonSchema()` now calls it.

### Patch Changes

- Updated dependencies [b4beead]
- Updated dependencies [e2da20a]
- Updated dependencies [b4beead]
- Updated dependencies [b8a118d]
- Updated dependencies [d746333]
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/schema@0.2.0
  - @ludelier/engine@0.2.0
