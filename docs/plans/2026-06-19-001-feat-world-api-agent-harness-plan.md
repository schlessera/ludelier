---
title: "feat: World API & agent harness — slice 1 (CLI-first)"
type: feat
status: completed
created: 2026-06-19
deepened: 2026-06-21
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
- **Remaining flattened statement-add commands** (see KTD-4 / KTD-7): the slice-1 spine flattens only `append-{say,show,choice,jump,end}`; the other statement kinds (`hide`, `scene`, `set`, `add`, `roll`) and all `insert-*` per-op variants are deferred additive entries following the same flattened-scalar pattern.
- **Stricter cross-reference validation** beyond what `validateStory` checks today: variable-declaration coherence (conditions/`set`/`add`/`roll` targets) and `show`/`hide` sprite-slot coherence. Slice 1 adds only the `say.who` check (KTD-3) since `add-character`+`append-say` are both in the spine; the rest are deferred. (see origin: validation surface)
- `simulate` **all-paths** exploration strategy (slice 1 takes an explicit actions list only). (see origin: Open questions)
- Live-LLM end-to-end run (BYOK) — wired but optional; not a CI gate.
- Editor UI panel + agentic chat surface; author-facing DSL; collaboration; asset-gen hooks (P3); cloud seam (P4).

---

## Key technical decisions

