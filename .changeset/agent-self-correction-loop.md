---
"@ludelier/authoring": minor
"@ludelier/cli": patch
---

Close the agent self-correction loop: feed graph self-verification back into `runAgent`.

- `runAgent` now treats the `done` tool as a verification gate. When the model signals completion, the run is re-checked against a pre-run baseline; if the edits introduced any **new** unreachable or dead-end nodes (or invalidity), those problems are returned as `done` issues (or a feedback message when the model stops calling tools) so the model self-corrects, and the loop keeps going. Comparing against a baseline keeps the agent focused on its own edits — it is never asked to fix problems that already existed in the story it was handed.
- `AgentRunResult.ok` now means **clean** (Zod-valid *and* no new unreachable / dead-end nodes), not merely Zod-valid; `completed` is true only when the agent verified a clean run. This stops the loop from silently shipping a valid-but-broken story (e.g. a disconnected node, or a regression that deletes an existing `end`).
- `cli author run` surfaces `ok` and any unreachable / dead-end nodes in its run summary.
