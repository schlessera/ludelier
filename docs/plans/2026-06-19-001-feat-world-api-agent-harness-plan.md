---
title: "feat: World API & agent harness — slice 1 (CLI-first)"
type: feat
status: active
created: 2026-06-19
origin: docs/brainstorms/world-api-harness-requirements.md
depth: deep
---

# feat: World API & agent harness — slice 1 (CLI-first)

> Handoff plan for a fresh session. Origin requirements: `docs/brainstorms/world-api-harness-requirements.md`. Read that first for the WHAT; this doc is the HOW for slice 1.

## Problem frame

Ludelier's delivered app is an **agent-native editor**: a world API of **understand** (read-only, deterministic) + **manipulate** (validated edit) tasks over a `Story`, exposed identically to the editor UI, the CLI, and the LLM agent (parity). Today the primitives exist (`schema.validateStory`, `engine.Simulation`, `authoring.generateStory` — a *coarse* whole-story loop) but there is **no fine-grained, evolvable edit surface**. Slice 1 builds that surface, CLI-first, with the agent loop proven hermetically (no live LLM).

The surface must **grow as the AI-augmented generation flow is discovered** (no precedent). The mechanism: a **self-describing task registry** — adding a capability = adding one registry entry; LLM tools, CLI subcommands, and (later) UI affordances are all *derived* from it.

---

## Scope

In scope (slice 1):
- New pure package `@ludelier/world` (no LLM, no DOM): understand + manipulate task registries, `applyEdit` (always re-validates), event-sourced run-grouped `EditLog` (undo/redo/revert-run by refold), `describe()` manifest.
- Registry-derived CLI subcommands in `@ludelier/cli`.
- Autonomous **run → review-after** loop in `@ludelier/authoring`, exercised by a **scripted provider** (hermetic).
- Additive **tool-calling** extension to `LLMProvider`.

### Deferred to follow-up work
- **Remaining manipulate commands** beyond the spine (see KTD-7): `rename-node` (with ref-rewrite), `update-node`, `update-statement`, `move-statement`, `update-character`, `remove-character`, `update-asset`, `remove-asset`, `add-choice-option`, `remove-choice-option`. Each is an additive registry entry following U3's pattern — cheap, no architecture change.
- `simulate` **all-paths** exploration strategy (slice 1 takes an explicit actions list only). (see origin: Open questions)
- Live-LLM end-to-end run (BYOK) — wired but optional; not a CI gate.
- Editor UI panel + agentic chat surface; author-facing DSL; collaboration; asset-gen hooks (P3); cloud seam (P4).

---

## Key technical decisions

- **KTD-1 — Event-sourced authoring doc.** Canonical = `{ baseStory, log: EditRecord[] }`; `currentStory = fold(applyEdit, base, log)`. Mirrors the runtime's JSONL action log — one event-sourcing idea, two layers. (see origin: Edit model)
- **KTD-2 — Undo by refold, not inverse-ops.** `undo`/`redo` move the log head; `revert-run` drops a run's tail; the Story is recomputed by refold. Always correct; inverse-ops are a later perf option only.
- **KTD-3 — `applyEdit` is the always-valid chokepoint.** `applyEdit(story, cmd)` → command's pure transform → `validateStory` → `Result<Story>` (`{ok:true,data}` or `{ok:false,issues}`). An invalid edit never mutates the log.
- **KTD-4 — Registry-derived surface.** One registry of `{ name, kind, description, params: ZodSchema, run|apply }`. `describe()` emits the manifest (name/kind/description + JSON Schema via `storyJsonSchema`-style `z.toJSONSchema`). CLI subcommands, LLM tools, and docs derive from it — no hand-maintained lists, no drift.
- **KTD-5 — Uniform result envelope.** Every task returns `Result<T> = {ok:true; data:T} | {ok:false; issues: Issue[]}` (reuse `Issue` from `@ludelier/schema`). New tasks never change call sites.
- **KTD-6 — Determinism.** `EditRecord` carries no wall-clock in the canonical fold (seq + runId + command + params only); any timestamp is sidecar metadata excluded from replay equality. Log replay reproduces a byte-identical Story (regression analogous to `engine.replayTrace`).
- **KTD-7 — Slice-1 manipulate set = the spine.** `create-node`, `delete-node`, `set-meta`, `add-character`, `register-asset`, `append-statement`, `insert-statement`, `remove-statement`, `rewire-goto`. Proves the registry end-to-end; the rest are deferred additive follow-ups (Scope → Deferred). _Decision recorded in lieu of the open call-out; a fresh session may widen U3 if desired._
- **KTD-8 — Provider tool-calling is additive + back-compat.** Extend `CompletionRequest` with optional `tools`, `CompletionResult` with optional `toolCalls`, and `LLMCapabilities` with `tools`. Existing `generateStory` (chat + `json_schema`) is unaffected. (see origin: Open questions — provider tool-calling)
- **KTD-9 — Hermetic agent loop.** The run loop is tested with a **scripted provider** returning canned tool-call sequences (pattern: `packages/authoring/test/author.test.ts`). Live OpenAI/OpenRouter wiring is exercised by the same abstraction but is not a CI gate.
- **KTD-10 — Package home `@ludelier/world`.** Pure; depends on `@ludelier/schema` + `@ludelier/engine`. `authoring` and `cli` depend on `world`. (see origin: Package home)

