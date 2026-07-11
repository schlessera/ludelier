# @ludelier/schema

## 0.3.0

### Minor Changes

- a7a9d91: Add multi-provider AI image and audio generation with model-capability routing, redacted provenance, verified host persistence, and cache recovery. Extend Story media metadata and deterministic audio cues, then expose the same authorized asset workflow through the CLI, MCP, editor panel, and agent chat. Browser playback now uses the shared Howler adapter with image-only Pixi preload, generated-voice disclosure, and save compatibility gating.

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

- b8fe968: Repo-review correctness batch (core): transcript in the hash, choice is terminal, hardened importLog, agent-loop race fixes, provider retries.

  Six fixes from the 2026-07-03 repo review (see `docs/plans/2026-07-03-001-repo-review-implementation.md`):

  - **The state hash now covers the transcript.** `Simulation.hash()` documented that the transcript was included but omitted it, so a text-only edit (a changed `say`) was invisible to replay regression. The snapshot now includes the transcript — replay catches text changes. Hashes change (pre-1.0; no stored goldens); `exploreStory`'s transcript-free dedup key is unaffected.
  - **`choice` joins the terminal set.** Every choice option carries a `goto` and the reducer never resumes past a choice, so statements after one were silently unreachable — yet validated. `validateStory` now rejects dead code after a `choice` exactly as after `end`/`jump`; the agent system prompt teaches the wider rule.
  - **`importLog` never throws.** A malformed JSONL line hit a bare `JSON.parse` and threw, breaking the module's fail-envelope contract. Each line is now parsed and shape-checked (string `command`/`runId`) with the line number in the failure, and imports are capped at 100k records. The `seq`-vs-`records.length` double-read in `apply` is unified on one value.
  - **A clean `done` ends the turn's batch.** A model emitting `[done, edit]` in one batch used to pass the gate and then apply the trailing edit — yielding `completed: true` with `ok: false`. Calls batched after an accepted `done` are no longer applied (they get a "not applied" tool result so the transcript stays coherent).
  - **Interrupt during a checkpoint aborts instead of hanging.** The loop parked on `await onCheckpoint(...)` could never see the abort signal, so an Interrupt while the prompt was showing hung the run (and the session lock) forever. The checkpoint wait now races the AbortSignal.
  - **Transient provider failures retry.** A single 429/5xx/network error aborted a whole multi-turn run. `openAiCompatibleProvider` now retries (default 3×, exponential backoff, honours `Retry-After`, abort-aware, never retries 4xx client errors). Authoring flows also stop inheriting a hidden 0.7 temperature — the provider only sends one when asked, and `generateStory`/`runAgent` default to 0.2 with explicit generous `maxTokens` so long outputs aren't silently truncated into unparseable JSON.

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

- e6ec2c4: World API & agent harness — slice 1 (CLI-first).

  - New `@ludelier/world` package: a self-describing task registry (`describe()` manifest) of understand tasks (validate, graph, list-characters/assets/variables, get-node, find-references, simulate, diff) and a manipulate spine (create/delete-node, set-meta, add-character, register-asset, append-{say,show,choice,jump,end}, remove-statement, rewire-goto) applied through an always-valid `applyEdit` (validateStory + a world-local `say.who` check). Event-sourced `EditLog` with linear-history undo/redo, contiguous-tail `revertRun`, and JSONL export/import. Uniform `{success}` result envelope and a canonical `hashStory`.
  - `@ludelier/authoring`: additive provider tool-calling (`ToolDefinition`, `tools`/`toolCalls`, `role:"tool"` messages) on the OpenAI-compatible provider; a `worldTools`/`dispatch` tool adapter; and an autonomous `runAgent` loop that edits under one runId, self-verifies (validate + graph + simulate), and returns a reviewable, revertable result.
  - `@ludelier/cli`: registry-derived `world describe|query|edit|undo|redo|export` and `author run` subcommands; the entrypoint is now an exported `run(argv)`.
  - `@ludelier/schema`: extracted a shared `toJsonSchema(schema)` helper (used by the world manifest); `storyJsonSchema()` now calls it.

## 0.1.0

### Minor Changes

- 00a221d: P0 headless core: deterministic Redux-style engine (seeded RNG, stable-hash snapshots, JSONL trace record/replay), Zod-validated Story DSL (`say`/`set`/`add`/`roll`/`choice`/`jump`/`end` + cross-reference validation + JSON Schema export), and a `validate`/`simulate`/`replay` CLI. No renderer yet.
- fd44662: P1 backgrounds + character sprites. Story DSL gains a central `assets` declaration and three non-blocking statements — `scene` (set/clear background, clears sprites), `show` (sprite in a named slot at left/center/right), `hide` — all cross-reference validated. The engine tracks a persistent `stage` (background + id-sorted sprites) threaded through the reducer and folded into the deterministic state hash, so replay covers visual state. The PixiJS renderer preloads declared assets, draws a cover-fit background and bottom-anchored sprites under the dialog UI on dedicated (configurable) layer z-indices, and crossfades background/sprite changes with a settle signal for screenshot tests. The runtime preloads assets and the `cafe` example now plays as a real visual novel (café background + character). `cli simulate` reports `stage`.
