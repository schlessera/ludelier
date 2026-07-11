# @ludelier/authoring

## 0.3.0

### Minor Changes

- a7a9d91: Add multi-provider AI image and audio generation with model-capability routing, redacted provenance, verified host persistence, and cache recovery. Extend Story media metadata and deterministic audio cues, then expose the same authorized asset workflow through the CLI, MCP, editor panel, and agent chat. Browser playback now uses the shared Howler adapter with image-only Pixi preload, generated-voice disclosure, and save compatibility gating.

### Patch Changes

- Updated dependencies [a7a9d91]
  - @ludelier/schema@0.3.0
  - @ludelier/world@0.3.0

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

- 1faa3b4: Close the agent self-correction loop: feed graph self-verification back into `runAgent`.

  - `runAgent` now treats the `done` tool as a verification gate. When the model signals completion, the run is re-checked against a pre-run baseline; if the edits introduced any **new** unreachable or dead-end nodes (or invalidity), those problems are returned as `done` issues (or a feedback message when the model stops calling tools) so the model self-corrects, and the loop keeps going. Comparing against a baseline keeps the agent focused on its own edits — it is never asked to fix problems that already existed in the story it was handed.
  - `AgentRunResult.ok` now means **clean** (Zod-valid _and_ no new unreachable / dead-end nodes), not merely Zod-valid; `completed` is true only when the agent verified a clean run. This stops the loop from silently shipping a valid-but-broken story (e.g. a disconnected node, or a regression that deletes an existing `end`).
  - `cli author run` surfaces `ok` and any unreachable / dead-end nodes in its run summary.

- b4beead: Architecture-review hardening: faster fold, one definition of valid, wider hash, real coverage, more checks.

  Five fixes from the 2026-06-22 design review (see `docs/architecture-risks.md`):

  - **Memoized EditLog fold (engine of the editor).** `EditLog.currentStory()` re-folded every record from the base on each call — O(n²) over an editing session. It now caches the folded tip (`apply` sets it directly, no refold) and invalidates only on undo/redo/revertRun, so N edits are O(n). `importLog` drops from O(n²) to O(n). Behaviour is unchanged (round-trip + refold tests stay green).
  - **One definition of "valid".** The `say.who` cross-reference (a `say` must name a declared character) moved from a world-only check into `validateStory`, so authoring (`generateStory`) and the world edit gate now agree — a story that validates can always be loaded into an `EditLog`. `validateWorld` is now a thin alias; the redundant `say-who-check` module is gone.
  - **64-bit identity hash.** `hashState`/`hashStory` were FNV-1a **32-bit** (birthday collisions ~77k items) — too narrow for a content identity / cache key. Now a shared `fnv1a64` (BigInt, exact 64-bit, 16-hex) lives in `@ludelier/engine` and `@ludelier/world` imports it, so there is one hash implementation and no 32-vs-64 drift. Digests change width (pre-1.0; no stored goldens).
  - **Behavioural coverage in verify.** `runAgent`'s self-check ran `simulate(actions:[])`, which only walked the linear head and reported no real coverage. New deterministic, bounded, crash-safe `exploreStory` (engine) + `explore` world task actually play through every reachable path honouring `if` conditions; verify now reports true reached-node coverage, whether an ending is reachable, choices that gate themselves off (`stuck`), and runtime infinite loops (`crashed`) instead of throwing.
  - **More guardrails.** `validateStory` now rejects duplicate statement ids (backstops every id-generation path: a collision is caught by the always-valid re-validate). The agent gate additionally flags, relative to the pre-run baseline, variables read in a choice `if` but never written (`unwrittenVarReads`), self-gated choices, and stories that crash at runtime — each with a fix hint, so the agent self-corrects before `done`.