---

## Output structure (new package)

```
packages/world/
  package.json                  # @ludelier/world; deps: schema, engine (workspace:*)
  src/
    index.ts                    # re-exports
    result.ts                   # Result<T> envelope helpers
    registry.ts                 # Task type, defineTask, the two registries, describe()
    understand/
      validate.ts  graph.ts  lists.ts  get-node.ts  references.ts
      simulate.ts  diff.ts
    manipulate/
      create-node.ts  delete-node.ts  set-meta.ts  add-character.ts
      register-asset.ts  append-statement.ts  insert-statement.ts
      remove-statement.ts  rewire-goto.ts
    applyEdit.ts                # apply command → validate → Result<Story>
    log.ts                      # EditRecord, EditLog: apply/fold/undo/redo/revert-run, JSONL io
  test/
    registry.test.ts  understand.test.ts  manipulate.test.ts  log.test.ts
```

_The tree is a scope declaration, not a constraint; per-unit `Files` are authoritative._

---

## High-level technical design

_Directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```
                 ┌─────────────────────── @ludelier/world (pure) ───────────────────────┐
 describe() ◄────┤ registry: Task{name,kind,description,params:Zod, run|apply}           │
                 │ understand: validate graph lists get-node references simulate diff    │
                 │ manipulate (spine): create/delete-node set-meta add-character          │
                 │   register-asset append/insert/remove-statement rewire-goto            │
                 │ applyEdit(story,cmd) → cmd.apply → validateStory → Result<Story>       │
                 │ EditLog{baseStory, records[]}  currentStory = fold(applyEdit)          │
                 │   undo/redo = move head · revert-run = drop runId tail · JSONL io      │
                 └───────▲───────────────────────▲───────────────────────────▲───────────┘
                         │                        │                           │
         @ludelier/cli ──┘        @ludelier/authoring ──┘          (future) editor-ui ──┘
   world describe|query|edit       worldTools(describe) → ToolDefinition[]
   |undo|redo + log io             runAgent: loop[ provider.complete(tools)
   author run "<prompt>"             → dispatch toolCall → log (one runId) ]
                                    → self-verify(validate+graph+simulate)
                                    → {story, runId, commands, diff, verification}
```

Run loop (autonomous → review-after):
```
seed messages (system: task + manifest; user: prompt)
loop until done-tool | no tool calls | maxSteps:
    completion = provider.complete({messages, tools: worldTools(world)})
    for call in completion.toolCalls:
        result = dispatch(world, log, runId, call)   # understand → data; manipulate → applyEdit into log
        append tool result to messages
verify = { validate, graph, simulate(explicit actions) }
return { story: currentStory(log), runId, commands, diff(base,current), verification, transcript }
# caller keeps the run or reverts it (one revert-run of N commands)
```

