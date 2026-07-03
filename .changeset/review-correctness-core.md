---
"@ludelier/schema": minor
"@ludelier/engine": minor
"@ludelier/world": minor
"@ludelier/authoring": minor
---

Repo-review correctness batch (core): transcript in the hash, choice is terminal, hardened importLog, agent-loop race fixes, provider retries.

Six fixes from the 2026-07-03 repo review (see `docs/plans/2026-07-03-001-repo-review-implementation.md`):

- **The state hash now covers the transcript.** `Simulation.hash()` documented that the transcript was included but omitted it, so a text-only edit (a changed `say`) was invisible to replay regression. The snapshot now includes the transcript — replay catches text changes. Hashes change (pre-1.0; no stored goldens); `exploreStory`'s transcript-free dedup key is unaffected.
- **`choice` joins the terminal set.** Every choice option carries a `goto` and the reducer never resumes past a choice, so statements after one were silently unreachable — yet validated. `validateStory` now rejects dead code after a `choice` exactly as after `end`/`jump`; the agent system prompt teaches the wider rule.
- **`importLog` never throws.** A malformed JSONL line hit a bare `JSON.parse` and threw, breaking the module's fail-envelope contract. Each line is now parsed and shape-checked (string `command`/`runId`) with the line number in the failure, and imports are capped at 100k records. The `seq`-vs-`records.length` double-read in `apply` is unified on one value.
- **A clean `done` ends the turn's batch.** A model emitting `[done, edit]` in one batch used to pass the gate and then apply the trailing edit — yielding `completed: true` with `ok: false`. Calls batched after an accepted `done` are no longer applied (they get a "not applied" tool result so the transcript stays coherent).
- **Interrupt during a checkpoint aborts instead of hanging.** The loop parked on `await onCheckpoint(...)` could never see the abort signal, so an Interrupt while the prompt was showing hung the run (and the session lock) forever. The checkpoint wait now races the AbortSignal.
- **Transient provider failures retry.** A single 429/5xx/network error aborted a whole multi-turn run. `openAiCompatibleProvider` now retries (default 3×, exponential backoff, honours `Retry-After`, abort-aware, never retries 4xx client errors). Authoring flows also stop inheriting a hidden 0.7 temperature — the provider only sends one when asked, and `generateStory`/`runAgent` default to 0.2 with explicit generous `maxTokens` so long outputs aren't silently truncated into unparseable JSON.
