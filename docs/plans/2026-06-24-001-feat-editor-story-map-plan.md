---
title: "feat: Read-only story map view for the editor"
type: feat
status: completed
date: 2026-06-24
origin: docs/brainstorms/2026-06-22-editor-story-map-requirements.md
---

# feat: Read-only story map view for the editor

## Summary

Add a read-only flow-map of the story's branching structure to `@ludelier/editor-web`: auto-laid-out node boxes, labeled directed edges for every `choice` / `jump` / `branch` (conditional edges styled distinctly), and start / unreachable / dead-end markers. Clicking a node opens a read-only screenplay-style rendering of its statements and plays the embedded preview from that node. The work lands across three packages — a pure labeled-edge derivation in `@ludelier/world`, a small arbitrary-start entry point in `@ludelier/engine`, and the map + script-lens view in `editor-web` replacing the current text-list inspector — with editing staying agent-only.

---

## Problem Frame

The editor today (`packages/editor-web/src/App.tsx`) gives an author an agent chat, a live play preview, and a flat text-list node inspector (`StoryInspector`). The list shows node ids, badges, and a statement dump, but cannot answer the question that matters for a branching visual novel: *what is the shape of this story, and where does it branch?* For an agent-native editor the gap compounds — the agent can rewrite large swaths of the graph in one chat run, and a flat list gives the human no way to comprehend the result or steer the next instruction. The branching structure is a graph; the author needs to see it as one. See `origin: docs/brainstorms/2026-06-22-editor-story-map-requirements.md` for the full motivation and the two-altitude (macro map / micro script) framing.

---

## Key Technical Decisions

- KTD1. Graph stack: React Flow (`@xyflow/react`) for rendering + `@dagrejs/dagre` for layout, both MIT. React Flow gives read-only mode via props, React-native nodes (badges as JSX), custom edge labels and styling, and pan/zoom — and a clean additive path to the phase-2 interactive canvas. dagre supplies layered (Sugiyama) top-down layout with cycle-breaking, adequate for VN graphs of tens-to-hundreds of nodes. `elkjs` was rejected despite higher layout quality: it is EPL-2.0, which is awkward to bundle in an MIT open-core product. The layout call sits behind a single adapter function so an alternate engine can replace it later (R6).
- KTD2. Labeled-edge derivation is a new pure function in `@ludelier/world`, exposed both as a direct import and as a registered `understand` task (agent-native parity — the agent can query the same labeled edges the human sees). It does NOT mutate the existing `GraphReport.edges` shape (`packages/world/src/understand/graph.ts`), which existing consumers and tests depend on; `GraphReport.edges` is bare `{from,to}`, so the labeled/typed/conditional edges R2/R3 need are derived separately by walking `node.body`. Research confirmed the static derivation (`jump`/`branch`/`choice` gotos) matches runtime transitions 1:1 (`packages/engine/src/reducer.ts`), so the map's edges reflect real execution.
- KTD3. Play-from-here adds an optional start-node parameter to `initialState` / `Simulation` (`packages/engine/src/reducer.ts`, `packages/engine/src/simulation.ts`), defaulting to `meta.start` so existing callers are unaffected. v1 starts at the selected node with fresh default variable state (`vars: {}`) — adequate for previewing presentation (background, sprites, dialogue) but downstream `branch` / `choice if` outcomes will not reflect a true upstream path. This is an accepted v1 semantic (see origin Dependencies note), not a defect; reconstructing upstream state is deferred. The PixiJS renderer is start-agnostic and needs no change.
- KTD4. Layout is never persisted to the Story (R5). Positions are computed each render from a stable-id-sorted node/edge set, keeping the Story coordinate-free portable data and the layout deterministic and re-computable. This follows the existing stable-id-sort discipline in `@ludelier/world` (`compareStr` / `byId`).
- KTD5. The map replaces `StoryInspector` as the editor's primary structure view (R13). Node selection — currently local `useState` inside `StoryInspector` — is lifted so one selection drives both the script lens and play-from-here. The map re-renders via the existing `useSessionVersion` + `EditorSession.subscribe` mechanism (R11); no new reactivity mechanism is introduced.

