---
"@ludelier/authoring": minor
"@ludelier/editor-core": minor
"@ludelier/editor-web": minor
"@ludelier/cli": minor
---

Replace the agent's step-budget with a run-until-done model: stream progress, interrupt anytime, checkpoint periodically.

A fixed `maxSteps` cap made large tasks fail as "incomplete" and forced the user to guess a number. The new model lets the agent run as long as the work takes, with the human in the loop instead of a budget:

- **`runAgent` runs until it finishes** (a clean `done`), the caller **interrupts** (`signal`), or a periodic **checkpoint** declines to continue (`onCheckpoint`, default every 500 turns). `maxSteps` is now an optional absolute backstop with no default (used by tests / non-interactive callers). The graph-health self-correction gate is unchanged.
- **Streamed progress** via `onEvent` (`AgentEvent`: turn / assistant / edit / query / verify / stop) and a `stopReason` + `aborted` on the result. The provider now forwards an `AbortSignal` to its HTTP call so an interrupt cancels the in-flight request.
- **System prompt** steers the agent to build **depth-first** — finish and wire each node before creating the next, never leaving empty placeholder nodes — so an interrupted or partial run degrades gracefully instead of leaving a skeleton.
- **Editor** (`editor-web`): the chat panel shows a **live work feed**, an **Interrupt** button (with the current turn), and a **checkpoint prompt** (Continue / Stop); the per-run max-steps input is gone. `editor-core`'s `chat()` forwards `signal` / `onEvent` / `onCheckpoint` / `checkpointEvery`.
- **CLI** (`author run`): streams edits to stderr, aborts on SIGINT, and reports `stop=<reason>`.
