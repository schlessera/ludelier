---
"@ludelier/authoring": minor
"@ludelier/cli": minor
---

Give the agent loop more room and clearer steering.

- `runAgent`'s default `maxSteps` is raised from 12 to 24 so a run has room for self-correction rounds (a live gpt-5-mini run hit the old cap while recovering).
- The agent system prompt now spells out the graph-health contract the `done` gate enforces: inspect first, make every new node reachable, give endings an `end`, never delete an existing `end` without replacing it, and verify with the `graph` tool before calling `done`.
- `cli author run` gains a `--max-steps <n>` flag (positive integer) to override the per-run cap.