---

## High-Level Technical Design

Three layers, one source of truth (`EditorSession` → `Story` + `GraphReport`). Pure logic (edge derivation, engine start, layout) stays headless-testable; React renders.

```mermaid
flowchart TB
  session["EditorSession.snapshot()"] --> story["story (nodes + body)"]
  session --> graph["graph: reachable / unreachable / deadEnds"]

  story --> derive["deriveFlowEdges(story) - @ludelier/world (pure)"]
  derive --> labeled["labeled/typed/conditional edges"]

  labeled --> layoutfn["layout adapter - dagre layered TB (editor-web, pure)"]
  graph --> map["StoryMap - React Flow (read-only)"]
  layoutfn --> map

  story --> lens["Script lens - read-only pretty-print"]
  map -->|select node| lens
  map -->|select node| play["PlayCanvas startNode -> Simulation(story, {seed, start})"]

  chat["Agent chat (only edit path)"] -->|applyEdit| session
  session -.->|subscribe / version bump| map
```

Play-from-here data flow: a node click sets the lifted `selected` id → `PlayCanvas` receives it as `startNode` → `new Simulation(story, { seed, start: selected })` builds a `GameState` whose `cursor.node` is the selection with fresh `vars` → existing `resolve`/renderer path draws it unchanged.

---

## Requirements

Carried from `origin: docs/brainstorms/2026-06-22-editor-story-map-requirements.md`.

### The structure map

- R1. One box per story node, labeled with the node id; the start node (`meta.start`) is visually distinguished.
- R2. A directed edge for every outgoing transition: each `choice` option (labeled with the option label), each `jump`, and each `branch` (labeled with its condition and target).
- R3. Conditional transitions — every `branch`, and any `choice` option carrying an `if` — are styled distinctly from unconditional ones.
- R4. Nodes reported unreachable or dead-end carry a distinct badge, read from the session snapshot's graph analysis (not recomputed).

### Automatic layout

- R5. Node positions are computed automatically and never written into the Story; layout is a pure, re-computable function of the node/edge set.
- R6. v1 ships exactly one layout algorithm (layered / top-down, cycle-tolerant) behind a seam that allows adding alternates later.

### The node script lens

- R7. Clicking a node opens a read-only, screenplay-style rendering of its `body`, readable as a script rather than raw JSON.
- R8. The rendering is a one-way pretty-printer; v1 does not parse text back into statements.
- R9. Each statement's stable id is surfaced unobtrusively so the author can reference exact statements when instructing the agent.

### Read-only, live, integrated

- R10. The entire surface is read-only; all editing happens through the agent chat.
- R11. The map and script lens re-render on every session change (edit / undo / redo / revert-run) via the existing change subscription.
- R12. Selecting a node plays the embedded preview from that node.
- R13. The map replaces the current text-list node inspector as the primary structure view.

---

## Acceptance Examples

Carried from origin; enforced by the test scenarios noted under each unit.

- AE1. Choice with a gated option — a node ending in a `choice` with "Pay now" → `checkout` and "Run a tab" → `tab` (the latter `if gold > 5`) renders two outgoing edges; the gated one is styled conditional and shows its condition. (Covered by U1, U4.)
- AE2. Branch with fall-through — a node with `branch` (`mood < 0` → `sulk`) then a `jump` to `recover` renders both a conditional edge to `sulk` and an unconditional edge to `recover`. (Covered by U1, U4.)
- AE3. Agent adds an unwired node — a newly added node nothing routes to appears on the re-laid-out map flagged unreachable, with no incoming edges, without manual refresh. (Covered by U1, U4, U6.)
- AE4. Play from a selected node — with start `cafe_intro`, clicking `checkout` begins playback at `checkout`, not `cafe_intro`. (Covered by U2, U6.)

