---
"@ludelier/engine": minor
---

Allow a `Simulation` (and `initialState`) to begin at a chosen node — the editor's "play from here".

`initialState` gains an optional third argument `start`, and `Simulation`'s options gain `start?`, both defaulting to `story.meta.start` so every existing caller is unchanged. Playback begins at the given node with fresh default variable state (upstream `set`/`add`/`roll` have not run), which is adequate for previewing a node's presentation but means downstream `branch` / gated `choice` outcomes reflect defaults rather than a real path to that node. An unknown start node surfaces as a "node not found" error, never a silent fallback. Determinism is preserved: same story + seed + start + actions ⇒ identical hash.
