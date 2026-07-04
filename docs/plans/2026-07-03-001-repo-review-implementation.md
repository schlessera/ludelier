# Repo-review implementation — 2026-07-03

_Tracking doc for implementing the recommendations of the full repo review (2026-07-03).
Kept up to date as work lands so it can be picked up mid-stream. Status legend:
⬜ not started · 🔨 in progress · ✅ done · ⏸ deferred._

## Context

A full review (five package-cluster deep dives + market research) rated the repo strong on
its core thesis — registry-driven agent/human parity, always-valid edits, deterministic
replay — with weaknesses clustered in: concrete correctness bugs (§A), the missing human
half of parity (§B), LLM-transport robustness (§C), CI/typecheck holes (§D), presentation
maturity (§E), and launch-surface staleness (§F). Five recommendation groups came out of
it; this doc tracks their implementation.

Market-research headlines (for posterity): agent-native parity is currently unclaimed
(engine MCP integrations all ship agent-only surfaces); deterministic hash-stable replay
has no AI-game competitor; Steam's 2026-01 AI-disclosure rewrite exempts dev-time tools
(tailwind) but not shipped AI assets (P3 provenance must surface this); MCP is becoming
the default expectation for "agent-ready" tools; OpenRouter is no-SLA infra — fine for
BYOK, needs a fallback for a paid tier; Dexie Cloud's pricing shape is a ready template
for `/ee`.

## 1. Correctness batch ✅

### 1a. Core packages (engine/schema/world/authoring) ✅ (2026-07-03)

All landed with tests (199 unit tests green) + changeset `review-correctness-core`:

- ✅ **Transcript-in-hash** — `snapshot()` in `packages/engine/src/simulation.ts` now
  includes the transcript (matches the documented intent; replay catches text-only edits).
  No pinned hash literals existed, so nothing else changed.
- ✅ **`choice` is terminal** — `validateStory` rejects statements after a `choice` (the
  reducer never resumes past one); agent system prompt updated to teach `end`/`jump`/`choice`.
  All existing fixtures already had choices node-final.
- ✅ **`importLog` guards** — per-line parse + shape check (string `command`/`runId`) → fail
  envelope with line number; 100k-record cap; `apply()` seq double-read unified.
- ✅ **`done`+batched-edits race** — calls batched after an accepted `done` are not applied
  (they get "not applied" tool results); no more `completed:true / ok:false`.
- ✅ **Checkpoint/abort race** — the checkpoint wait races the AbortSignal (`raceAbort`);
  an Interrupt during a pending checkpoint yields `stopReason: "aborted"`, no hang.
- ✅ **Provider hardening** — abort-aware retry/backoff (default 3×, honours `Retry-After`,
  429/5xx/network only) in `openAiCompatibleProvider` (+ passthrough in the openai/openrouter
  wrappers); temperature only sent when set (authoring flows default 0.2); explicit
  `maxTokens` defaults (generate 16384, agent turns 8192).

### 1b. Presentation packages (renderer-pixi/runtime-web/editor-web) ✅ (2026-07-03)

All landed + changeset `review-correctness-presentation`; e2e 3/3 green, dialog visually
verified ("Narrator"/"You" display names in declared colors), baseline regenerated
(`--update-snapshots=all` — the name-region diff was within the 3% tolerance, so plain
`e2e-update` left the stale PNG):

- ✅ **Character name/color** — new `PixiRenderer.setCharacters()`; dialog resolves
  id → display name + per-character color. Player wires at startup; editor preview
  re-wires per edit (`rebuild()`).
- ✅ **Asset-load failure** — `mount`/`preload` now inside try/catch → `fatal()` overlay.
- ✅ **Save invalidation** — `SaveRow` carries `storyHash` (`hashState(story)`) +
  `SAVE_VERSION`; `loadSave` returns null on mismatch (pre-existing rows lack the fields
  → discarded).
- ✅ **PlayCanvas detached host** — host div stays mounted; error is an absolute overlay
  (`.stage-wrap`/`.stage-error`).
- ✅ **Checkpoint wiring** — editor chat passes `checkpointEvery: 25`; pending checkpoint
  UI cleared in the run's `finally`.

## 2. CI / infra ✅ (2026-07-03; changeset `infra-license-ci-biome`, release-empty)

