---
"@ludelier/schema": minor
"@ludelier/engine": minor
"@ludelier/world": minor
"@ludelier/authoring": patch
"@ludelier/editor-web": patch
---

Add the `branch` statement — state-driven conditional flow — and extend the demo to use it.

`branch` is a conditional jump: if its `cond` ({var,cmp,value}) holds it continues at `goto`, otherwise it falls through to the next statement. It is the missing control-flow primitive for basic visual novels — until now the only way to branch was a player `choice`, so computed state (accumulated trust, a dice roll) couldn't change the story by itself. Chain several `branch`es for if/elif/else. Unlike `jump` it is not terminal, so statements may follow it.

Wired end-to-end through the existing layers:
- **schema** — `BranchStatement` in the discriminated union; `validateStory` cross-refs `branch.goto` to a known node.
- **engine** — the reducer takes the goto when the condition holds (reusing the type-safe `compare`), else falls through; covered by the statement-budget / determinism guards like any jump.
- **world** — `graph` counts the branch goto as an edge (reachability + dead-end analysis see it), `find-references` and `rewire-goto` handle it, and the variable checks (`unwrittenVarReads` / `conditionTypeIssues`) now scan branch conditions too.
- **authoring / editor** — the author and agent prompts document `branch`, and the editor inspector summarizes it.

Demo (`examples/cafe.story.json`): the café story now uses `branch` for two state-driven outcomes — a luck-based "lucky" ending (the previously-dead `roll` of `luck` now matters) and a trust-based regret line on the leave path — adds `her` as a speaking character, and a new "Ask about her day" path. The opening frame and the existing play-through are unchanged (e2e green).
