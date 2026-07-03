---
date: 2026-06-22
topic: editor-story-map
---

# Editor Story Map — Requirements

## Summary

Add a **read-only flow-map** of a story's branching structure to the Ludelier editor: one box per node, a labeled directed edge for every `choice` / `jump` / `branch`, with the start node and any unreachable / dead-end nodes visually marked. Node positions are **computed automatically** (never hand-placed, never stored). Clicking a node opens a read-only, screenplay-style rendering of its statements, and starts the embedded preview playing from that node. All editing stays with the existing agent chat — the map adds comprehension and navigation, not a new mutation surface. This is the foundation for a later canvas where direct manipulation and agent-steering become co-equal.

---

## Problem Frame

The editor today (`packages/editor-web/src/App.tsx`) gives an author three things: an agent chat that performs structured edits, a live play preview, and a **text-list** node inspector. The list is the weak link — it shows node ids, badges, and a statement dump, but it cannot answer the question that actually matters for a branching visual novel: *what is the shape of this story, and where does it branch?* You can see that node `tab` exists and is a dead-end, but not that it is reachable only via the "Run a tab" choice when `gold > 5`, nor that its `branch` on `mood` sends some players to `sulk` while others fall through.

For an agent-native editor this gap compounds: the agent can rewrite large swaths of the graph in one chat run, and a flat list gives the human no way to *comprehend* what changed or to *steer* the next instruction ("the `careers` branch never rejoins the main path"). The branching structure is a graph; the author needs to see it as one.

---

## Key Decisions

- **Two-altitude editing surface.** A story is two graphs at different altitudes: the *macro* structure between nodes (a directed graph whose edges are `choice` / `jump` / `branch` gotos) and the *micro* content inside a node (`node.body`, an ordered statement list — a linear screenplay). The map serves the macro graph; a script view serves the micro content. Conflating them (writing dialogue inside graph nodes) is what makes node editors collapse into spaghetti — so they stay separate views.
- **Labeled-edge graph (Twine-like), not ports or preview-cards.** One box per node; choices/jumps/branches render as labeled directed edges. It is the leanest, most legible representation and maps 1:1 onto the data model. Articy-style exit ports and content-preview cards were considered; preview-cards are the natural fast-follow, ports are not planned.
- **Auto-layout only; positions never stored in the Story.** Node coordinates are a pure, re-computable function of the node/edge set, not author data. This keeps the Story as portable, deterministic narrative data (no x/y cruft), keeps the diagram legible as the agent rewrites the graph, and — by design — means later direct manipulation is *structural* (create/rewire), never "drag a box to a spot."
- **Read-only + agent-only edits for v1.** The map and script view are pure views; the only edit path remains the agent chat through the always-valid `applyEdit` chokepoint. This proves the comprehension/navigation loop with zero new mutation surface.
- **The script lens is a one-way pretty-printer, not a parser.** v1 renders statements → readable text; it never parses text back. There is no text DSL yet (JSON is canonical; an author DSL is deferred). The rendering is designed as the read-only half of the eventual round-trippable DSL, so phase 2 extends it rather than replacing it.

### How the views derive from one source of truth

```mermaid
flowchart TB
  chat[Agent chat] -->|only edit path| apply[applyEdit · always-valid]
  apply --> story[(Story / EditLog)]
  story --> graph[Graph analysis · reachable / dead-ends]
  story --> body[Per-node statements]
  graph --> map[Structure map · auto-layout · labeled edges · badges]
  body --> script[Script lens · read-only pretty-print]
  map -->|select node| script
  map -->|select node| play[Play-from-here preview]
```

---

## Requirements

### The structure map