- **KTD-1 — Event-sourced authoring doc.** Canonical = `{ baseStory, log: EditRecord[] }`; `currentStory = fold(applyEdit, base, log)`. Mirrors the runtime's JSONL action log — one event-sourcing idea, two layers. (see origin: Edit model)
- **KTD-2 — Undo by refold, not inverse-ops.** `undo`/`redo` move the log head; `revert-run` drops a run's contiguous tail; the Story is recomputed by refold. Always correct under the linear-history invariant (KTD-11); inverse-ops are a later perf option only. _Tradeoff:_ `currentStory()` is an O(n) refold over the log on every call, and each `applyEdit` runs a full `validateStory` — so a run of *k* commands is ~O(k²·storySize). Accepted because slice-1 stories (cafe-sized) and runs are small. **Escape hatch:** memoize `currentStory` at the head and apply incrementally (records are append-only), or adopt inverse-ops, when logs exceed a measured threshold (e.g. hundreds of records). The trigger is a measurement, not a guess.
- **KTD-3 — `applyEdit` is the always-valid chokepoint.** `applyEdit(story, cmd)` → command's pure transform → validation → `Result<Story>` (`{success:true,data}` or `{success:false,issues}`, KTD-5). An invalid edit never mutates the log. **Precise invariant:** "always-valid" means Zod-valid **plus** the cross-references `validateStory` currently checks — duplicate node/asset ids, `meta.start`, `jump.goto`, `choice.options[].goto`, `scene.bg`, `show.asset`. It does **not** today cover `say.who`, variable declarations, or sprite slots. Because `add-character` and `append-say` are both in the spine, slice 1 adds a world-local `say.who` check (a stricter validator layered over `validateStory`); variable/sprite coherence is deferred (Scope → Deferred). State this limitation explicitly rather than implying `validateStory` is a total semantic gate.
- **KTD-4 — Registry-derived surface.** One registry of `{ name, kind, description, params: ZodSchema, run|apply }`. `describe()` emits the manifest (name/kind/description + JSON Schema via the guarded `z.toJSONSchema` call replicated from `packages/schema/src/jsonSchema.ts`). CLI subcommands, LLM tools, and docs derive from it — no hand-maintained lists, no drift. **No in-repo precedent:** there is no existing self-describing task registry to mirror (the closest echoes are the discriminated dispatch in `engine/src/reducer.ts` `switch(stmt.op)` and the capability-bearing interface in `authoring/src/provider.ts`); this surface is greenfield. **`kind` is load-bearing routing metadata,** not a label: dispatch routes `understand`→read `currentStory`, `manipulate`→log apply (U6); the CLI splits `query`/`edit` on it; a mis-tagged task is a silent log-bypass / parity bug. **JSON-Schema fidelity is a cross-surface concern:** the emitted schema drives the LLM toolset *and* CLI `--json` validation *and* (later) UI forms — if they diverge, surfaces accept different inputs. To keep each tool schema a flat object and sidestep the weakest `z.toJSONSchema`/LLM-tool-fill path, statement-bearing commands expose **flattened scalar params** (KTD-7), not a raw `Statement` discriminated union.
- **KTD-5 — Uniform result envelope (`success` discriminant).** Every task returns `Result<T> = {success:true; data:T} | {success:false; issues: Issue[]}`, **aligning on `@ludelier/schema`'s existing `{success}` shape** (not `{ok}`) and reusing its `Issue`. This lets the `validate` task pass `validateStory`'s output through untouched and matches the schema/engine/cli majority. **Deliberate deviation from origin:** the origin spec wrote the envelope as `{ok}`; this plan changes it to `{success}` for schema-passthrough, and the origin doc is annotated to match (no silent divergence). **Conversion point:** `@ludelier/authoring`'s pre-existing `AuthorResult` keeps `ok`, so `runAgent` (U7) — which consumes `{success}` task/dispatch results but returns an `AuthorResult`-shaped value — must map `success→ok` at exactly that one boundary; that is the only place the two discriminants meet, and U7 tests it. New tasks never change call sites.
- **KTD-6 — Determinism via a canonical form.** `EditRecord` carries no wall-clock in the canonical fold (seq + runId + command + params only); any timestamp is sidecar metadata excluded from replay equality. **"Identical Story" is measured against a canonical serialization** that (a) **materializes all schema defaults first** — run the Story through `StoryObject.parse` (or equivalently fill `characters`/`assets` → `[]` and `show.at` → `"center"`) so a refold-built Story and a Zod-loaded base hash equal — then (b) **stable-key-sorts before compare/hash**, mirroring `engine` `simulation.ts` `snapshot()`'s fixed-field-order hashing — not raw `JSON.stringify` (both key order **and** `.default()` materialization vary by construction path; key-sort alone fixes only the former). A `hashStory`-style canonical helper backs the replay regression. **Dual order-stability requirement:** the world now has two order regimes that must both be stable across a refold — authored insertion order (nodes/statements/assets/characters) and engine-required sort order (e.g. sprites) — `apply` transforms must preserve both. The edit-log replay is **end-to-end** (refold reproduces the canonical Story), *not* per-step-hashed like `engine.replayTrace`; an optional per-`EditRecord` story-hash (mirroring `TraceLine.hash`) would localize a mid-log divergence to a single command (deferred — noted in U4).
- **KTD-7 — Slice-1 manipulate set = the spine.** `create-node`, `delete-node`, `set-meta`, `add-character`, `register-asset`, `append-{say,show,choice,jump,end}` (flattened scalar commands, one per statement kind — KTD-4), `remove-statement` (by id/index, no `Statement` param), `rewire-goto`. Proves the registry end-to-end. The remaining statement kinds, `insert-*` variants, and the other manipulate verbs are deferred additive follow-ups (Scope → Deferred). _Decision recorded in lieu of the open call-out; a fresh session may widen U3 if desired._
- **KTD-8 — Provider tool-calling is additive + back-compat.** Extend `CompletionRequest` with optional `tools`, `CompletionResult` with optional `toolCalls`, the internal `ChatCompletionResponse` (in `openai-compatible.ts`) with optional `tool_calls`, and `LLMCapabilities` with `tools`. **`ChatMessage` must also gain the OpenAI-protocol shape for tool turns:** a `role: "tool"` variant carrying a `toolCallId`, and an assistant turn able to echo its `toolCalls` — without these the run loop (U7) has no message shape to append a tool result into, and the live provider rejects the request. The existing `role: "system" | "user" | "assistant"` + string `content` stays valid (all additions optional) → `generateStory` (chat + `json_schema`) is unaffected. (see origin: Open questions — provider tool-calling)
- **KTD-9 — Hermetic agent loop.** The run loop is tested with a **scripted provider** returning canned tool-call sequences (pattern: `packages/authoring/test/author.test.ts`, `scripted(responses)`). Live OpenAI/OpenRouter wiring is exercised by the same abstraction but is not a CI gate.
- **KTD-10 — Package home `@ludelier/world`.** Pure; depends on `@ludelier/schema` + `@ludelier/engine`. `authoring` and `cli` depend on `world`. `package.json` follows sibling convention: `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, version `0.1.0`. (see origin: Package home)
- **KTD-11 — Linear-history invariant (slice 1).** History is strictly linear: a new edit after `undo` **discards the orphaned redo tail** (no branching). `revert-run` is defined only for a run whose records form a **contiguous tail** and asserts that contiguity (it fails rather than silently dropping unrelated records). Runs are **serialized** — one open run at a time, no interleaving of `runId`s — which is what makes "contiguous tail" sound. Interleaved runs, mid-history branching, and concurrent human+agent editing (the deferred co-editing UI) are explicitly **out of slice-1 scope** and flagged as future hazards, not assumed solved. This invariant holds by construction in slice 1 (the agent loop groups one run under one `runId`); writing it down prevents the linear-only tests from masking the gap.

---

## Output structure (new package)

```
packages/world/
  package.json                  # @ludelier/world; private, type:module, exports; deps: schema, engine (workspace:*)
  src/
    index.ts                    # re-exports + registers all tasks
    result.ts                   # Result<T> envelope (success discriminant), ok()/fail() helpers
    canonical.ts                # canonical Story serialization + hashStory (stable key-sort)
    registry.ts                 # Task type, defineTask, the two registries, describe()
    understand/
      validate.ts  lists.ts  get-node.ts  references.ts   # U2: pure reads
      graph.ts                  # U10
      simulate.ts               # U11 (only engine-dependent task)
      diff.ts                   # U12
    manipulate/
      create-node.ts  delete-node.ts  set-meta.ts  add-character.ts
      register-asset.ts  remove-statement.ts  rewire-goto.ts
      append-say.ts  append-show.ts  append-choice.ts  append-jump.ts  append-end.ts
      say-who-check.ts          # world-local stricter cross-ref (KTD-3)
    applyEdit.ts                # apply command → validate (+ say.who) → Result<Story>
    log.ts                      # EditRecord, EditLog: apply/fold/undo/redo/revert-run, JSONL io
  test/
    registry.test.ts  understand.test.ts  graph.test.ts  simulate.test.ts
    diff.test.ts  manipulate.test.ts  log.test.ts
```

_The tree is a scope declaration, not a constraint; per-unit `Files` are authoritative._

---

## High-level technical design

_Directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```
                 ┌─────────────────────── @ludelier/world (pure) ───────────────────────┐
 describe() ◄────┤ registry: Task{name,kind,description,params:Zod, run|apply}           │
                 │ understand: validate lists get-node references · graph · simulate·diff │
                 │ manipulate (spine): create/delete-node set-meta add-character          │
                 │   register-asset append-{say,show,choice,jump,end} remove-stmt rewire  │
                 │ applyEdit(story,cmd) → cmd.apply → validate(+say.who) → Result{success} │
                 │ EditLog{baseStory, records[]}  currentStory = fold(applyEdit)          │
                 │   undo/redo = move head (linear) · revert-run = drop runId tail · JSONL │
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