- 8b9d9d4: New `@ludelier/editor-core` package: the editor's headless session façade.

  `EditorSession` is the single parity surface a human UI and the agent both drive (AGENTS.md: anything a human can do in the editor, the agent can do through the same tasks). It owns the current `Story` as an event-sourced `EditLog`, routes reads to the world's understand tasks (`query`) and writes to the manipulate tasks (`edit`) through the always-valid `applyEdit` chokepoint, exposes `undo`/`redo`/`revertRun` + `canUndo`/`canRedo`, emits `change` events for a view to re-render, round-trips through `exportLog`/`fromLog`, and runs the agent `chat` loop **on the session's own log** so generated edits join the same undoable history. Pure — no DOM/React/network of its own (the LLM provider is injected); tested in Vitest without a browser. The React editor shell will be a thin view bound to it.

  Supporting changes:

  - `@ludelier/world`: `EditLog` gains `canUndo()` / `canRedo()`.
  - `@ludelier/authoring`: `runAgent` accepts an existing `log` to append the run onto (and measures its baseline/diff against that log's current story), so a session's chat edits integrate with its history.

- f82d28c: The agent gate gains a non-blocking warnings channel; the always-valid invariant gains a fuzz harness.

  - **Runtime-unreached warnings.** `Verification` now reports `runtimeUnreached` — nodes that are statically reachable but that no condition-honouring play-through ever visits (every path in is gated off). Newly-introduced ones surface as **warnings** delivered _with_ an accepted `done` (`{ok:true, warnings:[…]}`) and on the `verify` event — visible to the model and in the editor's feed, but never wedging the loop, since a branch awaiting its unlock legitimately looks like this mid-build. (Closes the last open follow-up from `docs/architecture-risks.md`.)
  - **Seeded fuzz over `applyEdit`** (world tests): 2×400 randomly generated commands — colliding ids, dangling refs, stale statement targets, interleaved undo/redo — asserting the story validates after every single apply, nothing ever throws, and the surviving history refolds byte-identically through export → import. Deterministic via the engine's own PRNG, so any failure reproduces from its seed.

- b4beead: Close the three open robustness issues from the architecture review.

  - **Defined comparison semantics (no silent coercion).** `compare` (engine reducer) no longer casts operands: `eq`/`ne` stay strict, and the ordered ops (`gt`/`lt`/`gte`/`lte`) are number-only — a non-number operand yields `false` instead of a coerced/lexical surprise. New `conditionTypeIssues` (world) statically flags ordered comparisons that can't behave as intended (a non-number literal, or a var `set` to a non-number elsewhere); `runAgent`'s gate surfaces newly-introduced ones so the agent fixes them before `done`.
  - **EditorSession run lock.** An agent `chat` run mutates the shared log across `await` boundaries and snapshots a pre-run baseline, so a concurrent human edit would corrupt the run's diff and break `revertRun`. `edit`/`revertRun` now refuse (return a failure) and `undo`/`redo`/a second `chat` throw while a run is in flight; a new `busy` getter lets the UI disable its controls. Reads stay allowed.
  - **Recoverable runtime cycle.** The reducer now throws a typed `StatementBudgetError` (exported from `@ludelier/engine`) on an infinite jump loop. The web player (`runtime-web`) and the editor play preview (`editor-web`) catch it — and any playback throw — and show a recoverable error (with a restart) instead of white-screening.

- b8fe968: Repo-review correctness batch (core): transcript in the hash, choice is terminal, hardened importLog, agent-loop race fixes, provider retries.

  Six fixes from the 2026-07-03 repo review (see `docs/plans/2026-07-03-001-repo-review-implementation.md`):

  - **The state hash now covers the transcript.** `Simulation.hash()` documented that the transcript was included but omitted it, so a text-only edit (a changed `say`) was invisible to replay regression. The snapshot now includes the transcript — replay catches text changes. Hashes change (pre-1.0; no stored goldens); `exploreStory`'s transcript-free dedup key is unaffected.
  - **`choice` joins the terminal set.** Every choice option carries a `goto` and the reducer never resumes past a choice, so statements after one were silently unreachable — yet validated. `validateStory` now rejects dead code after a `choice` exactly as after `end`/`jump`; the agent system prompt teaches the wider rule.
  - **`importLog` never throws.** A malformed JSONL line hit a bare `JSON.parse` and threw, breaking the module's fail-envelope contract. Each line is now parsed and shape-checked (string `command`/`runId`) with the line number in the failure, and imports are capped at 100k records. The `seq`-vs-`records.length` double-read in `apply` is unified on one value.
  - **A clean `done` ends the turn's batch.** A model emitting `[done, edit]` in one batch used to pass the gate and then apply the trailing edit — yielding `completed: true` with `ok: false`. Calls batched after an accepted `done` are no longer applied (they get a "not applied" tool result so the transcript stays coherent).
  - **Interrupt during a checkpoint aborts instead of hanging.** The loop parked on `await onCheckpoint(...)` could never see the abort signal, so an Interrupt while the prompt was showing hung the run (and the session lock) forever. The checkpoint wait now races the AbortSignal.
  - **Transient provider failures retry.** A single 429/5xx/network error aborted a whole multi-turn run. `openAiCompatibleProvider` now retries (default 3×, exponential backoff, honours `Retry-After`, abort-aware, never retries 4xx client errors). Authoring flows also stop inheriting a hidden 0.7 temperature — the provider only sends one when asked, and `generateStory`/`runAgent` default to 0.2 with explicit generous `maxTokens` so long outputs aren't silently truncated into unparseable JSON.

- e6ec2c4: World API & agent harness — slice 1 (CLI-first).

  - New `@ludelier/world` package: a self-describing task registry (`describe()` manifest) of understand tasks (validate, graph, list-characters/assets/variables, get-node, find-references, simulate, diff) and a manipulate spine (create/delete-node, set-meta, add-character, register-asset, append-{say,show,choice,jump,end}, remove-statement, rewire-goto) applied through an always-valid `applyEdit` (validateStory + a world-local `say.who` check). Event-sourced `EditLog` with linear-history undo/redo, contiguous-tail `revertRun`, and JSONL export/import. Uniform `{success}` result envelope and a canonical `hashStory`.
  - `@ludelier/authoring`: additive provider tool-calling (`ToolDefinition`, `tools`/`toolCalls`, `role:"tool"` messages) on the OpenAI-compatible provider; a `worldTools`/`dispatch` tool adapter; and an autonomous `runAgent` loop that edits under one runId, self-verifies (validate + graph + simulate), and returns a reviewable, revertable result.
  - `@ludelier/cli`: registry-derived `world describe|query|edit|undo|redo|export` and `author run` subcommands; the entrypoint is now an exported `run(argv)`.
  - `@ludelier/schema`: extracted a shared `toJsonSchema(schema)` helper (used by the world manifest); `storyJsonSchema()` now calls it.

### Patch Changes

- e2da20a: Add the `branch` statement — state-driven conditional flow — and extend the demo to use it.

  `branch` is a conditional jump: if its `cond` ({var,cmp,value}) holds it continues at `goto`, otherwise it falls through to the next statement. It is the missing control-flow primitive for basic visual novels — until now the only way to branch was a player `choice`, so computed state (accumulated trust, a dice roll) couldn't change the story by itself. Chain several `branch`es for if/elif/else. Unlike `jump` it is not terminal, so statements may follow it.

  Wired end-to-end through the existing layers:

  - **schema** — `BranchStatement` in the discriminated union; `validateStory` cross-refs `branch.goto` to a known node.
  - **engine** — the reducer takes the goto when the condition holds (reusing the type-safe `compare`), else falls through; covered by the statement-budget / determinism guards like any jump.
  - **world** — `graph` counts the branch goto as an edge (reachability + dead-end analysis see it), `find-references` and `rewire-goto` handle it, and the variable checks (`unwrittenVarReads` / `conditionTypeIssues`) now scan branch conditions too.
  - **authoring / editor** — the author and agent prompts document `branch`, and the editor inspector summarizes it.

  Demo (`examples/cafe.story.json`): the café story now uses `branch` for two state-driven outcomes — a luck-based "lucky" ending (the previously-dead `roll` of `luck` now matters) and a trust-based regret line on the leave path — adds `her` as a speaking character, and a new "Ask about her day" path. The opening frame and the existing play-through are unchanged (e2e green).

- 6eddc7e: Add choice-option manipulate tasks — edit a choice's options in place, by index.

  Until now, changing one option of a `choice` meant rebuilding the whole statement (remove-statement + add-statement, or the editor form's raw-JSON options field). Three new registry tasks target the choice by its stable statement id and one option by 0-based index (the same convention `rewire-goto` uses):

  - `add-choice-option {nodeId, statementId, option, beforeIndex?}` — append, or insert at `beforeIndex`.
  - `update-choice-option {nodeId, statementId, index, option}` — replace one option in place.
  - `remove-choice-option {nodeId, statementId, index}` — remove one; refuses to remove the LAST remaining option (an option-less choice strands the player — no CHOOSE can advance, explore reports the node as stuck) with a clear issue instead of a generic re-validation error.

  `option` reuses the schema's `ChoiceOption` ({label, goto, if?}), so an option's `goto` is cross-ref-checked by the always-valid `applyEdit` like every other edit. Because the tasks are registered in the shared registry, the `describe()` manifest (21 → 24 tasks) carries them to the CLI, the LLM toolset, the MCP server, and the editor's manifest-driven forms with zero further code — and the option's nested shape derives as a real form (label/goto/if fields), not a raw-JSON fallback. The agent system prompt teaches the ops so the model edits options by index instead of rewriting the whole choice.

- 0c00a17: Replace the flattened append-_/insert-_ statement spine with generic statement tools.

  The per-kind × per-position command design (append-say, append-show, …, insert-say, …) grew the toolset toward 50+ as statement kinds multiply — and the long tail (set/add/roll/scene/hide) was never even built. It was a hedge against LLMs mis-filling a discriminated union; that no longer holds (Zod 4 emits a clean `oneOf`, and a prototype confirmed gpt-5-mini fills the union reliably across kinds).

  - `add-statement {nodeId, statement, before?}` — one tool for every statement kind (and every future kind): `statement` is the schema's `Statement` union; appends at the end, or inserts before `before` (a statement id).
  - `update-statement {nodeId, statementId, statement}` — replace a statement in place (keeps its id).
  - `move-statement {nodeId, statementId, before?}` — reorder.
  - `remove-statement` / `rewire-goto` unchanged (target by id).

  Manipulate tools drop from 15 to 10 and stay flat as the DSL grows. All guardrails are unchanged (terminal-position rule, say.who, cross-refs); the EditLog now bakes the stable id into `params.statement.id` for `add-statement`. The agent prompt and the editor's edit feed are updated for the new tools.

- b8a118d: Stable statement ids: target statement edits by identity, not by a fragile position.

  The agent kept miscounting statement positions — e.g. asked to replace a node's first line, it removed the wrong statement (a choice instead of the stale say) and left the old line behind, yet the run still verified "clean" (graph health was unaffected). Index-based targeting is the root cause.

  - **schema**: every statement gains an optional stable `id`. Optional, so authored/legacy stories stay valid; the world fills any gaps.
  - **world**: `normalizeStatementIds` assigns positional ids (`"<nodeId>#<i>"`) when a story is loaded into the `EditLog`; statement-creating commands get a monotonic `"s<seq>"` baked into their edit record, so a refold reproduces ids deterministically (collision-safe across remove+append — the determinism invariant holds, and `hashStory` now covers ids). `remove-statement` and `rewire-goto` now take a **`statementId`** (the old `index` param is gone); `get-node` surfaces the ids.
  - **authoring**: the agent system prompt instructs targeting existing statements by their `id` from `get-node`.
  - **editor-web**: the node inspector shows each statement's id, and the chat feed shows the targeted `statementId`.

  Verified live: asked to remove one statement from a node, the agent now removes exactly the right one by id; the others keep their ids.

- 93bb287: Reject dead code after a terminal statement, and add `insert-*` to add content before a statement.

  Asked to add sentences to an ending node, the agent appended them — but the node already ended with `end`, so the new lines landed _after_ it (dead code that never plays). `validateStory` accepted it (statement order wasn't checked) and the run verified "clean".

  - **schema**: a node's terminal statement (`end` / `jump`) must be its last — `validateStory` now flags any statement that follows one. This makes the always-valid `applyEdit` gate reject an append-after-terminal, so the agent self-corrects in-loop.
  - **world**: new `insert-say` / `insert-show` / `insert-choice` commands insert a statement **before** an existing one (target it by `beforeStatementId`, using the stable ids from `get-node`). Terminal kinds have no insert variant — inserting one mid-node would orphan the rest (now invalid); append a terminal at the end instead.
  - **authoring**: the agent prompt explains that `append-*` adds at the end (so a terminal must already be last) and to use `insert-*` to add before an existing statement.

  Verified live: "add a few closing sentences to the ending node" now inserts them before the `end` (all dialogue plays, then the story ends), valid and clean.

- Updated dependencies [b4beead]
- Updated dependencies [e2da20a]
- Updated dependencies [6eddc7e]
- Updated dependencies [8b9d9d4]
- Updated dependencies [0c00a17]
- Updated dependencies [b4beead]
- Updated dependencies [b8fe968]
- Updated dependencies [b8a118d]
- Updated dependencies [354782d]
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/schema@0.2.0
  - @ludelier/world@0.2.0

## 0.1.0

### Minor Changes

- 519e4b0: P2 first slice — `@ludelier/authoring`. Introduces the `LLMProvider` seam (mirrors the asset `AssetProvider` shape) with OpenAI + OpenRouter implementations over a shared OpenAI-compatible core and a BYOK-per-provider registry. Adds `generateStory()`: a provider-agnostic self-correction loop that constrains output with `storyJsonSchema()`, validates with `validateStory()`, and feeds issues back to the model until the Story is valid or attempts are exhausted — returning a discriminated `{ ok, story | issues, attempts, transcript }` result. Hermetic mock-provider + fake-fetch tests; no network.

### Patch Changes

- Updated dependencies [00a221d]
- Updated dependencies [fd44662]
  - @ludelier/schema@0.1.0