- ✅ MIT `LICENSE` file added.
- ✅ `.gitignore` += `.env`, `.env.*`, `*.local`, `.idea/`, `.vscode/`.
- ✅ CI: `pnpm build:editor` added to the check job (closes the .tsx-never-typechecked hole).
- ✅ CI: new `fmt` job runs `just fmt-check` (just installed via `taiki-e/install-action`).
- ✅ Biome 2.5 (lint + format): `biome.json` (2-space, double quotes, 110 cols; VCS-ignore
  aware; `noNonNullAssertion`/`noForEach`/`useTemplate`/`useOptionalChain` off to match the
  codebase's deliberate style; assist/import-sorting off), repo formatted once, deliberate
  React hook deps annotated with explained `biome-ignore`s, every button given an explicit
  `type="button"` (form-submit default footgun). Wired: `pnpm lint`/`lint:fix`,
  `just lint`/`lint-fix`, `just check` includes lint, CI check job runs `pnpm lint`.

## 3. Parity payoff (editor) ✅ (2026-07-03)

Landed + changeset `editor-forms-open-save` (27 new unit tests; verified end-to-end in the
browser: prefill, inline issues incl. the choice-terminal rule, undo of form edits, session
swap, failed/colliding asset preload → inline preview error):

- ✅ Manifest-driven edit forms — pure JSON-Schema→field derivation
  (`editor-web/src/forms/model.ts`: objects, enums, scalars, `oneOf` unions discriminated
  on `op`, raw-JSON fallback for anything else) + generic `<TaskForm>` submitting through
  `EditorSession.edit`; script-lens per-statement edit/delete + add-statement (prefilled),
  side-panel collapsible forms for all 10 manipulate tasks. A future world task gets a
  usable human form with zero editor code.
- ✅ Story open/save/new + log import — Open validates (`parseStoryJson`) and keeps the
  session on failure; Save downloads `<meta.id>.story.json`; New opens a minimal valid
  scaffold; side-panel Import log replays a `.log.jsonl` onto the session base via
  `fromLog` (new `EditorSession.baseStory` getter). Sessions swap at runtime with keyed
  PlayCanvas/panel remounts; cross-story asset-id collisions now error instead of showing
  a stale texture.

## 4. Provider robustness + MCP ✅ (2026-07-03)

- ✅ Retry/backoff etc. — folded into 1a provider hardening (done there).
- ✅ **MCP server**: `ludelier mcp <story.json> [--log <path>]` CLI subcommand serving the
  world registry over stdio via `@modelcontextprotocol/sdk` — understand tasks as read
  tools, manipulate through an `EditLog`, story file persisted after each successful edit.
  Registry-derived (zero hardcoded task names), same chokepoint as everything else.
  Shipped: `packages/cli/src/mcp.ts` (SDK 1.29.0 `McpServer`/`registerTool`, live Zod
  inputSchemas, atomic story persist, `describe`/`export-log` extras, one `mcp-<pid>`
  runId per session) + 7 hermetic tests in `packages/cli/test/mcp.test.ts`.

## 5. Public face ✅ (2026-07-03)

- ✅ README rewritten — leads with the three core properties (determinism / always-valid /
  agent-native parity), "what works today", `just` quickstart, current 9-package layout,
  roadmap with real statuses, LICENSE link.
- ✅ STATUS.md refreshed — date, layout (editor-core/editor-web/mcp), verification numbers
  (234/234, lint, both builds), §6 entries for the story map (2026-06-24) and this review's
  implementation, §9 open tasks rewritten, §12 version state corrected (0.1.0 + open
  Version PR).
- ✅ CONTRIBUTING.md added (setup, gates, changeset workflow, release model, security note).
- ✅ AGENTS.md — layout gains `editor-web` + the `mcp` CLI surface; dep graph corrected
  (runtime-web ≠ "all"); roadmap statuses fixed (P0/P1 done, P2 current); ci.yml listed.

## Known review findings NOT in scope of this pass (tracked for later)

- ~~renderer-pixi unit tests (0 today), DPI, keyboard + ARIA input paths~~ (✅ landed
  2026-07-03 — pure display math extracted to `renderer-pixi/src/layout.ts` + first unit
  tests in `test/layout.test.ts`; `RendererOptions.resolution` defaults to
  `devicePixelRatio` for crisp HiDPI rendering (no `autoDensity` — displayed size stays
  CSS-owned so the editor preview's fluid sizing keeps working; baseline unchanged at
  DPR 1); Enter/Space/1–9 keyboard input through the reducer's own guards + a polite
  `aria-live` region mirroring the pending step, with an e2e keyboard test). Resize
  handling beyond DPI (live viewport tracking) still deferred; audio (P3), save
  slots/backlog/text-speed UI still open.
- editor-web component tests + ~~Playwright smoke~~ (✅ smoke landed 2026-07-03 —
  `editor` e2e project, `packages/editor-web/e2e/editor.spec.ts`); ~~error boundary;
  BYOK "remember key" opt-in; per-run revert from History~~ (✅ landed 2026-07-03
  follow-up, changeset `editor-ux-batch` — plus play position now survives edits via
  action replay, browser-verified); ~~responsive layout; map viewport persistence~~
  (✅ landed 2026-07-04, changeset `editor-responsive-map` — 1280/820px breakpoints
  browser-verified; map keyed by session swap, edits keep the viewport, Controls' fit
  button re-frames).
- `revertRun` beyond contiguous tail; typed-var declaration; ~~`add/remove-choice-option`
  ops~~ (✅ landed 2026-07-03 as `add/update/remove-choice-option`); ~~bounded all-paths
  simulate surfacing~~ (✅ landed 2026-07-04 as the gate's non-blocking `runtimeUnreached`
  warnings, changeset `gate-warnings-fuzz`); ~~property/fuzz tests over `applyEdit`~~
  (✅ landed 2026-07-04 — seeded 2×400-command fuzz in `packages/world/test/fuzz.test.ts`).
- Live-provider smoke test in CI (needs a key/secret story); transcript/`raw` redaction
  before persisting provenance. ~~coverage reporting; Playwright browser caching in CI~~ —
  ✅ landed 2026-07-03 follow-up (`just coverage`, lockfile-keyed Chromium cache).
- npm-publish prerequisites (build step, `types`, compiled `bin`) — deliberate, see
  `release.yml` header.

## Verification gate — PASSED (2026-07-03)

Final `just ci` run: typecheck clean, Biome lint clean, **234/234 unit tests** (28 files),
web + editor builds OK, **3/3 Playwright e2e** (baseline regenerated once for the
name/color fix). Changesets: `review-correctness-core`, `review-correctness-presentation`,
`mcp-server`, `editor-forms-open-save`, `infra-license-ci-biome` (release-empty).

**Everything in sections 1–5 is done.** If picking this up later: the remaining known
debt lives in the "not in scope" list above and STATUS.md §9.
