---
"@ludelier/schema": minor
"@ludelier/engine": minor
"@ludelier/world": minor
"@ludelier/authoring": minor
---

Architecture-review hardening: faster fold, one definition of valid, wider hash, real coverage, more checks.

Five fixes from the 2026-06-22 design review (see `docs/architecture-risks.md`):

- **Memoized EditLog fold (engine of the editor).** `EditLog.currentStory()` re-folded every record from the base on each call — O(n²) over an editing session. It now caches the folded tip (`apply` sets it directly, no refold) and invalidates only on undo/redo/revertRun, so N edits are O(n). `importLog` drops from O(n²) to O(n). Behaviour is unchanged (round-trip + refold tests stay green).
- **One definition of "valid".** The `say.who` cross-reference (a `say` must name a declared character) moved from a world-only check into `validateStory`, so authoring (`generateStory`) and the world edit gate now agree — a story that validates can always be loaded into an `EditLog`. `validateWorld` is now a thin alias; the redundant `say-who-check` module is gone.
- **64-bit identity hash.** `hashState`/`hashStory` were FNV-1a **32-bit** (birthday collisions ~77k items) — too narrow for a content identity / cache key. Now a shared `fnv1a64` (BigInt, exact 64-bit, 16-hex) lives in `@ludelier/engine` and `@ludelier/world` imports it, so there is one hash implementation and no 32-vs-64 drift. Digests change width (pre-1.0; no stored goldens).
- **Behavioural coverage in verify.** `runAgent`'s self-check ran `simulate(actions:[])`, which only walked the linear head and reported no real coverage. New deterministic, bounded, crash-safe `exploreStory` (engine) + `explore` world task actually play through every reachable path honouring `if` conditions; verify now reports true reached-node coverage, whether an ending is reachable, choices that gate themselves off (`stuck`), and runtime infinite loops (`crashed`) instead of throwing.
- **More guardrails.** `validateStory` now rejects duplicate statement ids (backstops every id-generation path: a collision is caught by the always-valid re-validate). The agent gate additionally flags, relative to the pre-run baseline, variables read in a choice `if` but never written (`unwrittenVarReads`), self-gated choices, and stories that crash at runtime — each with a fix hint, so the agent self-corrects before `done`.
