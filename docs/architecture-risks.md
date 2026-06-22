# Architecture risks & weaknesses

_Captured 2026-06-22 from a full design/architecture review of the P2 codebase._

Findings are ordered by severity within each group. File refs are `path:line` at the time of review. Items marked **[fixed 2026-06-22]** were addressed in the follow-up pass; the rest stay open.

## Weaknesses (in the code today)

1. **Refold is O(n) per call, called everywhere → quadratic session cost.** **[fixed 2026-06-22]**
   `EditLog.currentStory()` re-applied every record from base (`packages/world/src/log.ts:38`), each through full-story `validateWorld`; `apply` calls it first (so does undo/redo). N edits = O(N²·storySize). Self-tagged KTD-2 "accepted for slice-1." Fixed by caching the folded tip and invalidating on undo/redo/revertRun.

2. **Two definitions of "valid" — asymmetric entry paths.** **[fixed 2026-06-22]**
   Schema `validateStory` did not check `say.who`; only the world's `validateWorld` (`packages/world/src/applyEdit.ts:12`) added it via `sayWhoIssues`. So `generateStory` (authoring, bare `validateStory`) could emit a story that then failed `importLog` / `EditorSession` base-load. Fixed by folding the `say.who` cross-ref into `validateStory`; `validateWorld` now delegates.

3. **No variable validation anywhere.** **[partly fixed 2026-06-22]**
   Vars are created implicitly on first `set`/`add` (`packages/engine/src/reducer.ts:64`); `if`/conditions reference them with no cross-ref. A typo'd var name = silent always-false branch. Fixed *softly*: a "read-never-written" var check now feeds the runAgent gate (not a hard `validateStory` error, so incremental edits aren't wedged when the `set` lands after the `if`).

4. **`compare()` silently coerces (`packages/engine/src/reducer.ts:13`).** **[fixed 2026-06-22]**
   `gt/lt` did `a as number`; `undefined > 5` and `"hi" > 5` were silently false. Now `compare` is explicit: `eq`/`ne` strict, ordered ops number-only (non-number ⇒ `false`, no coercion or lexical ordering). `conditionTypeIssues` (world) statically flags ordered comparisons against a non-number / on a var written as a non-number, and the agent gate surfaces them.

5. **Agent "clean" gate was structural-only; verify was shallow.** **[fixed 2026-06-22]**
   The gate checks Zod-valid + no new unreachable/dead-end (`packages/authoring/src/run.ts:112`). `verify` ran `simulate(actions:[])` (`run.ts:181`) which only walks the linear auto-advance head — no choice branch was ever explored (`packages/world/src/understand/simulate.ts:25`), so `reached` was near-useless for coverage. Fixed by a deterministic bounded branch walk (`exploreStory`) feeding real `reached` + `endReachable` into verify.

6. **No statement-id uniqueness check; three id schemes.** **[fixed 2026-06-22]**
   `validateStory` checked node/asset id uniqueness, never statement ids — but edits target by id (`packages/world/src/manipulate/statements.ts`). Schemes: authored `<nodeId>#<i>` (`statement-id.ts:21`), log-created `s<seq>` (`log.ts:62`), direct-applyEdit fallback `<nodeId>#g<len>` (`statements.ts:34`). Collision paths existed (authored story literally using `s5`; direct add→remove→add at the same body length). Fixed by adding statement-id uniqueness to `validateStory`, which the always-valid re-validate now uses to reject any collision. The two intended schemes (load-time positional, edit-time seq) remain; the third is now backstopped.

## Risks (forward-looking)

- **Concurrency / mid-run mutation.** **[fixed 2026-06-22]** `EditorSession.chat` runs an async agent on the *same* mutable log while a human could `edit()` between provider awaits (`packages/editor-core/src/index.ts`). Fixed with a run lock: `edit`/`revertRun` refuse and `undo`/`redo`/a second `chat` throw while a run is in flight (`busy` getter for the UI). Reads stay allowed.
- **Runtime crash on cycle.** **[fixed 2026-06-22]** `MAX_STEPS` threw a bare `Error` (`packages/engine/src/reducer.ts`) — a hard crash in the player. Now a typed `StatementBudgetError`, caught by `runtime-web` and the `editor-web` play preview to show a recoverable error instead of white-screening. (`exploreStory` also reports it as `crashed` so the agent gate flags it pre-ship.)
- **LLM structured-output portability.** OPEN. The 10-op discriminated union → JSON Schema (`storyJsonSchema`) for tool params / author mode. `oneOf`/depth handling varies across OpenRouter models; some ignore the schema. The validate loop is the safety net, but expect models that never converge → `maxAttempts` exhaustion. Seen in the P2 live smoke note.
- **`revertRun` is contiguous-tail only** (`packages/world/src/log.ts`). OPEN. Once a human edits after an AI turn, that turn can't be reverted. Linear-history tradeoff (KTD-11); UX limit, not a bug.
- **`importLog` trusts record shape** (`packages/world/src/log.ts`, raw `JSON.parse` → `EditRecord`). OPEN. Params are re-validated downstream, but `seq` is silently renumbered — export/import is not bijective under tampering. Honest logs are fine.

## Open follow-ups

- LLM structured-output convergence (provider variance).
- `revertRun` beyond a contiguous tail (non-linear history).
- `importLog` record-shape validation / bijective `seq`.
- Typed-var *declaration* in the schema (vs the current inference + static checks).
- Optionally make the runtime-unreached set (from `exploreStory`) a surfaced gate warning, not just informational.
