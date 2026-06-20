# Requirements — World API & Agent Harness (agent-native editor core)

_Brainstorm, 2026-06-19. Scope: Deep — feature. Status: ready for planning._

## Summary

Build the **world API** at the core of Ludelier's agent-native editor: a typed surface of **understand** tasks (read-only, deterministic) and **manipulate** tasks (validated edits) over a `Story`, exposed identically to the editor UI, the CLI, and the LLM agent (agent-native parity). The world API is designed to **grow and adapt** as the AI-augmented generation flow is discovered (no established precedent) — so the task surface is a **self-describing registry**, not hardcoded across layers. First slice is **CLI-first** (no UI, live LLM optional).

## Problem / why

The plan (AGENTS.md → "The app: agent-native editor") calls for understand + manipulate tasks exposed as both UI and LLM tools with parity. Today we have the primitives (`schema.validateStory`, `engine.Simulation`, `authoring.generateStory` — a *coarse* whole-story loop) but **no fine-grained, evolvable edit surface**. We need one that keeps the Story always-valid, supports undo/audit, lets the agent verify its own work, and can absorb new capabilities without churn.

## Users

- **Game creator** (human): drives the editor; reviews/keeps/reverts agent runs.
- **The agent**: operates the same task surface autonomously to grow/maintain the game.
- Parity rule: anything the human can do in the UI, the agent can do through the same tasks — no human-only escape hatches.

## Locked decisions

1. **Edit model — command/edit-event log (event-sourced).** Edits are typed commands applied by a pure reducer `applyEdit(story, cmd) → story`, each re-validated. The command log *is* the history.
2. **Agent loop — autonomous run → review-after.** The agent executes a whole task end-to-end, committing validated commands as it goes (grouped under a `runId`), stopping only on an unrecoverable error; the human reviews the combined diff and keeps or reverts the run as one undo of N commands.
3. **Package home — new `@ludelier/world`** (pure: no LLM, no DOM), depending on `schema` + `engine`. `authoring` builds the LLM agent-loop on top; `cli` and the future editor UI consume `world` directly.
4. **Evolvability mechanism — a self-describing task registry.** Each task = `{ name, description, paramsSchema (Zod), run/apply }`. `world.describe()` returns the manifest (tasks + JSON Schemas). LLM tool defs, CLI subcommands, UI affordances, and docs are **derived** from it — adding a capability = adding one registry entry.

## The world API surface

Uniform result envelope for every task: `{ ok: true, data } | { ok: false, issues }`.

**Understand (read-only, deterministic):**
- `validate` → cross-reference + shape issues (`validateStory`).
- `graph` → nodes, edges (jump/choice targets), `reachable`, `unreachable`, `dead-ends`, entry (`meta.start`).
- `list-characters` / `list-assets` / `list-variables` (vars inferred from set/add/roll/conditions).
- `get-node(id)` ; `find-references(id)` (where a node/asset/character/var is used).
- `simulate({ actions | strategy, seed })` → final state, transcript, stable hash, nodes reached (wraps `engine.Simulation`).
- `diff(storyA, storyB)` → structural diff (used to render run review).
- `describe()` → the manifest.

**Manipulate (typed edit commands; each `applyEdit` → validate → new Story or `{issues}`):**
- meta: `set-meta`.
- nodes: `create-node`, `delete-node`, `rename-node` (rewrites refs), `update-node`.
- statements: `append-statement`, `insert-statement`, `update-statement`, `remove-statement`, `move-statement`.
- characters: `add-character`, `update-character`, `remove-character`.
- assets: `register-asset`, `update-asset`, `remove-asset`.
- flow: `rewire-goto`, `add-choice-option`, `remove-choice-option`.

Set is **additive-only** going forward (changesets semver); new `Story` statement ops get a matching command without touching the apply loop.

## Edit log, transactionality, undo (one mechanism)

- Canonical authoring doc = `{ baseStory, log: EditRecord[] }`; `currentStory = fold(applyEdit, baseStory, log)`.
- `EditRecord = { seq, runId, command, params }` (timestamps/metadata kept out of any hash).
- A **run** = a contiguous group of records sharing a `runId`. Committed as it goes; each command validated.
- **undo/redo** = move the log head; **revert-run** = drop the run's tail + refold. Refold is the source of truth (always correct); inverse-ops are a later perf option only.
- Mirrors the runtime's JSONL action log — **one event-sourcing idea, two layers** (authoring-time edits, play-time actions). Log is JSONL-exportable/importable for audit + regression.

## Agent run loop (in `@ludelier/authoring`)

- `run({ prompt, provider, story, maxSteps })`: the LLM is given `world.describe()` as tools; it calls understand + manipulate tasks; each manipulate is appended to the log under one `runId`; loop until the agent signals done or `maxSteps`.
- **Self-verification before "done":** the loop runs `validate` + `graph` + `simulate` and returns `{ story, runId, commands, diff, verification, transcript }`. The agent proposes; the harness proves deterministically.
- `generateStory` becomes one coarse task (scaffold) alongside the fine-grained ones.

## Parity

UI buttons, CLI subcommands, and agent tool-calls all dispatch the **same** world tasks. Parity is structural (single chokepoint), not a parallel implementation to keep in sync.

## Slice 1 — CLI-first (acceptance criteria)

- `@ludelier/world`: understand + manipulate registries, `applyEdit`, EditLog (apply/undo/redo/revert-run, JSONL export/import), `describe()`. Pure; unit-tested in Vitest (no browser, no LLM).
- `@ludelier/cli`: `world describe`, `world query <task> --story s.json [args]`, `world edit <cmd> --story s.json [args] -o out.json`, `world undo|redo`, log export/import. Subcommands derived from the registry.
- `@ludelier/authoring`: the autonomous run loop, tested with a **scripted provider** (hermetic, like `packages/authoring/test/author.test.ts`) — proves loop + self-verification with no live LLM. Real provider = BYOK, optional.
- **Determinism regression:** replaying an edit log reproduces an identical Story (analogous to `engine.replayTrace`).
- Every change ships a changeset; `just check` green.

## Out of scope (deferred)

- Editor UI panel + chat surface (consumes `world` later; parity already guaranteed).
- Live-LLM end-to-end run (BYOK; optional in slice 1).
- Author-facing DSL surface (compiles down to the canonical JSON).
- Collaboration / multi-author, asset-generation hooks (P3), cloud seam (P4).

## Open questions / assumptions

- **Provider tool-calling.** The run loop needs OpenAI-style function/tool calls; today `LLMProvider` does chat + `json_schema` only → additive extension (`tools` in request, tool-call parsing in result). Assumption: OpenAI + OpenRouter support it.
- **`simulate` "all-paths" strategy.** Exhaustive branch exploration can explode; bound by a node-visit / depth cap. Exact strategy is a planning detail.
- **"Run done" signal.** Agent emits an explicit done/finish tool call, or the loop ends when no tool call is returned.
- **Undo representation.** Refold chosen for correctness; revisit inverse-ops only if large logs become slow.

## Success criteria

- A scripted agent run can, end-to-end and headlessly: add a branch to `examples/cafe.story.json`, keep the Story Zod-valid at every step, self-verify via `graph` + `simulate`, and produce a reviewable diff + a revertable run — all exercised in CI with no live LLM.
- Adding a new capability (e.g., a new statement op's edit command) requires only a new registry entry; it appears automatically in `describe()`, the CLI, and the agent's toolset.