**Goal:** New package with the task-registry type, result envelope, canonical-hash helper, and `describe()`.
**Requirements:** KTD-4, KTD-5, KTD-6, KTD-10.
**Dependencies:** none.
**Files:** `packages/world/package.json`, `packages/world/src/index.ts`, `packages/world/src/registry.ts`, `packages/world/src/result.ts`, `packages/world/src/canonical.ts`, `packages/schema/src/jsonSchema.ts` (lift the shared helper — see Approach), `tsconfig.json` (add `@ludelier/world` path), `packages/world/test/registry.test.ts`.
**Approach:** `Task = { name; kind: "understand" | "manipulate"; description; params: ZodTypeAny; run?(story, params); apply?(story, params) }`. Two registries (understand, manipulate) keyed by name. **Registration asserts `kind`⟺handler correspondence** (`understand` ⟺ `run` defined and no `apply`; `manipulate` ⟺ `apply` defined and no `run`) and rejects a mis-declared task — `kind` is load-bearing routing (KTD-4), so a `manipulate` task with a `run` handler would silently bypass the log; the registry, not the dispatcher, is where this is caught. `describe()` → array of `{ name, kind, description, schema }` where `schema = toJsonSchema(params)`. **Lift a shared `toJsonSchema(schema)` (the guarded `z.toJSONSchema` call) into `@ludelier/schema/src/jsonSchema.ts` as a named export and have `storyJsonSchema()` call it** — three consumers (world `describe()`, future CLI `--json` validation, future UI) otherwise each copy the guard and drift; one home, no drift. `Result<T>` uses the **`success` discriminant** (KTD-5) with `ok(data)` / `fail(issues)` helpers, reusing `Issue` from `@ludelier/schema` — so `validateStory` output passes through untouched. `canonical.ts` provides a Story serialization that **materializes schema defaults (via `StoryObject.parse`) then stable-key-sorts** + `hashStory` (KTD-6), mirroring `engine` `snapshot()`'s fixed-order discipline. `package.json` must carry `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, version `0.1.0` (sibling convention).
**Patterns to follow:** `packages/schema/src/jsonSchema.ts` (the `z.toJSONSchema` guard — the reusable *idea*, not a callable), `packages/schema/src/validate.ts` (`ValidateResult`/`Issue` shape this envelope aligns with), `packages/engine/src/reducer.ts` `switch(stmt.op)` + `packages/authoring/src/provider.ts` (closest in-repo analogues for keyed dispatch / capability interfaces — no task-registry precedent exists). `packages/engine/src/simulation.ts` `snapshot()` (canonical-hash discipline).
**Test scenarios:**
- Registering a task then `describe()` returns it with `kind`, `description`, and a JSON Schema object (`type: "object"`).
- A task whose params fail Zod validation surfaces issues via the result envelope (`{success:false, issues}`, no throw).
- A failing `validateStory` passed through the envelope surfaces as `{success:false, issues}` unchanged (no `ok`/`success` field mismatch).
- Duplicate task name is rejected at registration.
- A task whose `kind` mismatches its handler (`manipulate` with a `run`, or `understand` with an `apply`) is rejected at registration.
- `hashStory` is stable across two structurally-equal Stories built by different key-insertion paths (canonical form, not raw `JSON.stringify`).
- `hashStory` of a Story with `characters`/`assets` omitted equals one with them materialized to `[]`, and a `show` with `at` omitted equals one with `at:"center"` (default materialization, not just key-sort).
**Verification:** `pnpm typecheck` green; `describe()` lists registered tasks with schemas; `hashStory` equal for canonically-equal Stories.

### U2. Understand tasks — pure reads

**Goal:** `validate`, `list-characters|assets|variables`, `get-node`, `find-references` — the pure-over-`Story` reads with a single (`@ludelier/schema`) import surface. `graph`, `simulate`, `diff` split into U10/U11/U12 (different dependency footprint / risk).
**Requirements:** origin → "understand" surface; KTD-5, KTD-6.
**Dependencies:** U1.
**Files:** `packages/world/src/understand/validate.ts`, `lists.ts`, `get-node.ts`, `references.ts`, `packages/world/src/index.ts` (register), `packages/world/test/understand.test.ts`.
**Approach:** Pure functions over `Story`. `validate` wraps `validateStory` (its `{success}` output passes through the envelope untouched — KTD-5). `list-variables` infers names from `set`/`add`/`roll` targets + `choice` `if` conditions. `list-characters`/`list-assets` are flat reads. `get-node(id)` returns a node or a `{success:false}` not-found issue. `find-references(id)` scans nodes/statements/assets/characters. **Iterate ids in sorted order** before building any output collection (golden rule — determinism). 
**Patterns to follow:** `packages/schema/src/validate.ts` (`validateStory`, `Issue`), `packages/engine/src/reducer.ts` + `packages/schema/src/story.ts` (statement shapes for variable inference).
**Test scenarios:**
- `list-variables` on cafe returns `trust` + `luck` (sorted).
- `find-references("her")` returns the `show` statements that use the asset.
- `validate` passes cafe and surfaces a seeded cross-ref issue on a broken fixture.
- `get-node` on an unknown id returns `{success:false}` with a not-found issue (no throw).
- **Determinism:** `list-*` / `find-references` over a fixture with deliberately out-of-order ids return stably sorted output across runs (golden-rule assertion, currently only prose in the plan).
**Verification:** all U2 understand tasks callable via the registry; results deterministic and stably sorted across runs.

