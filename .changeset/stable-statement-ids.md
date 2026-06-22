---
"@ludelier/schema": minor
"@ludelier/world": minor
"@ludelier/authoring": patch
"@ludelier/editor-web": patch
---

Stable statement ids: target statement edits by identity, not by a fragile position.

The agent kept miscounting statement positions — e.g. asked to replace a node's first line, it removed the wrong statement (a choice instead of the stale say) and left the old line behind, yet the run still verified "clean" (graph health was unaffected). Index-based targeting is the root cause.

- **schema**: every statement gains an optional stable `id`. Optional, so authored/legacy stories stay valid; the world fills any gaps.
- **world**: `normalizeStatementIds` assigns positional ids (`"<nodeId>#<i>"`) when a story is loaded into the `EditLog`; statement-creating commands get a monotonic `"s<seq>"` baked into their edit record, so a refold reproduces ids deterministically (collision-safe across remove+append — the determinism invariant holds, and `hashStory` now covers ids). `remove-statement` and `rewire-goto` now take a **`statementId`** (the old `index` param is gone); `get-node` surfaces the ids.
- **authoring**: the agent system prompt instructs targeting existing statements by their `id` from `get-node`.
- **editor-web**: the node inspector shows each statement's id, and the chat feed shows the targeted `statementId`.

Verified live: asked to remove one statement from a node, the agent now removes exactly the right one by id; the others keep their ids.