---

## Implementation Units

### U1. Pure labeled-edge derivation in `@ludelier/world`

- Goal: derive the labeled, typed, conditional edge set the map needs from a `Story`, since `GraphReport.edges` is unlabeled `{from,to}`.
- Requirements: R2, R3.
- Dependencies: none.
- Files:
  - `packages/world/src/understand/flow-edges.ts` (new) — `deriveFlowEdges(story): FlowEdge[]` plus a `FlowEdge` type `{ from, to, kind: "choice" | "jump" | "branch", label?, conditional: boolean, statementId? }`.
  - `packages/world/src/understand/flow-edges.test.ts` (new).
  - `packages/world/src/index.ts` — export the function/type and register a `flow-edges` understand task (params `{}`, returns `FlowEdge[]`) in the registry alongside the existing `graph` task.
- Approach: for each node (id-sorted), walk `body` in order; emit one edge per `jump` (kind `jump`, unconditional), per `branch` (kind `branch`, conditional, label from `cond` as `var cmp value`, `to = goto`), and per `choice` option (kind `choice`, label from option `label`, `conditional = !!option.if`, `to = goto`). Preserve `body` order within a node; sort nodes by id for determinism. Do not dedupe distinct options that share a target (each is a real, separately-labeled edge). Leave `GraphReport` untouched (KTD2).
- Patterns to follow: the `understand` task shape and registration in `packages/world/src/understand/graph.ts` + `packages/world/src/index.ts`; stable-id sorting via the existing `compareStr` / sort helpers (`packages/world/src/sort.ts`).
- Test scenarios:
  - Covers AE1. A `choice` with two options, one carrying `if gold > 5`, yields two edges with the right labels; only the gated one has `conditional: true`.
  - Covers AE2. A node with `branch (mood < 0 → sulk)` then `jump → recover` yields a conditional `branch` edge to `sulk` and an unconditional `jump` edge to `recover`.
  - A `choice` option without `if` is `conditional: false`.
  - Two options pointing at the same target produce two distinct edges (not deduped).
  - A node whose body has no `jump`/`branch`/`choice` produces no outgoing edges.
  - Determinism: the same story produces a byte-identical edge list across runs (id-sorted).
  - The registered `flow-edges` task returns the same result through the registry as the direct import.
- Verification: `flow-edges.test.ts` green; `just check` green; ship a changeset for `@ludelier/world`.

### U2. Arbitrary-start entry point in `@ludelier/engine`

- Goal: let a `Simulation` (and `initialState`) begin at a chosen node, for play-from-here.
- Requirements: R12.
- Dependencies: none.
- Files:
  - `packages/engine/src/reducer.ts` — add optional `start?: string` to `initialState`, defaulting to `story.meta.start`; build `cursor: { node: start, index: 0 }`.
  - `packages/engine/src/simulation.ts` — thread an optional `start` through the `Simulation` constructor opts (`{ seed?, start? }`) into `initialState`.
  - `packages/engine/src/*.test.ts` — extend the simulation/reducer tests (or add `start-node.test.ts`).
- Approach: additive, backward-compatible signature change. Keep `vars: {}` fresh (v1 semantic, KTD3). Guard an unknown `start` id (treat as a caller error / fall back is not silent — surface clearly), though the UI only ever passes ids that exist in `story.nodes`. No `Math.random`; determinism preserved.
- Patterns to follow: existing `initialState` / `Simulation` construction (`packages/engine/src/reducer.ts:159`, `packages/engine/src/simulation.ts:25`); hashing/determinism conventions in `packages/engine/src/hash.ts`.
- Test scenarios:
  - Covers AE4. `initialState(story, { start: "checkout" })` produces a state whose cursor resolves into `checkout`'s body, not `meta.start`.
  - Regression: omitting `start` reproduces today's behavior exactly (cursor at `meta.start`).
  - Determinism: same `story + seed + start + actions` ⇒ identical hash across runs.
  - Fresh-state caveat: starting at a node whose downstream `branch` reads a variable not yet set takes the fall-through path (documents that upstream state is not reconstructed).
  - Unknown start id is reported as an error rather than silently starting elsewhere.