### U3. Manipulate spine + `applyEdit`

**Goal:** The spine edit commands (KTD-7) — flattened scalar statement-add commands plus node/meta/character/asset/flow verbs — each applied through the always-valid `applyEdit`.
**Requirements:** origin → "manipulate" surface; KTD-3, KTD-4, KTD-7.
**Dependencies:** U1.
**Files:** `packages/world/src/manipulate/create-node.ts`, `delete-node.ts`, `set-meta.ts`, `add-character.ts`, `register-asset.ts`, `remove-statement.ts`, `rewire-goto.ts`, `append-say.ts`, `append-show.ts`, `append-choice.ts`, `append-jump.ts`, `append-end.ts`, `say-who-check.ts`, `packages/world/src/applyEdit.ts`, `packages/world/src/index.ts` (register), `packages/world/test/manipulate.test.ts`.
**Approach:** Each command = a `Task` (kind `manipulate`) with a **flat scalar Zod `params` schema** (KTD-4 — e.g. `append-say {nodeId, who, text}`, `append-show {nodeId, sprite, asset, at?}` — `ShowStatement` requires BOTH a `sprite` stage-slot id and an `asset` id (distinct ids; cafe uses `{sprite:"her", asset:"her"}` coincidentally), so the command builds `{op:"show", sprite, asset, at}`; one command per statement kind, no raw `Statement` discriminated union) + `apply(story, params) → Story` (pure, returns a new Story; never mutates). `apply` builds the corresponding `Statement` object internally. `applyEdit(story, name, params)` looks up the command, validates params (Zod), runs `apply`, then runs **`validateStory` plus the world-local `say.who` cross-ref check** (`say-who-check.ts` — KTD-3, scans the whole resulting Story); returns `Result<Story>` — on any validation failure returns `{success:false, issues}` and the original story is untouched. Keep node/statement/asset/character arrays in their authored order except where the engine requires sort (sprites already sorted in engine) — both order regimes must be refold-stable (KTD-6).
**Patterns to follow:** `packages/schema/src/validate.ts` (cross-ref checks the result must satisfy + where the `say.who` check layers on), `packages/engine/src/reducer.ts` (immutability style + statement construction).
**Test scenarios:**
- `create-node` + `append-say` + `append-end` builds a Story that `validateStory` accepts.
- `delete-node` of a node still referenced by a `goto` returns `{success:false}` with a cross-ref issue; original story unchanged.
- `rewire-goto` updates a `choice` option target; result re-validates.
- `register-asset` then `append-show` referencing it passes; referencing an unregistered asset fails.
- `append-say` with a `who` not in the characters list fails the world-local `say.who` check with an issue; original story unchanged (the gap `validateStory` alone would miss — KTD-3).
- `set-meta` changing `start` to an unknown node id fails with the `meta.start` issue.
- Invalid params (e.g., `create-node` with a non-slug id, `append-say` missing `text`) rejected before apply.
**Verification:** every spine command callable via the registry; `applyEdit` upholds the always-valid invariant (including `say.who`) in all failure tests.

### U4. EditLog — event-sourced doc, undo/redo/revert-run, JSONL

**Goal:** Canonical `{baseStory, records}` with fold, run grouping, linear undo/redo/revert-run (KTD-11), JSONL export/import.
**Requirements:** KTD-1, KTD-2, KTD-6, KTD-11.
**Dependencies:** U3.
**Files:** `packages/world/src/log.ts`, `packages/world/src/index.ts`, `packages/world/test/log.test.ts`.
**Approach:** `EditRecord = { seq, runId, command, params }`. `EditLog` holds `baseStory` + ordered records + a head index (for undo/redo). `apply(name, params, {runId})` → runs `applyEdit` on `currentStory`; on success appends a record; on failure returns issues and leaves the log unchanged. **Linear-history (KTD-11):** an `apply` after `undo` first **discards the orphaned redo tail** (records above head), so history never branches. `currentStory()` = `fold(applyEdit, baseStory, records[0..head])`. `undo`/`redo` move head. `revertRun(runId)` **asserts the run's records form a contiguous tail** (fails otherwise), then truncates that tail and refolds; runs are serialized (one open run at a time). `runId` is caller-supplied (the CLI / `runAgent` mints it); the log does not generate it, and the serialized-runs invariant (KTD-11) assumes the caller never reuses a live `runId`. JSONL: one record per line; `export()`/`import(base, jsonl)`; metadata/timestamps (if any) live outside the fold (KTD-6). **`import`/base-load runs the stricter (`say.who`-inclusive, KTD-3) validator, not plain `validateStory`** — otherwise a hand-authored base with a dangling `say.who` folds as `currentStory` while the always-valid invariant silently does not hold for it. Optional per-record `hashStory` fingerprint to localize a refold divergence (deferred — note in code, not slice-1 required).
**Patterns to follow:** `packages/engine/src/simulation.ts` `record()`/`replayTrace()` (JSONL + replay-equality discipline — but note it is *step-hashed*; this log compares end-to-end via `hashStory`).
**Test scenarios:**
- Applying a sequence yields a `currentStory` equal to folding the same commands directly (compare via `hashStory`, not `JSON.stringify`).
- `undo` then `redo` returns the same story; `undo` past base is a no-op.
- **Linear-history:** `undo` then a *new* `apply` discards the redo tail — a subsequent `redo` is a no-op and the new record is the head (KTD-11).
- `revertRun` drops exactly the run's N records; story matches the pre-run state (canonical compare).
- `revertRun` on a run whose records are *not* a contiguous tail fails with an issue rather than dropping unrelated records (contiguity assertion — KTD-11).
- A rejected (invalid) command leaves the log length + currentStory unchanged and returns issues.
- **Replay determinism:** `export()` → `import()` reproduces a `currentStory` with an identical **canonical hash** and the same `validateStory` outcome (regression analogous to `engine.replayTrace`, end-to-end).
**Verification:** log round-trips through JSONL with a canonically-identical resulting Story; linear-history + contiguity invariants hold under test.

