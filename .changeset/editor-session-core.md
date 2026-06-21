---
"@ludelier/editor-core": minor
"@ludelier/world": minor
"@ludelier/authoring": minor
---

New `@ludelier/editor-core` package: the editor's headless session façade.

`EditorSession` is the single parity surface a human UI and the agent both drive (AGENTS.md: anything a human can do in the editor, the agent can do through the same tasks). It owns the current `Story` as an event-sourced `EditLog`, routes reads to the world's understand tasks (`query`) and writes to the manipulate tasks (`edit`) through the always-valid `applyEdit` chokepoint, exposes `undo`/`redo`/`revertRun` + `canUndo`/`canRedo`, emits `change` events for a view to re-render, round-trips through `exportLog`/`fromLog`, and runs the agent `chat` loop **on the session's own log** so generated edits join the same undoable history. Pure — no DOM/React/network of its own (the LLM provider is injected); tested in Vitest without a browser. The React editor shell will be a thin view bound to it.

Supporting changes:
- `@ludelier/world`: `EditLog` gains `canUndo()` / `canRedo()`.
- `@ludelier/authoring`: `runAgent` accepts an existing `log` to append the run onto (and measures its baseline/diff against that log's current story), so a session's chat edits integrate with its history.
