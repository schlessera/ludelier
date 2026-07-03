---
"@ludelier/editor-web": minor
---

Editor UX: per-run revert in History, play position survives edits, a crash boundary, and an opt-in remembered key.

- **Per-run revert.** The History panel now groups the edit log by run (chat runs, form edits, CLI-style manual runs) and offers Revert on the run that can actually be reverted — `revertRun` is defined only for a contiguous tail of the history, so exactly one group is actionable. The chat panel's revert stays, but is no longer the only (and no longer an ephemeral) path.
- **The play preview holds its position across edits.** The preview records its own ADVANCE/CHOOSE history and replays it against the edited story instead of restarting from the top on every change; the reducer's guards make stale actions harmless, and only an engine throw (an edit introduced a loop on the replayed path) falls back to a clean restart. Restart and play-from-here explicitly drop the history.
- **Error boundary.** A render crash anywhere in the editor tree now shows a recoverable "reload the editor" screen (with a your-story-is-safe note) instead of a white page.
- **Remember key (opt-in).** A labelled checkbox persists the BYOK OpenRouter key in localStorage — off by default, clearly marked as unencrypted, cleared by unticking.
- **Forms fix:** an optional object whose required enum was still at its pre-selected seed (e.g. a choice option's untouched `if` condition, `cmp` at "eq") no longer collects as an empty condition the world then rejects.