### U10. Understand task — `graph`

**Goal:** Reachability + dead-end analysis over the Story graph.
**Requirements:** origin → "understand" surface; KTD-6.
**Dependencies:** U1 (depends only on U1; runs in parallel with U2/U11/U12).
**Files:** `packages/world/src/understand/graph.ts`, `packages/world/src/index.ts` (register), `packages/world/test/graph.test.ts`.
**Approach:** Pure function over `Story`. Build adjacency from `jump.goto` + `choice.options[].goto`; compute `reachable` (BFS from `meta.start`), `unreachable`, `dead-ends` (nodes whose body cannot reach an `end`/has no outgoing). Iterate node ids in **sorted order** before BFS and before emitting any collection (golden rule).
**Patterns to follow:** `packages/engine/src/reducer.ts` (statement shapes for goto extraction), `packages/schema/src/story.ts` (`choice.options`, `jump`).
**Test scenarios:**
- `graph` on a fixture with an orphan node reports it `unreachable`; a node with no path to `end` reports as `dead-end`; `reachable` includes `meta.start`.
- A diamond graph (two choice options re-converging) reports both branch nodes reachable, no false dead-end.
- Output collections are stably sorted across runs (determinism).
**Verification:** `graph` callable via the registry; reachability deterministic across runs.

### U11. Understand task — `simulate`

**Goal:** Deterministic headless simulation wrapping `engine.Simulation`.
**Requirements:** origin → "understand" surface; KTD-6.
**Dependencies:** U1 (introduces the `@ludelier/engine` import surface to `world`; runs in parallel with U2/U10/U12).
**Files:** `packages/world/src/understand/simulate.ts`, `packages/world/src/index.ts` (register), `packages/world/test/simulate.test.ts`.
**Approach:** `simulate({ actions, seed })` wraps `engine.Simulation` with an explicit `actions` list + `seed` → `{ finalState, transcript, hash, reached }`. **`reached` is not on the `Simulation` surface** (the engine tracks no visited-node set; `snapshot()` is cursor/vars/rng/stage/pending/done) — accumulate it in this task by recording each `cursor.node` across steps, sorted for determinism. Slice 1 takes an explicit actions list only (all-paths exploration deferred — Scope).
**Patterns to follow:** `packages/engine/src/simulation.ts` (Simulation API, `hash`).
**Test scenarios:**
- `simulate` on `examples/cafe.story.json` with the good-ending actions returns the expected transcript tail and a stable `hash` (matches `engine` directly).
- Same story + seed + actions ⇒ identical `hash` across repeated calls (determinism).
**Verification:** `simulate` callable via the registry; hash matches `engine.Simulation` for the same inputs.

### U12. Understand task — `diff`

**Goal:** Structural diff of two Stories, feeding run review (U7).
**Requirements:** origin → "understand" surface (`diff` renders run review).
**Dependencies:** U1 (runs in parallel with U2/U10/U11).
**Files:** `packages/world/src/understand/diff.ts`, `packages/world/src/index.ts` (register), `packages/world/test/diff.test.ts`.
**Approach:** `diff(a, b)` = structural added/removed/changed for nodes, statements, assets, characters. Iterate ids in **sorted order** so the diff is stable regardless of input ordering (golden rule).
**Patterns to follow:** `packages/schema/src/story.ts` (Story shape being compared).
**Test scenarios:**
- `diff` reports an appended statement as a change on that node.
- `diff` of a Story against itself is empty.
- `diff` reports an added node as added and a deleted node as removed, sorted stably.
**Verification:** `diff` callable via the registry; output stable across input orderings.

### Phase B — agent loop

### U5. Provider tool-calling extension (additive)

**Goal:** Optional tool definitions + tool-call results on `LLMProvider`, back-compat.
**Requirements:** KTD-8.
**Dependencies:** none (independent of world; can land in parallel with Phase A).
**Files:** `packages/authoring/src/provider.ts`, `packages/authoring/src/providers/openai-compatible.ts`, `packages/authoring/test/provider.test.ts`.
**Approach:** Add `ToolDefinition { name; description; parameters: unknown /* JSON Schema */ }`. Extend `CompletionRequest` with optional `tools?: ToolDefinition[]`; `CompletionResult` with optional `toolCalls?: { id; name; arguments: unknown }[]`; `LLMCapabilities` with `tools: boolean`. **Extend `ChatMessage` (KTD-8):** add a `role: "tool"` variant with `toolCallId: string`, and let an assistant message optionally carry `toolCalls` so it can be echoed back — the loop (U7) appends both. In `openai-compatible`, when `tools` present + capable, send OpenAI-style `tools` and parse `choices[0].message.tool_calls` (JSON-parse `arguments`); the message serializer must emit `tool_call_id` for `role:"tool"` messages and `tool_calls` for assistant echoes. **The internal `ChatCompletionResponse` interface (`openai-compatible.ts`) currently models only `content` — it must gain `tool_calls?` before the message can be parsed.** All public fields optional → existing `generateStory` path unchanged.
**Patterns to follow:** `packages/authoring/src/providers/openai-compatible.ts` (request/response mapping, injected `fetchImpl`).
**Test scenarios:**
- A request with `tools` includes them in the POST body (assert via injected fetch).
- A scripted response carrying `tool_calls` is parsed into `toolCalls` with JSON-parsed `arguments`.
- A `role:"tool"` message (with `toolCallId`) and an assistant echo carrying `toolCalls` round-trip into a protocol-faithful POST body (`tool_call_id` / `tool_calls` present).
- A request without `tools` produces an unchanged body and a normal text completion (back-compat).
- Malformed `arguments` JSON surfaces as an error/empty rather than throwing unhandled.
**Verification:** existing authoring tests still pass; new tool-call parsing covered.

