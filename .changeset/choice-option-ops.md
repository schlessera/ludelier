---
"@ludelier/world": minor
"@ludelier/authoring": patch
---

Add choice-option manipulate tasks — edit a choice's options in place, by index.

Until now, changing one option of a `choice` meant rebuilding the whole statement (remove-statement + add-statement, or the editor form's raw-JSON options field). Three new registry tasks target the choice by its stable statement id and one option by 0-based index (the same convention `rewire-goto` uses):

- `add-choice-option {nodeId, statementId, option, beforeIndex?}` — append, or insert at `beforeIndex`.
- `update-choice-option {nodeId, statementId, index, option}` — replace one option in place.
- `remove-choice-option {nodeId, statementId, index}` — remove one; refuses to remove the LAST remaining option (an option-less choice strands the player — no CHOOSE can advance, explore reports the node as stuck) with a clear issue instead of a generic re-validation error.

`option` reuses the schema's `ChoiceOption` ({label, goto, if?}), so an option's `goto` is cross-ref-checked by the always-valid `applyEdit` like every other edit. Because the tasks are registered in the shared registry, the `describe()` manifest (21 → 24 tasks) carries them to the CLI, the LLM toolset, the MCP server, and the editor's manifest-driven forms with zero further code — and the option's nested shape derives as a real form (label/goto/if fields), not a raw-JSON fallback. The agent system prompt teaches the ops so the model edits options by index instead of rewriting the whole choice.