- Verification: engine tests green; `just check` green; ship a changeset for `@ludelier/engine`.

### U3. Graph dependencies + dagre layout adapter in `editor-web`

- Goal: add the rendering/layout dependencies and a pure layout adapter that turns nodes + derived edges into positioned nodes.
- Requirements: R5, R6.
- Dependencies: U1.
- Files:
  - `packages/editor-web/package.json` — add `@xyflow/react` and `@dagrejs/dagre` (workspace install).
  - `packages/editor-web/src/storymap/layout.ts` (new) — `layoutGraph(nodes, edges): PositionedNode[]` wrapping dagre (layered, top-down), id-sorted input for determinism.
  - `packages/editor-web/src/storymap/layout.test.ts` (new) — dagre runs in Node, so the adapter is Vitest-testable.
- Approach: feed dagre a graph built from id-sorted nodes and `deriveFlowEdges` output; read back `{x,y}` per node; return positions only (never persisted — KTD4). Keep dagre behind this one function so an alternate engine is a drop-in (R6 seam). Configure top-down rank direction; reasonable node-size constants.
- Patterns to follow: stable-id-sort discipline (mirror `@ludelier/world`); editor-web's TS strict + `noUncheckedIndexedAccess` config.
- Test scenarios:
  - Every input node gets exactly one position.
  - A graph with a cycle (back-edge) lays out without throwing.
  - An isolated node (no edges) still receives a position.
  - Determinism: identical input yields identical positions across runs.
- Verification: `layout.test.ts` green; `just check` green (deps install, typecheck passes).

### U4. `StoryMap` component (read-only React Flow render)

- Goal: render the map — node boxes with badges, labeled and conditional-styled edges — from `snap` + derived edges + layout.
- Requirements: R1, R2, R3, R4, R10.
- Dependencies: U1, U3.
- Files:
  - `packages/editor-web/src/storymap/StoryMap.tsx` (new) — consumes `snap.story`, `snap.graph` (reachable/unreachable/deadEnds), `deriveFlowEdges`, `layoutGraph`.
  - `packages/editor-web/src/storymap/StoryNode.tsx` (new) — custom React Flow node with id label + start / unreachable / dead-end badges.
  - `packages/editor-web/src/styles.css` — map + node + edge + badge classes (extend existing hand-written CSS; reuse `.tag` / `.tag.bad` idiom and theme custom properties).
- Approach: build React Flow `nodes` from positioned nodes (custom node type rendering badges from `snap.graph` sets and `meta.start`); build React Flow `edges` from `deriveFlowEdges` with `label` set and a conditional class/`style` + distinct marker for `conditional` edges (R3). Read-only props: `nodesDraggable={false}`, `nodesConnectable={false}`, `fitView`, pan/zoom on. `elementsSelectable` on to support selection in U6. No game logic; pure view.
- Patterns to follow: React Flow read-only + custom-node examples; the existing badge rendering in `StoryInspector` (`App.tsx:277-291`) for badge semantics.
- Test scenarios:
  - Covers AE1, AE2. Given a story exercising a gated choice and a branch+fall-through, the rendered edge set (node/edge model handed to React Flow) contains the expected labeled edges with correct `conditional` flags. (Assert on the derived model the component builds, not pixels.)
  - Covers AE3. A node in `snap.graph.unreachable` renders with the unreachable badge; a dead-end node renders the dead-end badge; the start node renders the start marker.
  - A node with no outgoing edges renders with no outgoing connectors.
- Verification: typecheck + build green; manual check renders the café story map with correct badges and conditional edges; `just check` green.