### U6. Tool adapter — world manifest ↔ provider tools

**Goal:** Derive `ToolDefinition[]` from `world.describe()`; dispatch a tool call back to the world task/log.
**Requirements:** KTD-4, parity.
**Dependencies:** U1, U5 (code-level — `worldTools` iterates `world.describe()` at runtime and emits `ToolDefinition`s, so it needs only the registry + the tool-definition type). Meaningful end-to-end coverage of U6/U7 needs the task units (U2, U3, U4, U10, U11, U12) registered, but U6 can be built and unit-tested against a small fixture registry **in parallel** with them — the dependency on the full task set is a test-completeness one, not a code one.
**Files:** `packages/authoring/src/tools.ts`, `packages/authoring/package.json` (add `@ludelier/world` dep), `packages/authoring/test/tools.test.ts`.
**Approach:** `worldTools(world) → ToolDefinition[]` (one per task; `parameters` = its JSON Schema). `dispatch(world, log, runId, call) → Result`: validate `arguments` against the task's Zod params; **route on the task's `kind`** (KTD-4 — `understand` runs on `currentStory`; `manipulate` applies via the log under `runId`). A mis-routed/mis-tagged task would bypass the log chokepoint, so `dispatch` must trust `kind` from the registry, never from the call. Returns the uniform `{success}` envelope so the loop can feed results back.
**Patterns to follow:** U1 registry, U4 log API.
**Test scenarios:**
- `worldTools` length equals the manifest task count; each carries a JSON Schema.
- Dispatching a manipulate tool call appends one record to the log and keeps the Story valid.
- Dispatching with bad arguments returns `{success:false, issues}` and does not touch the log.
- Dispatching an understand tool returns data without mutating the log (routed by `kind`).
**Verification:** a tool call name round-trips manifest → dispatch → world task; manipulate routes through the log, understand does not.

### U7. Autonomous run loop (`runAgent`)