---

## Implementation units

Grouped in three phases. Every unit ships a changeset (`pnpm changeset`); `just check` stays green.

### Phase A — world core

### U1. Scaffold `@ludelier/world` + registry primitives

**Goal:** New package with the task-registry type, result envelope, and `describe()`.
**Requirements:** KTD-4, KTD-5, KTD-10.
**Dependencies:** none.
**Files:** `packages/world/package.json`, `packages/world/src/index.ts`, `packages/world/src/registry.ts`, `packages/world/src/result.ts`, `tsconfig.json` (add `@ludelier/world` path), `packages/world/test/registry.test.ts`.
**Approach:** `Task = { name; kind: "understand" | "manipulate"; description; params: ZodTypeAny; run?(story, params); apply?(story, params) }`. Two registries (understand, manipulate) keyed by name. `describe()` → array of `{ name, kind, description, schema }` where `schema = z.toJSONSchema(params)` (same mechanism as `packages/schema/src/jsonSchema.ts`). `Result<T>` helpers `ok(data)` / `fail(issues)` reusing `Issue` from `@ludelier/schema`.
**Patterns to follow:** `packages/authoring/src/registry.ts` (registry shape), `packages/schema/src/jsonSchema.ts` (`z.toJSONSchema` guard), `packages/schema/src/validate.ts` (`Result`/`Issue` shape).
**Test scenarios:**
- Registering a task then `describe()` returns it with `kind`, `description`, and a JSON Schema object (`type: "object"`).
- A task whose params fail Zod validation surfaces issues via the result envelope (no throw).
- Duplicate task name is rejected at registration.
**Verification:** `pnpm typecheck` green; `describe()` lists registered tasks with schemas.

### U2. Understand tasks (read-only, deterministic)

**Goal:** `validate`, `graph`, `list-characters|assets|variables`, `get-node`, `find-references`, `simulate`, `diff`.
**Requirements:** origin → "understand" surface; KTD-5, KTD-6.
**Dependencies:** U1.
**Files:** `packages/world/src/understand/*.ts`, `packages/world/src/index.ts` (register), `packages/world/test/understand.test.ts`.
**Approach:** Pure functions over `Story`. `graph` builds adjacency from `jump.goto` + `choice.options[].goto`; computes `reachable` (BFS from `meta.start`), `unreachable`, `dead-ends` (nodes whose body cannot reach an `end`/has no outgoing). `simulate` wraps `engine.Simulation` with an explicit `actions` list + `seed` → `{ finalState, transcript, hash, reached }`. `list-variables` infers names from `set`/`add`/`roll` targets + `choice` `if` conditions. `find-references(id)` scans nodes/statements/assets/characters. `diff(a,b)` = structural added/removed/changed for nodes, statements, assets, characters. Iterate ids in **sorted order** (golden rule).
**Patterns to follow:** `packages/engine/src/simulation.ts` (Simulation API, `hash`), `packages/engine/src/reducer.ts` (statement shapes).
**Test scenarios:**
- `graph` on a fixture with an orphan node reports it `unreachable`; a node with no path to `end` reports as `dead-end`; `reachable` includes `meta.start`.
- `simulate` on `examples/cafe.story.json` with the good-ending actions returns the expected transcript tail and a stable `hash` (matches `engine` directly).
- `list-variables` on cafe returns `trust` + `luck`.
- `find-references("her")` returns the `show` statements that use the asset.
- `diff` reports an appended statement as a change on that node.
- `validate` passes cafe and surfaces a seeded cross-ref issue on a broken fixture.
**Verification:** all understand tasks callable via the registry; results deterministic across runs.

### U3. Manipulate spine + `applyEdit`