### U5. Read-only script lens

- Goal: render a selected node's `body` as a readable screenplay, surfacing statement ids.
- Requirements: R7, R8, R9.
- Dependencies: none (consumes `Story` data; wired in U6).
- Files:
  - `packages/editor-web/src/storymap/ScriptLens.tsx` (new) — given a `StoryNode`, render each statement as a script line.
  - `packages/editor-web/src/storymap/script.ts` (new) — pure `renderStatement(stmt): string` (one-way pretty-printer), expanded from the existing `summarize()`.
  - `packages/editor-web/src/storymap/script.test.ts` (new).
- Approach: expand the existing `summarize()` (`App.tsx:355-366`) into a fuller, readable rendering covering all statement ops (say with speaker, scene/show/hide staging, set/add/roll, choice with options + conditions, branch, jump, end). Pure string/structure output — no parsing back (R8). Surface each statement's stable id unobtrusively (R9). Designed as the read-only half of an eventual round-trippable DSL.
- Patterns to follow: the current `summarize()` switch; statement shapes in `packages/schema/src/story.ts`.
- Test scenarios:
  - Each statement op renders a readable, distinct line (say shows speaker + text; choice shows options + any conditions; branch shows condition + target; scene/show/hide show staging).
  - The statement id is present in the rendered output.
  - Pure and deterministic: same node → same rendering.
- Verification: `script.test.ts` green; manual check the lens reads like a script; `just check` green.

### U6. Wire the map into the editor (replace inspector; selection → lens + play-from-here)

- Goal: replace `StoryInspector` with the map + script lens, lift selection, and play the preview from the selected node.
- Requirements: R11, R12, R13.
- Dependencies: U2, U4, U5.
- Files:
  - `packages/editor-web/src/App.tsx` — replace `StoryInspector` in the center column with `StoryMap` + `ScriptLens`; lift `selected` node id to where it can drive both the lens and `PlayCanvas`; keep `useSessionVersion` as the reactivity source (R11).
  - `packages/editor-web/src/PlayCanvas.tsx` — accept an optional `startNode` prop; pass it into `new Simulation(story, { seed, start })`; replay from it on change. Preserve the StrictMode-safe lifecycle (disposed flag, `mountedRef`, deferred destroy, `loadedAssetIds` guard) exactly.
  - `packages/editor-web/src/styles.css` — center-column layout for map + lens.
  - `.changeset/*.md` — changeset(s) for the editor-web feature (and confirm engine/world changesets from U1/U2 exist).
- Approach: selection becomes shared state in `App` (or the center column), set by clicking a map node; the script lens renders the selected node, and `PlayCanvas` receives `startNode={selected}` so the preview plays from there (R12, AE4). On `version` bump the map, lens, and preview all re-derive from the new snapshot (R11). Default `startNode` to `meta.start` when nothing is selected (current behavior). Map stays read-only; selection is not a mutation, so the `busy` lock is irrelevant, but do not add any mutating control here.
- Patterns to follow: `useSessionVersion` + `snapshot()` (`App.tsx:12-25`); `PlayCanvas.rebuild()` and its StrictMode lifecycle (`PlayCanvas.tsx`).
- Execution note: when adding the `startNode` re-mount path to `PlayCanvas`, verify the StrictMode mount/unmount probe still tears down cleanly — this was a previously-solved landmine.
- Test scenarios:
  - Covers AE3. After a `create-node` edit through the session, a re-render shows the new node on the map flagged unreachable (end-to-end of the reactive path).
  - Covers AE4. Selecting `checkout` sets `startNode` and the preview rebuilds from `checkout`.
  - Selecting a node renders its script in the lens; changing selection updates both lens and preview.
  - Undo/redo/revert re-render the map, lens, and preview from the updated story.
- Verification: `just check` green; manual: click around the café map, read nodes, play from a mid-graph node, run an agent chat and watch the map re-lay-out; changeset(s) present for all touched packages; `just ci` (Playwright) still green.