**Goal:** Run a whole task end-to-end (one runId), self-verify, return a reviewable result.
**Requirements:** origin → agent loop (autonomous → review-after); KTD-9, KTD-11.
**Dependencies:** U5, U6 (the loop's provider extension + tool adapter), U10, U11, U12 (self-verify uses `graph` + `simulate`; review uses `diff`). A *meaningful* run also needs the manipulate/understand spine (U2, U3, U4) registered — U6 itself only code-depends on U1+U5, so the chain that gates a real `runAgent` is U1→U2/U3/U4 + U10/U11/U12 registered, plus U5/U6 for the loop. Listed so the prerequisite set isn't hidden behind U6.
**Files:** `packages/authoring/src/run.ts`, `packages/authoring/src/index.ts`, `packages/authoring/test/run.test.ts`.
**Approach:** `runAgent({ prompt, provider, story, maxSteps })`: seed `system` (task framing + manifest summary) + `user` (prompt); generate **one fresh `runId`** for the whole run and thread it through every `dispatch` (uniqueness is `runAgent`'s responsibility — the serialized-runs / contiguous-tail invariant of KTD-11 holds only if no two concurrent callers reuse a `runId`); loop calling `provider.complete({ messages, tools })`; for each `toolCall`, `dispatch` and append the tool result message (`role:"tool"` + `toolCallId`, plus the assistant echo — KTD-8/U5); stop on a `done` tool / no tool calls / `maxSteps`. **The `done` tool is loop-control only — it is NOT a world task and must never appear in `describe()`** (it is injected into the tool list by `runAgent`, kept outside the registry so the CLI/UI derivation ignores it — SI parity guardrail). Then self-verify: `validate` + `graph` (U10) + `simulate` (U11, explicit actions if the agent supplied any, else a default walk). Return `{ story, runId, commands, diff (U12), verification, transcript }` — this value is `AuthorResult`-shaped (`ok` discriminant), so map the internal `{success}` dispatch/verify envelopes to `ok` **here**, the single `success→ok` conversion point (KTD-5). **Partial-run semantics (KTD-11):** every successfully-dispatched command is *already canonical* in the log; a run stopped by `maxSteps` or an unrecoverable error leaves its committed records in place — `runAgent` does **not** auto-roll-back. The caller keeps the run or calls `revertRun(runId)` (the single transaction boundary). The returned result must let a caller distinguish a completed run from a partial/aborted one so a surface can present keep-or-revert, never silently.
**Execution note:** Implement test-first against the scripted provider — the loop contract (one runId, append-on-success, stop conditions, verify) is the unit's whole value.
**Patterns to follow:** `packages/authoring/test/author.test.ts` (scripted provider harness), `packages/authoring/src/author.ts` (loop + transcript discipline).
**Test scenarios (scripted provider, hermetic):**
- A scripted tool-call sequence that adds a node + `append-say`/`append-choice` + rewires a goto produces a valid Story; `verification.validate.success` is true; `diff` reflects the new node.
- Every intermediate step keeps the Story Zod-valid (assert after each dispatch).
- `revertRun(result.runId)` returns the Story to its pre-run state (one undo of N).
- Loop stops at `maxSteps` and returns a **partial result that the committed records remain in the log** (no auto-rollback) and the result flags the run as not-completed, so a caller could keep or `revertRun` it.
- An invalid tool call mid-run returns issues fed back to the model; a subsequent corrected call succeeds (recovery).
- A `done` tool call ends the loop before `maxSteps`; `done` is absent from `world.describe()`.
- The returned result uses the `AuthorResult` `ok` discriminant — no internal `{success}` envelope leaks into it (the `success→ok` conversion point, KTD-5).
**Verification:** `pnpm test` green with no network; run result is deterministic for a fixed script.

### Phase C — surfaces + wiring

### U8. CLI — registry-derived world subcommands + `author run`

**Goal:** Expose the world API + agent run via the CLI (slice-1 surface).
**Requirements:** origin → slice-1 acceptance; parity.
**Dependencies:** U2, U3, U4, U10, U11, U12 (world subcommands use `world.describe()` + tasks from the world package directly — *not* U6's authoring-side adapter); U7 for `author run`, which transitively pulls U5, U6. So the full prerequisite set is U2–U4, U10–U12 (read/edit subcommands) and U5–U7 (the `author run` path).
**Files:** `packages/cli/package.json` (add `@ludelier/world` dep), `packages/cli/src/index.ts`, `packages/cli/test/` (smoke; new — CLI currently untested).
**Approach:** The current CLI is **not a `parseArgs` dispatcher** — it slices `process.argv` into a top-level `switch (cmd)`, each subcommand parsing its own args via `node:util` `parseArgs`, and `loadStory` calls `process.exit` on failure. **First refactor `index.ts` to an exported `run(argv): number`** (return an exit code instead of `process.exit`) so smoke tests can assert exit codes without killing the test process; the `bin` entry calls `run(process.argv.slice(2))`. Then add to the top-level switch: `world describe` (print manifest), `world query <task> --story s.json [--json '{...}']`, `world edit <cmd> --story s.json [--json '{...}'] [--log l.jsonl] [-o out.json]`, `world undo|redo --story ... --log ...`, plus log `export`/`import`. `author run "<prompt>" --story s.json --log l.jsonl` uses `providersFromEnv` (BYOK); if no key, return a non-zero code with a clear message (live LLM optional). The `world query`/`world edit` split derives from each task's `kind`; the subcommand list + help derive from `world.describe()`. **CLI surfaces `issues` as data** (printed) and returns codes — it must not silently `process.exit` past a world-task failure (reconcile the `loadStory` exit-on-error habit — SI envelope contract).
**Patterns to follow:** `packages/cli/src/index.ts` (current `switch (cmd)` + per-subcommand `parseArgs`, `loadStory`).
**Test scenarios:**
- `world describe` lists the registered tasks (count > 0).
- `world query graph` on cafe prints reachability JSON; `run(argv)` returns exit code 0.
- `world edit append-say ...` writes a new story file + appends a log record; re-loading validates.
- `world undo` after an edit restores the prior story.
- `author run` with no provider key returns a non-zero exit code with a clear BYOK message (asserted via `run(argv)`, no process kill).
- **Parity guard:** the CLI's world-subcommand set equals `world.describe()`'s task set (plus the fixed log/meta verbs `describe`/`undo`/`redo`/`export`/`import`) — drift fails the test (SI parity guardrail).
**Verification:** CLI smoke runs via the exported `run(argv)`, hermetic (no network); `just check` green.

### U9. Wiring, changesets, docs

**Goal:** Finalize workspace wiring + handoff docs.
**Requirements:** golden rules (changeset per change; docs current).
**Dependencies:** U1–U8, U10–U12.
**Files:** `tsconfig.json` (add `@ludelier/world` path), `.changeset/*.md` (world minor/new, authoring minor, cli minor), `AGENTS.md` (repo layout: add `world/`), `STATUS.md` (P2 progress), `docs/plans/2026-06-19-001-feat-world-api-agent-harness-plan.md` (mark units done as they land — optional).
**Approach:** Add the `@ludelier/world` alias to root `tsconfig.json` `paths` (manually maintained map — Bundler resolution + these aliases are how cross-package TS imports resolve with no build step). **`pnpm-workspace.yaml` needs no edit** — it globs `packages/*`, so the new package is auto-included; a `pnpm install` refreshes the lockfile. Add changesets; refresh the two docs. Note each of U1–U8 and U10–U12 individually ships its own changeset per golden rule 5 (this unit covers only the wiring/docs changeset).
**Test expectation:** none — config/docs; covered by `pnpm typecheck` + the other units' tests.
**Verification:** `just ci` green; `pnpm changeset:status` shows the pending bumps.

---

## System-wide impact

- **New workspace package** `@ludelier/world` → root `tsconfig.json` paths + lockfile; `cli` and `authoring` gain a dependency on it. (`pnpm-workspace.yaml` globs `packages/*` — no edit.)
- **`@ludelier/authoring` provider interface** gains optional fields — **additive, back-compat**; `generateStory` and existing tests unaffected (U5 covers this).
- **CLI** grows new subcommands; existing `validate|simulate|replay` unchanged. Requires refactoring the entrypoint to an exported `run(argv)` (U8) so it is testable.
- **Parity invariant (the property that makes CLI / agent / future UI one surface).** Every surface reaches the Story **only** by (a) enumerating tasks via `describe()` and (b) mutating only via `applyEdit`/the `EditLog` — no surface may carry a task, flag, or mutation path the registry doesn't know about. The design upholds this via the single `describe()` manifest + the single `applyEdit` chokepoint + the single `Result` envelope. **Named guardrails:** no surface enumerates tasks except via `describe()`; no surface mutates except via `applyEdit`/`EditLog.apply`; loop-control affordances like the `done` tool are explicitly *outside* the registry (U7); result/error rendering *presents* the same `Result` envelope, never re-derives it. **Guard test** (U8): the CLI's world-subcommand set equals `describe()`'s task set, so drift fails CI — directly serving the acceptance criterion "appears automatically in `describe()`, the CLI, and the agent's toolset."
- **The `Result`/`Issue` envelope is a new cross-surface contract.** It aligns on `@ludelier/schema`'s `{success}` shape (KTD-5) — deliberately *not* `authoring`'s pre-existing `{ok}`. The agent consumes it structurally (fed back into messages, U7) while CLI and the future UI render it for a human; all surfaces must **present** the same envelope, and the CLI's exit-on-error habit (`loadStory` `process.exit`) must be reconciled so world-task failures surface `issues` as data (U8).
- **Partial-run & transaction-boundary semantics (KTD-11).** A run stopped by `maxSteps` or an unrecoverable error leaves its committed records canonical in the log; `revert-run` is the *only* rollback and is sound only under the **serialized-runs (no-interleaving) invariant**. Surfaces must present a partial/aborted run as keep-or-revert, never silently. Concurrent human+agent editing (the deferred co-editing UI) is a flagged future hazard, **not** assumed solved by parity — it would break the contiguous-tail assumption `revert-run` relies on.
- **`describe()` manifest is the highest-fanout contract in the slice** — one source fans out to CLI help, the LLM toolset (U6), and the future UI. `kind` ("understand"|"manipulate") is **load-bearing routing metadata** (dispatch, CLI `query`/`edit` split, UI read/write affordances); a mis-tag is a silent log-bypass/parity bug. `z.toJSONSchema` fidelity is therefore a **parity** concern (CLI `--json` validation + UI forms + LLM tools must accept the same inputs), not just a tool-calling concern — addressed by flattening statement params to scalar commands (KTD-4/KTD-7).
- **Determinism surface widens (the edit log).** The replay is **end-to-end** (refold reproduces the canonical Story, compared via `hashStory`), *not* per-step-hashed like `engine.replayTrace` — so a mid-log divergence won't localize without the optional per-record story-hash (U4). New **dual order-stability** requirement: authored insertion order *and* engine sort order must both survive a refold (KTD-6).

---

## Risks & mitigations

- **Provider tool-calling API variance** (OpenAI vs OpenRouter). _Mitigation:_ slice 1 proves the loop with a scripted provider (KTD-9); live wiring is exercised by the same abstraction but deferred from the CI gate.
- **`simulate` branch explosion** if extended to all-paths. _Mitigation:_ slice 1 takes an explicit actions list only; bounded all-paths deferred (Scope).
- **Cross-ref breakage on delete/rewire.** _Mitigation:_ `applyEdit` re-validates every edit (KTD-3); U3 tests assert rejection + no-mutation.
- **Semantic gaps `validateStory` does not catch** (`say.who`, variables, sprite slots) — an edit can be "valid" yet semantically broken. _Mitigation:_ slice 1 adds a world-local `say.who` check (KTD-3, reachable via the `add-character`+`append-say` spine); variable/sprite coherence is an explicit deferred limitation (Scope → Deferred), not silently assumed covered.
- **Agent loop non-termination.** _Mitigation:_ `maxSteps` + explicit `done` tool kept outside the registry (U7).
- **Partial/aborted run left in the log.** _Mitigation:_ committed records persist by design; `revert-run` is the single rollback and the run result flags completed-vs-partial so a surface presents keep-or-revert (KTD-11, U7). Serialized-runs invariant keeps `revert-run`'s contiguous-tail assumption sound; concurrent co-editing is a flagged out-of-scope hazard.
- **`z.toJSONSchema` fidelity is a cross-surface (parity) risk, not just tool params.** The emitted schema drives the LLM toolset *and* CLI `--json` validation *and* future UI forms; the weak spot is the 10-arm statement `discriminatedUnion` + `.default()`s. _Mitigation:_ flatten statement-bearing commands to flat scalar params (KTD-4/KTD-7), sidestepping `oneOf` entirely; reuse the guarded path from `packages/schema/src/jsonSchema.ts` for the remaining flat objects.
- **Determinism flake on serialization rather than real divergence.** _Mitigation:_ compare/hash a **canonical** Story form (`hashStory`, KTD-6), not raw `JSON.stringify`; `apply` preserves both authored and engine-sort order.
- **Refold cost growth on long logs.** _Mitigation:_ accepted O(n)-per-call for slice-1 sizes; memoize-at-head / incremental-apply escape hatch with a measured trigger (KTD-2).

---

## Done = slice 1 acceptance (from origin)

A scripted agent run can, end-to-end and headlessly: add a branch to `examples/cafe.story.json`, keep the Story Zod-valid at every step, self-verify via `graph` + `simulate`, and produce a reviewable diff + a revertable run — all in CI with no live LLM. Adding a new capability requires only a new registry entry; it appears automatically in `describe()`, the CLI, and the agent's toolset.
