---
"@ludelier/editor-web": minor
"@ludelier/editor-core": minor
---

Parity payoff: manifest-driven human edit forms + story open/save/new/import in the editor.

Until now the only manual edits were add-node and undo/redo — everything else needed the
agent chat, undercutting the repo's core "agent-native parity" claim in the human direction.
Two features close that gap (repo review §3):

- **Manifest-driven edit forms.** A pure derivation layer (`editor-web/src/forms/model.ts`)
  turns each manipulate task's `describe()` JSON Schema into a form-field model — objects,
  string/number/boolean/enum fields, nested objects, scalar (VarValue) inputs, and `oneOf`
  unions discriminated on `op` (the statement union renders as an op selector driving the
  variant's fields). Anything unsupported (e.g. `choice.options` arrays) degrades to a
  raw-JSON textarea — never a dead end. A generic `<TaskForm>` renders the model and submits
  through `EditorSession.edit()` — the same always-valid chokepoint the agent uses, so form
  edits are undoable and `{success:false}` issues (including the new choice-is-terminal rule)
  render inline as path + message. A future manipulate task gets a working human form with
  zero editor code.
- **Context-aware entry points.** The script lens grows per-statement *edit* (update-statement
  prefilled with the statement's current value + id) and *delete* (remove-statement) buttons
  plus an *add statement* form on the selected node; the side panel lists every manipulate
  task as a collapsible form (set-meta prefilled from live meta).
- **Story open / save / new / log import.** Toolbar: *Open* (`.story.json` → parse +
  `validateStory`; an invalid file reports its issues and keeps the current session), *Save*
  (pretty-printed download named `<meta.id>.story.json`), *New* (minimal valid scaffold —
  start node with a say + end + narrator). Side panel: *Import log* replays an exported
  `.log.jsonl` onto the current session's base story via `EditorSession.fromLog`. Sessions
  swap at runtime; the play preview remounts per swap, surfaces missing-asset preloads as its
  inline error, and now detects cross-story asset-id collisions (same id, different src)
  instead of silently rendering the previous story's texture.
- **editor-core:** new `EditorSession.baseStory` getter — the (id-normalized) story that
  `exportLog()` JSONL replays on, so a UI can pair the two for import.