---

## Scope Boundaries

### Deferred for later (phase 2+)

- Direct manipulation: creating / deleting nodes, drawing and rewiring edges, inline content editing — all structural (never positioning).
- An editable script lens and the DSL parser / round-trip it requires.
- The storyboard lens and the dual switchable (script ↔ storyboard) per-node view.
- Multiple / selectable layout algorithms — the adapter seam exists (U3/R6), but only one algorithm ships.

### Outside this design's identity

- Hand-positioning of nodes. Positions are permanently auto-computed; no free-form dragging of boxes to arbitrary coordinates, now or later.

### Deferred to Follow-Up Work

- A Playwright smoke test for `editor-web` (already a separate roadmap item in `STATUS.md`). The map's pure logic — edge derivation (U1), layout (U3), script rendering (U5), engine start (U2) — is covered by Vitest here; the React view is verified by typecheck/build + manual in this plan. If folded in later, use `just e2e` (WSL2 loopback fix) with Linux-tagged visual baselines.
- Reconstructing representative upstream variable state for play-from-here (v1 uses fresh default state, KTD3).

---

## Risks & Dependencies

- New dependencies in `editor-web` (`@xyflow/react`, `@dagrejs/dagre`). Both MIT (license-clean for the open-core engine). `@dagrejs/dagre` is the actively-maintained TypeScript fork of the dormant `dagre`; pin a current version. Bundle impact is on the editor app only (not the engine/runtime), acceptable.
- `elkjs` deliberately not used (EPL-2.0). If dagre's edge routing proves inadequate on dense back-edge graphs, the runner-up is elkjs loaded async/in a worker (not bundled) — a phase-2 consideration requiring license sign-off, explicitly out of scope here.
- StrictMode Pixi lifecycle: the `PlayCanvas` `startNode` change touches the renderer mount path; the existing disposed-flag / `mountedRef` / deferred-destroy pattern must be preserved (U6 execution note).
- Play-from-here fresh-state semantic (KTD3) is a known, documented v1 limitation, not a bug.

---

## System-Wide Impact

- `@ludelier/engine`: additive, backward-compatible API change (optional `start`); same-story-same-seed determinism preserved. All existing callers (runtime-web, editor PlayCanvas) keep working unchanged.
- `@ludelier/world`: gains one pure function + one registered understand task; existing `GraphReport` untouched, so no consumer churn. Agent-native parity preserved (the new edges are queryable via the registry/CLI like other understand tasks).
- `@ludelier/editor-web`: the structure-view surface is replaced; reactivity uses the existing subscription. No change to the agent chat, edit log, or any mutation path.

---

## Sources / Research

- Origin requirements: `docs/brainstorms/2026-06-22-editor-story-map-requirements.md`.
- Seam facts (verified): `EditorSnapshot` / `GraphReport` shape — `packages/editor-core/src/index.ts`, `packages/world/src/understand/graph.ts`; runtime transition semantics — `packages/engine/src/reducer.ts`; hardcoded start — `packages/engine/src/reducer.ts` `initialState`, `packages/engine/src/simulation.ts`; reactive binding — `packages/editor-web/src/App.tsx` `useSessionVersion`; StrictMode Pixi lifecycle — `packages/editor-web/src/PlayCanvas.tsx`; existing pretty-printer — `App.tsx` `summarize()`.
- Library landscape: React Flow (`@xyflow/react`, MIT) + `@dagrejs/dagre` (MIT) recommended for read-only auto-layout with cycles, edge labels, and an interactivity-upgrade path; `elkjs` flagged EPL-2.0; `d3-dag` rejected (DAG-only); `mermaid` rejected (no per-node React composition). React Flow does not auto-layout itself — dagre supplies positions.
- Determinism / changeset golden rules apply (`AGENTS.md`); layout stays coordinate-free and stable-id-sorted.