**Goal:** The spine edit commands (KTD-7), each applied through the always-valid `applyEdit`.
**Requirements:** origin → "manipulate" surface; KTD-3, KTD-7.
**Dependencies:** U1.
**Files:** `packages/world/src/manipulate/*.ts`, `packages/world/src/applyEdit.ts`, `packages/world/src/index.ts` (register), `packages/world/test/manipulate.test.ts`.
**Approach:** Each command = a `Task` (kind `manipulate`) with a Zod `params` schema + `apply(story, params) → Story` (pure, returns a new Story; never mutates). `applyEdit(story, name, params)` looks up the command, validates params (Zod), runs `apply`, then `validateStory(result)`; returns `Result<Story>` — on any validation failure returns `{ok:false, issues}` and the original story is untouched. Keep node/statement/asset/character arrays in their authored order except where the engine requires sort (sprites already sorted in engine).
**Patterns to follow:** `packages/schema/src/validate.ts` (cross-ref checks the result must satisfy), `packages/engine/src/reducer.ts` (immutability style).
**Test scenarios:**
- `create-node` + `append-statement` (say + end) builds a Story that `validateStory` accepts.
- `delete-node` of a node still referenced by a `goto` returns `{ok:false}` with a cross-ref issue; original story unchanged.
- `rewire-goto` updates a `choice` option target; result re-validates.
- `register-asset` then `append-statement` of a `show` referencing it passes; referencing an unregistered asset fails.
- `set-meta` changing `start` to an unknown node id fails with the `meta.start` issue.
- Invalid params (e.g., `create-node` with a non-slug id) rejected before apply.
**Verification:** every spine command callable via the registry; `applyEdit` upholds the always-valid invariant in all failure tests.

### U4. EditLog — event-sourced doc, undo/redo/revert-run, JSONL

**Goal:** Canonical `{baseStory, records}` with fold, run grouping, undo/redo/revert-run, JSONL export/import.
**Requirements:** KTD-1, KTD-2, KTD-6.
**Dependencies:** U3.
**Files:** `packages/world/src/log.ts`, `packages/world/src/index.ts`, `packages/world/test/log.test.ts`.
**Approach:** `EditRecord = { seq, runId, command, params }`. `EditLog` holds `baseStory` + ordered records + a head index (for undo/redo). `apply(name, params, {runId})` → runs `applyEdit` on `currentStory`; on success appends a record; on failure returns issues and leaves the log unchanged. `currentStory()` = `fold(applyEdit, baseStory, records[0..head])`. `undo`/`redo` move head; `revertRun(runId)` truncates the contiguous tail sharing that runId then refolds. JSONL: one record per line; `export()`/`import(base, jsonl)`; metadata/timestamps (if any) live outside the fold (KTD-6).
**Patterns to follow:** `packages/engine/src/simulation.ts` `record()`/`replayTrace()` (JSONL + replay-equality discipline).
**Test scenarios:**
- Applying a sequence yields a `currentStory` equal to folding the same commands directly.
- `undo` then `redo` returns the same story; `undo` past base is a no-op.
- `revertRun` drops exactly the run's N records; story matches the pre-run state.
- A rejected (invalid) command leaves the log length + currentStory unchanged and returns issues.
- **Replay determinism:** `export()` → `import()` reproduces an identical `currentStory` and the same `validateStory` outcome (regression analogous to `engine.replayTrace`).
**Verification:** log round-trips through JSONL with byte-identical resulting Story.

### Phase B — agent loop

### U5. Provider tool-calling extension (additive)

**Goal:** Optional tool definitions + tool-call results on `LLMProvider`, back-compat.
**Requirements:** KTD-8.
**Dependencies:** none (independent of world; can land in parallel with Phase A).
**Files:** `packages/authoring/src/provider.ts`, `packages/authoring/src/providers/openai-compatible.ts`, `packages/authoring/test/provider.test.ts`.
**Approach:** Add `ToolDefinition { name; description; parameters: unknown /* JSON Schema */ }`. Extend `CompletionRequest` with optional `tools?: ToolDefinition[]`; `CompletionResult` with optional `toolCalls?: { id; name; arguments: unknown }[]`; `LLMCapabilities` with `tools: boolean`. In `openai-compatible`, when `tools` present + capable, send OpenAI-style `tools` and parse `choices[0].message.tool_calls` (JSON-parse `arguments`). All fields optional → existing `generateStory` path unchanged.
**Patterns to follow:** `packages/authoring/src/providers/openai-compatible.ts` (request/response mapping, injected `fetchImpl`).
**Test scenarios:**
- A request with `tools` includes them in the POST body (assert via injected fetch).
- A scripted response carrying `tool_calls` is parsed into `toolCalls` with JSON-parsed `arguments`.
- A request without `tools` produces an unchanged body and a normal text completion (back-compat).
- Malformed `arguments` JSON surfaces as an error/empty rather than throwing unhandled.
**Verification:** existing authoring tests still pass; new tool-call parsing covered.

