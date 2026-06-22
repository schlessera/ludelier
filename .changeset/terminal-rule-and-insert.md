---
"@ludelier/schema": minor
"@ludelier/world": minor
"@ludelier/authoring": patch
---

Reject dead code after a terminal statement, and add `insert-*` to add content before a statement.

Asked to add sentences to an ending node, the agent appended them — but the node already ended with `end`, so the new lines landed *after* it (dead code that never plays). `validateStory` accepted it (statement order wasn't checked) and the run verified "clean".

- **schema**: a node's terminal statement (`end` / `jump`) must be its last — `validateStory` now flags any statement that follows one. This makes the always-valid `applyEdit` gate reject an append-after-terminal, so the agent self-corrects in-loop.
- **world**: new `insert-say` / `insert-show` / `insert-choice` commands insert a statement **before** an existing one (target it by `beforeStatementId`, using the stable ids from `get-node`). Terminal kinds have no insert variant — inserting one mid-node would orphan the rest (now invalid); append a terminal at the end instead.
- **authoring**: the agent prompt explains that `append-*` adds at the end (so a terminal must already be last) and to use `insert-*` to add before an existing statement.

Verified live: "add a few closing sentences to the ending node" now inserts them before the `end` (all dialogue plays, then the story ends), valid and clean.