- R1. The map renders one box per story node, labeled with the node id; the start node (`meta.start`) is visually distinguished.
- R2. The map draws a directed edge for every outgoing transition: each `choice` option (edge labeled with the option's label), each `jump`, and each `branch` (edge labeled with its condition, e.g. `gold > 5` and the target `goto`).
- R3. Conditional transitions — every `branch`, and any `choice` option carrying an `if` — are styled distinctly from unconditional ones (plain `choice` / `jump`), so conditional flow is legible at a glance.
- R4. Nodes the session reports as unreachable or as dead-ends carry a distinct badge/styling. These are read from the session snapshot's existing graph analysis; the map does not recompute reachability itself.

### Automatic layout

- R5. Node positions are computed automatically from the graph and are never written into the Story. Layout is a pure, re-computable function of the node/edge set.
- R6. v1 ships exactly one layout algorithm: a layered / top-down ("flowchart") layout suited to branching stories, handling merges and back-edges (cycles) gracefully. The layout is built behind a seam so alternate algorithms can be added later, but only one ships in v1.

### The node script lens

- R7. Clicking a node opens a read-only, screenplay-style rendering of that node's `body` — say / show / scene / set / choice / branch / jump / end and the rest — readable as a script, not as raw JSON.
- R8. The rendering is a one-way pretty-printer (statements → text); v1 does not parse text back into statements. The format is chosen to be the read-only half of the eventual editable DSL.
- R9. Each statement's stable id is surfaced unobtrusively in the rendering, so the author can reference exact statements when instructing the agent (e.g. "rewrite the second `say` in `cafe_intro`").

### Read-only, live, integrated

- R10. The entire surface is read-only: no creating, deleting, connecting, or repositioning by hand. All editing happens through the agent chat.
- R11. The map and script lens re-render on every session change — agent edits, undo, redo, revert-run — using the same change subscription the play preview already consumes. New nodes appear, edges rewire, and badges update without a manual refresh.
- R12. Selecting a node drives "play from here": the embedded preview starts playback from the selected node, reusing the existing renderer.
- R13. The map replaces the current text-list node inspector as the editor's primary structure view; the list-style node detail is superseded by the map plus the script lens.

---

## Key Flows

- F1. Comprehend and navigate
  - **Trigger:** Author opens a story in the editor.
  - **Steps:** The map renders the whole story with automatic layout → the author scans for `unreachable` / `dead-end` badges and follows labeled edges to understand the branching → clicks a node to read its script → the preview plays from that node.
  - **Covers:** R1, R2, R3, R4, R7, R12.

- F2. Watch the agent build, then read what it wrote
  - **Trigger:** Author sends a chat instruction that adds or rewires nodes.
  - **Steps:** Edits stream in; on each change the map re-lays-out and new nodes/edges appear (a newly-added-but-unwired node shows an `unreachable` badge) → the author clicks a new node to read the agent's script → instructs the agent again, referencing a statement by its surfaced id.
  - **Covers:** R9, R10, R11.

---

## Acceptance Examples

- AE1. Choice with a gated option
  - **Covers R2, R3.**
  - **Given** a node ending in a `choice` with options "Pay now" → `checkout` and "Run a tab" → `tab` (the latter carrying `if gold > 5`).
  - **When** the map renders the node.
  - **Then** two outgoing edges leave the node, labeled "Pay now" and "Run a tab"; the "Run a tab" edge is styled as conditional and shows its condition.

- AE2. Branch with fall-through
  - **Covers R2, R3.**
  - **Given** a node containing `branch` (`mood < 0` → `sulk`) followed by further statements ending in a `jump` to `recover`.
  - **When** the map renders the node.
  - **Then** there is a conditional edge to `sulk` and an unconditional edge (the fall-through `jump`) to `recover` — both outgoing transitions are visible.

- AE3. Agent adds an unwired node
  - **Covers R4, R10, R11.**
  - **Given** the author asks the agent to add a node that nothing yet routes to.
  - **When** the agent edit completes.
  - **Then** the new box appears on the re-laid-out map flagged `unreachable`, with no edges into it — without a manual refresh and without any hand-positioning step.

- AE4. Play from a selected node
  - **Covers R12.**
  - **Given** the story's start is `cafe_intro` and the author clicks `checkout`.
  - **When** the selection is made.
  - **Then** the embedded preview begins playback at `checkout`, not at `cafe_intro` (see the Dependencies note on initial state).

---

## Scope Boundaries

### Deferred for later (phase 2+)

- Direct manipulation: creating / deleting nodes, drawing and rewiring edges, and inline content editing — all phase 2, and all *structural* (never positioning).
- An **editable** script lens and the DSL parser / round-trip it requires.
- The storyboard lens and the dual switchable (script ↔ storyboard) per-node view.
- Multiple / selectable layout algorithms — the seam exists in v1, but only one algorithm ships.

### Outside this design's identity (not a deferral — a stance)

- Hand-positioning of nodes. Positions are permanently auto-computed; the editor will not offer free-form dragging of boxes to arbitrary coordinates, now or later.

---

## Dependencies / Assumptions

- Binds to `@ludelier/editor-core` `EditorSession` (`snapshot()` + the change subscription `App.tsx` already uses). Reuses the snapshot's existing graph analysis (`reachable` / `unreachable` / `deadEnds`) — no new reachability computation.
- "Play from here" (R12) reuses the embedded `@ludelier/renderer-pixi` preview (`packages/editor-web/src/PlayCanvas.tsx`), which today replays from `meta.start`. Starting at an arbitrary node likely needs a small addition to the play entry point.
- **Initial state for play-from-here is an open semantic point.** Beginning playback at an arbitrary node means upstream `set` / `add` / `roll` statements have not run, so variable state is not what a real playthrough reaching that node would have. v1 assumption: play-from-here starts with fresh/default state — adequate for previewing a node's *presentation* (background, sprites, dialogue), but conditional `branch` / `choice if` outcomes downstream will not reflect a true path. Whether to do anything smarter is deferred to planning.
- The layout approach/library (e.g. a layered DAG layout) is chosen during planning, not pinned here. R6 only fixes the *kind* of layout and the single-algorithm-at-v1 scope.
- v1 author persona is technically fluent (the maintainer); non-coding writers are a later audience the agent helps bridge — so the surface can expose power (ids, script text) rather than hide everything.
- Assumes story sizes where a layered layout stays legible (tens of nodes). Very large graphs (hundreds of nodes, pan/zoom/minimap ergonomics) are not a v1 concern.

---

## Outstanding Questions

### Deferred to planning

- Does the runtime/renderer already support starting playback at an arbitrary node, or is a new entry point needed (R12)? Resolve while exploring `packages/renderer-pixi` and the runtime-web play path.
- Exact treatment of play-from-here initial state (fresh vs. attempt to reconstruct a representative upstream state) — see the Dependencies note.
- Layout library / algorithm selection and the shape of the seam that keeps alternates addable (R6).