### U6. Tool adapter — world manifest ↔ provider tools

**Goal:** Derive `ToolDefinition[]` from `world.describe()`; dispatch a tool call back to the world task/log.
**Requirements:** KTD-4, parity.
**Dependencies:** U2, U3, U4, U5.
**Files:** `packages/authoring/src/tools.ts`, `packages/authoring/package.json` (add `@ludelier/world` dep), `packages/authoring/test/tools.test.ts`.
**Approach:** `worldTools(world) → ToolDefinition[]` (one per task; `parameters` = its JSON Schema). `dispatch(world, log, runId, call) → Result`: validate `arguments` against the task's Zod params; for `understand` run it on `currentStory`; for `manipulate` apply via the log under `runId`. Returns the uniform envelope so the loop can feed results back.
**Patterns to follow:** U1 registry, U4 log API.
**Test scenarios:**
- `worldTools` length equals the manifest task count; each carries a JSON Schema.
- Dispatching a manipulate tool call appends one record to the log and keeps the Story valid.
- Dispatching with bad arguments returns `{ok:false, issues}` and does not touch the log.
- Dispatching an understand tool returns data without mutating the log.
**Verification:** a tool call name round-trips manifest → dispatch → world task.

### U7. Autonomous run loop (`runAgent`)

**Goal:** Run a whole task end-to-end (one runId), self-verify, return a reviewable result.
**Requirements:** origin → agent loop (autonomous → review-after); KTD-9.
**Dependencies:** U6.
**Files:** `packages/authoring/src/run.ts`, `packages/authoring/src/index.ts`, `packages/authoring/test/run.test.ts`.
**Approach:** `runAgent({ prompt, provider, story, maxSteps })`: seed `system` (task framing + manifest summary) + `user` (prompt); loop calling `provider.complete({ messages, tools })`; for each `toolCall`, `dispatch` and append the tool result message; stop on a `done` tool / no tool calls / `maxSteps`. Then self-verify: `validate` + `graph` + `simulate` (explicit actions if the agent supplied any, else a default walk). Return `{ story, runId, commands, diff, verification, transcript }`. Caller keeps or `revertRun(runId)`.
**Execution note:** Implement test-first against the scripted provider — the loop contract (one runId, append-on-success, stop conditions, verify) is the unit's whole value.
**Patterns to follow:** `packages/authoring/test/author.test.ts` (scripted provider harness), `packages/authoring/src/author.ts` (loop + transcript discipline).
**Test scenarios (scripted provider, hermetic):**
- A scripted tool-call sequence that adds a node + appends statements + rewires a goto produces a valid Story; `verification.validate.ok` is true; `diff` reflects the new node.
- Every intermediate step keeps the Story Zod-valid (assert after each dispatch).
- `revertRun(result.runId)` returns the Story to its pre-run state (one undo of N).
- Loop stops at `maxSteps` and returns a partial result rather than looping forever.
- An invalid tool call mid-run returns issues fed back to the model; a subsequent corrected call succeeds (recovery).
- A `done` tool call ends the loop before `maxSteps`.
**Verification:** `pnpm test` green with no network; run result is deterministic for a fixed script.

### Phase C — surfaces + wiring

### U8. CLI — registry-derived world subcommands + `author run`

