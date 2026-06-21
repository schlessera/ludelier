---
"@ludelier/editor-web": minor
---

New `@ludelier/editor-web` package: the React editor shell (slice 1).

A Vite + React app — a thin view bound to `@ludelier/editor-core`'s `EditorSession` — that makes the agent-native editor visible:

- **Agent chat** panel (BYOK OpenRouter key + model slug) that runs `session.chat(...)`, then shows the run's edits, clean/completed status, any unreachable/dead-end problems, and a **Revert this run** button.
- **Story inspector** — node list with start / unreachable / dead-end badges; click a node to see its statements.
- **Graph health + history** — validity, reachability counts, unreachable/dead-end lists, the edit-log records, and a copy-edit-log (JSONL) action.
- **Toolbar** — validity badge, undo/redo (gated on `canUndo`/`canRedo`), and add-node — demonstrating that manual edits and agent edits share one undoable history.

Verified live: builds (tsc + vite), renders in a headless browser, and the reactive binding (`subscribe` → re-render) updates inspector + graph health on selection and edits. The build is wired into `just build` / `just check`.