**Goal:** Expose the world API + agent run via the CLI (slice-1 surface).
**Requirements:** origin → slice-1 acceptance; parity.
**Dependencies:** U2, U3, U4 (world subcommands); U7 (`author run`).
**Files:** `packages/cli/package.json` (add `@ludelier/world` dep), `packages/cli/src/index.ts`, `packages/cli/test/` (smoke; new — CLI currently untested).
**Approach:** Extend the existing `parseArgs` dispatcher: `world describe` (print manifest), `world query <task> --story s.json [--json '{...}']`, `world edit <cmd> --story s.json [--json '{...}'] [--log l.jsonl] [-o out.json]`, `world undo|redo --story ... --log ...`, plus log `export`/`import`. `author run "<prompt>" --story s.json --log l.jsonl` uses `providersFromEnv` (BYOK); if no key, exit with a clear message (live LLM optional). Subcommand list + help derive from `world.describe()`.
**Patterns to follow:** `packages/cli/src/index.ts` (current `validate|simulate|replay` dispatcher, `loadStory`).
**Test scenarios:**
- `world describe` lists the registered tasks (count > 0).
- `world query graph` on cafe prints reachability JSON.
- `world edit append-statement ...` writes a new story file + appends a log record; re-loading validates.
- `world undo` after an edit restores the prior story.
- `author run` with no provider key exits non-zero with a clear BYOK message.
**Verification:** CLI smoke runs via `tsx`, hermetic (no network); `just check` green.

### U9. Wiring, changesets, docs

**Goal:** Finalize workspace wiring + handoff docs.
**Requirements:** golden rules (changeset per change; docs current).
**Dependencies:** U1–U8.
**Files:** `tsconfig.json` (confirm `@ludelier/world` path), `.changeset/*.md` (world minor/new, authoring minor, cli minor), `AGENTS.md` (repo layout: add `world/`), `STATUS.md` (P2 progress), `docs/plans/2026-06-19-001-feat-world-api-agent-harness-plan.md` (mark units done as they land — optional).
**Approach:** Ensure root `tsconfig.json` paths + `pnpm-workspace` pick up the new package; add changesets; refresh the two docs.
**Test expectation:** none — config/docs; covered by `pnpm typecheck` + the other units' tests.
**Verification:** `just ci` green; `pnpm changeset:status` shows the pending bumps.

---

## System-wide impact

- **New workspace package** `@ludelier/world` → root `tsconfig.json` paths + lockfile; `cli` and `authoring` gain a dependency on it.
- **`@ludelier/authoring` provider interface** gains optional fields — **additive, back-compat**; `generateStory` and existing tests unaffected (U5 covers this).
- **CLI** grows new subcommands; existing `validate|simulate|replay` unchanged.
- Determinism surface widens (the edit log) — covered by the U4 replay regression, consistent with the engine's existing replay discipline.

---

## Risks & mitigations

- **Provider tool-calling API variance** (OpenAI vs OpenRouter). _Mitigation:_ slice 1 proves the loop with a scripted provider (KTD-9); live wiring is exercised by the same abstraction but deferred from the CI gate.
- **`simulate` branch explosion** if extended to all-paths. _Mitigation:_ slice 1 takes an explicit actions list only; bounded all-paths deferred (Scope).
- **Cross-ref breakage on delete/rewire.** _Mitigation:_ `applyEdit` re-validates every edit (KTD-3); U3 tests assert rejection + no-mutation.
- **Agent loop non-termination.** _Mitigation:_ `maxSteps` + explicit `done` tool (U7).
- **`z.toJSONSchema` fidelity for tool params.** _Mitigation:_ reuse the existing guarded path from `packages/schema/src/jsonSchema.ts`; tool params are small Zod objects.

---

## Done = slice 1 acceptance (from origin)

A scripted agent run can, end-to-end and headlessly: add a branch to `examples/cafe.story.json`, keep the Story Zod-valid at every step, self-verify via `graph` + `simulate`, and produce a reviewable diff + a revertable run — all in CI with no live LLM. Adding a new capability requires only a new registry entry; it appears automatically in `describe()`, the CLI, and the agent's toolset.
