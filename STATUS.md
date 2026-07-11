# Ludelier — Project Status & Handoff

_Last updated: 2026-07-12_

A living snapshot of where the project stands: decisions, what's built, what's open, and the roadmap. For day-to-day conventions and the golden rules, see [AGENTS.md](./AGENTS.md). This file is the "where are we" overview.

---

## 1. What this is

**Ludelier** — a TypeScript, web-first **engine + editor + runtime for AI-augmented game development**. Initial scope: interactive visual novels (Ren'Py-style); open to other genres later. The defining goal: **AI agents can reliably grow and maintain a game with no manual steps where avoidable**.

- The **app is an agent-native editor**: a game-engine-style environment with a **built-in agentic chat**. The agent has dedicated **understand** tasks (inspect/validate/simulate the game world) and **manipulate** tasks (validated, structured edits that keep the Story always-valid), with agent-native parity to the editor UI. (See AGENTS.md → "The app: agent-native editor".)
- Name: _ludo_ ("play") + _atelier_ ("workshop") = "a workshop for play-crafting". Working title was `gaimez`.
- Business model: open-core **MIT** engine (bring-your-own-key AI, self-hostable) + a planned hosted **cloud** tier (paid usage + hosting). Cloud-only code will live under `/ee` (commercial).
- Players run finished games as installable **PWAs** — no hardware/driver/platform requirements.

---

## 2. Locked decisions (the stack)

| Area | Decision |
|---|---|
| Language | **TypeScript strict**, end-to-end (tightest AI-codegen feedback loop) |
| Content format | Custom **Zod-typed DSL**, JSON canonical. Zod = single source of truth → JSON Schema constrains LLM gen, runtime-validates. Author-facing DSLs compile down to JSON later |
| Engine | **Greenfield on PixiJS v8** (WebGL2 primary, WebGPU opt-in). Not building on Pixi'VN |
| Architecture | 3-layer: pure **logic** (seeded RNG injected, no `Math.random`) / **state** (Redux-style action dispatch + JSONL trace) / **renderer** (display only). `Simulation` = headless runner. Determinism rule: sort by stable id before order-sensitive iteration |
| Testing | **Vitest** (pure logic, no browser) + **Playwright** (E2E/visual, SwiftShader, `data-ready` flag) |
| Build / PWA | **Vite** + **vite-plugin-pwa** (Workbox) + **Dexie** (IndexedDB) saves → Dexie Cloud addon = drop-in cloud-sync upsell |
| Audio | **Howler.js** browser presentation adapters — deterministic engine cue state, generated-voice disclosure, and no renderer/engine dependency |
| Assets (v1) | **Multi-provider** model-targeted `AssetProvider` — OpenAI image/TTS + OpenRouter images, BYOK per provider, validated capability routing, private redacted provenance (`promptHash`, never plaintext prompts/secrets/raw responses), and verified hash cache. fal.ai / ElevenLabs are later adapters |
| AI authoring (P2) | **Multi-provider `LLMProvider`** (OpenAI + OpenRouter, shared OpenAI-compatible core, BYOK per provider) + `generateStory()` self-correction loop; the completed **world API** (understand + manipulate tasks over the Story) powers LLM tools for the editor's agentic chat |
| App shape | **Agent-native editor**: game-engine-style editor + built-in agentic chat; world API drives both the chat and the UI (parity). Play mode = the runtime-web PWA player |
| Versioning | **changesets**, independent per-package, **version-PR only (no npm publish yet)** |
| License | **MIT** open-core + `/ee` (commercial) for cloud features |

---

## 3. Naming — Ludelier

Cleared (2026-06-18) across npm, GitHub, all domains (RDAP incl. `.com`), trademark (USPTO + EUIPO + WIPO zero hits), and socials.

- **Caveats (friction, not blockers):** "luthier" autocorrect confusion (EN); Scandinavian _luder_ / German _Luder_ echo (morphologically distinct — note in a style guide; EN/FR/JA markets clean).
- **Pre-public-launch TODO:** register `ludelier.com` + `.io`/`.ai`; run a **human** USPTO/EUIPO search before filing a trademark (classes 9 / 41 / 42).

---

## 4. Repository layout

```
packages/
  schema/         @ludelier/schema — Zod Story DSL, validateStory(), storyJsonSchema()/toJsonSchema()
  engine/         @ludelier/engine — reducer, seeded RNG, stable hash, Simulation, JSONL replay
  world/          @ludelier/world  — agent world API: task registry + describe(), understand/manipulate tasks, applyEdit, EditLog
  cli/            @ludelier/cli    — validate | simulate | replay | world … | author run | mcp (the agent harness)
  authoring/      @ludelier/authoring — P2: LLMProvider (+tool-calling, retry/backoff) + generateStory() loop + worldTools/dispatch + runAgent
  assets/         @ludelier/assets — portable provider targets, resolution, redacted provenance, canonical hashes
  assets-node/    @ludelier/assets-node — Node-only processing, controlled persistence, verified cache/recovery
  audio-web/      @ludelier/audio-web — browser-only Howler presentation adapter
  editor-core/    @ludelier/editor-core — headless EditorSession (the parity façade; owns the EditLog + agent chat)
  editor-web/     @ludelier/editor-web  — React editor: story map + script lens + play preview + edit forms + agent chat
  renderer-pixi/  @ludelier/renderer-pixi — PixiJS v8 display-only renderer (dialog resolves character name/color)
  runtime-web/    @ludelier/runtime-web   — Vite + PWA player, Dexie autosave (story-hash invalidated), window.__ludelier
examples/         cafe.story.json + cafe.actions.json
.agents/skills/   checked-in agent skills (image-generation)
.changeset/       changesets config + pending changesets
.github/workflows/ release.yml (Version PR), changeset-check.yml (PR gate), ci.yml (typecheck/lint/unit/builds + fmt + e2e)
justfile          canonical task runner
AGENTS.md         conventions + golden rules (CLAUDE.md imports it)
```

Toolchain: Node ≥20 (CI 22, `.nvmrc`), pnpm 10.32, Zod 4, Vitest 2, Vite 5, React 18, PixiJS 8, Dexie 4, Playwright, tsx, Biome 2.5 (lint+format).

---

## 5. Commands

`just` is the canonical entrypoint (`just` lists everything). Recipes wrap pnpm scripts.

```bash
just setup    # install deps + Playwright Chromium
just demo     # play the example story headlessly via the CLI
just dev      # web player dev server (Vite)
just check    # typecheck + unit tests + web build (no browser)
just e2e      # Playwright e2e (self-managed dev server; see gotcha §11)
just ci       # check + e2e
just changeset / just version
```

---

## 6. Completed work

### P0 — headless deterministic core ✅
- **`@ludelier/schema`** — Story = nodes of statements (`say`/`set`/`add`/`roll`/`choice`/`jump`/`branch`/`end` + `scene`/`show`/`hide`), discriminated union on `op`. `branch` is a conditional jump (state-driven flow; falls through when false). `validateStory()` = Zod shape + cross-reference checks (unique node/asset/statement ids, gotos resolve, `say.who` is a declared character, start exists, no statement after a terminal). `storyJsonSchema()` exports JSON Schema for LLM constraint.
- **`@ludelier/engine`** — pure `reducer(story, state, action)`; mulberry32 seeded RNG threaded through state (no `Math.random`); FNV-1a stable hash over sorted-key snapshot; `Simulation` headless runner; `record()` / `replayTrace()` JSONL regression.
- **`@ludelier/cli`** — `validate | simulate | replay` agent harness.
- **Determinism proven:** seed 42 → fixed hash; replay matches per-step; tampered hash + wrong seed throw.

### P1 — browser player + backgrounds/sprites ✅
- **`@ludelier/renderer-pixi`** — PixiJS v8 display-only renderer: cover-fit **background**, bottom-anchored **character sprites** (left/center/right, id-sorted), dialog/speaker/wrapped text, choice buttons, **crossfades** on bg/sprite changes, dedicated (configurable) layer z-indices. Zero game logic.
- **Backgrounds + character sprites** — Story DSL `assets` + `scene`/`show`/`hide` (cross-ref validated); engine tracks a persistent `stage` (bg + id-sorted sprites) threaded through the reducer and folded into the deterministic hash; renderer preloads + draws it.
- **`@ludelier/runtime-web`** — Vite + vite-plugin-pwa player: validates + plays a Story, **asset preload**, **Dexie autosave/resume**, installable PWA (SVG icons, standard + maskable), `window.__ludelier` agent-native handle + `data-ready` first-paint flag + `data-anim` settle flag.
- **Playwright e2e** (3 tests): play-through via handle, visual regression (`opening.png`, SwiftShader, ≤3% diff, waits for crossfade settle), and **real canvas-click** input.
- **CI** (`ci.yml`): typecheck + unit + build + e2e.
- `cafe.story.json` plays end-to-end in a real browser **with a café background + character sprite** (AI-generated via the OpenAI Images API; see the `image-generation` agent skill).

### P2 — AI authoring + agent world API ✅ (complete)
- **`@ludelier/authoring`** (first slice) — `LLMProvider` seam mirroring `AssetProvider` (OpenAI + OpenRouter over a shared OpenAI-compatible core; BYOK-per-provider registry) + `generateStory()`: a provider-agnostic **self-correction loop** that constrains output with `storyJsonSchema()`, validates with `validateStory()`, and feeds issues back until valid or attempts exhausted. Hermetic mock-provider / fake-fetch tests.
- **World API & agent harness — slice 1 ✅ (2026-06-21):** new pure **`@ludelier/world`** package — self-describing task registry (`describe()` manifest derives CLI subcommands + LLM tools), 9 understand tasks + a 12-command flattened manipulate spine through an always-valid `applyEdit` (validateStory + world-local `say.who` check), event-sourced `EditLog` (linear-history undo/redo, contiguous-tail `revertRun`, JSONL replay), `{success}` envelope, canonical `hashStory`. `@ludelier/authoring` gained provider tool-calling + a `worldTools`/`dispatch` adapter + the autonomous `runAgent` loop (self-verify, partial-run aware, hermetic via scripted provider). `@ludelier/cli` gained registry-derived `world …` subcommands + `author run` (entrypoint refactored to a testable `run(argv)`). 60 unit tests across world/authoring/cli; `just check` green. Plan: `docs/plans/2026-06-19-001-feat-world-api-agent-harness-plan.md` (deepened + reviewed; units U1–U12).
- **Live-LLM smoke test ✅ (2026-06-21):** `cli author run` exercised end-to-end against **OpenRouter + `openai/gpt-5-mini`** (BYOK) — live provider tool-calling drives the full `runAgent` loop, edits stay Zod-valid, provider tool-calling variance is not a blocker. The default slug `openai/gpt-5-mini` is verified present + tool-capable on OpenRouter.
- **Self-correction loop closed ✅ (2026-06-21):** `runAgent` now feeds graph self-verification back into the loop — `done` is a verification gate that returns introduced unreachable/dead-end (or invalidity) problems against a pre-run baseline so the model self-corrects; `ok`/`completed` mean **clean** (valid + no new graph breakage), not merely Zod-valid. Caught a live regression (model deleting an existing `end`) instead of silently shipping it. Both paths proven: live negative (gate blocks a broken run, EXIT=1) + live positive (model wires + ends a new node → completes clean) + hermetic tests.
- **Loop steering ✅ (2026-06-21):** default `maxSteps` raised 12 → 24; the agent system prompt now spells out the graph-health contract the `done` gate enforces (inspect first, make new nodes reachable, give endings an `end`, don't delete existing `end`s, verify with `graph` before `done`); `cli author run` gained a `--max-steps <n>` flag. With this, the same vague prompt that previously flailed now self-corrects to a clean, completed run live.
- **Editor session core ✅ (2026-06-22):** new pure **`@ludelier/editor-core`** package — `EditorSession`, the single parity façade a human UI and the agent both drive. Owns the Story as an `EditLog`; `query` (understand) + `edit` (manipulate, through the always-valid chokepoint) + undo/redo/`revertRun` + `canUndo`/`canRedo` + `change` events + `exportLog`/`fromLog`, and an agent `chat` loop bound to the session log (chat edits join the same undoable history). Supporting: `EditLog.canUndo()/canRedo()`; `runAgent` accepts an injectable `log`. Pure, Vitest-tested (no browser). **App-shell framework decided: React** (largest ecosystem + most AI-codegen training data → best fit for the agent-grows-the-app goal).
- **React editor shell — slice 1 ✅ (2026-06-22):** new **`@ludelier/editor-web`** (Vite + React) — a thin view bound to `EditorSession`. Agent chat panel (BYOK OpenRouter) showing run edits / clean+completed status / problems + revert-run; story inspector (node list with start/unreachable/dead-end badges, click → statements); graph-health + edit-log history + copy-log; toolbar with validity badge, `canUndo`/`canRedo`-gated undo/redo, and add-node — manual + agent edits share one undoable history. Verified live (builds, renders in a headless browser, reactive binding updates on edits); wired into `just build`/`just check`.
- **Editor play preview ✅ (2026-06-22):** `editor-web` now embeds the display-only `renderer-pixi` renderer (`PlayCanvas`) — the current story plays live (bg + sprite + dialog + choices) beside the editing surface and **replays from start on every edit**, closing the edit→see loop. StrictMode-safe Pixi lifecycle; assets served from the shared `runtime-web/public`. The `+ Node` prompt/alert was replaced with an inline input. Verified in a headless browser: a manual `create-node` updates node list + graph health (flags it unreachable/dead-end) + history + preview live; undo reverts; no console errors.
- **Run-until-done agent loop ✅ (2026-06-22):** dropped the fixed `maxSteps` budget (it failed big tasks as "incomplete"). `runAgent` now runs until it finishes (clean `done`), the user **interrupts** (`AbortSignal`, forwarded to the provider's HTTP call), or a **checkpoint** declines (`onCheckpoint`, default every 500 turns). Streams `AgentEvent`s (turn/edit/query/verify/stop) + a `stopReason`; system prompt steers **depth-first** building so partial/interrupted runs degrade gracefully. The editor chat shows a **live work feed**, an **Interrupt** button, and a Continue/Stop checkpoint prompt (max-steps input removed); CLI streams edits + aborts on SIGINT. Verified live: streamed feed + mid-run interrupt → aborted result + revert; a "full branching careers discussion" prompt completes clean (48 edits) with depth-first steering.
- **Stable statement ids ✅ (2026-06-22):** statement edits target a statement by a stable `id`, not a fragile position (the agent kept miscounting indices and removing the wrong statement while the gate still read "clean"). Schema adds an optional statement `id`; the `EditLog` normalizes authored statements (`"<nodeId>#<i>"`) and bakes a monotonic `"s<seq>"` into each statement-creating record (deterministic refold, collision-safe, `hashStory` covers ids). `remove-statement`/`rewire-goto` now take a `statementId` (no more `index`); `get-node` + the inspector + the chat feed surface ids; the agent prompt steers targeting by id. Verified live: the agent removes exactly the right statement by id.
- **Terminal-position rule + insert-* ✅ (2026-06-22):** appending to a node that already ends produced dead code after the `end` (silently "valid"). Now `validateStory` rejects any statement after a terminal (`end`/`jump`), so the gate catches it; and `insert-say`/`insert-show`/`insert-choice` add a statement **before** an existing one (by `beforeStatementId`). Verified live: "add closing sentences to the ending node" inserts them before the `end`. (`move-statement` still deferred.)
- **Generic statement tools ✅ (2026-06-22):** replaced the flattened append-*/insert-* spine (heading toward 50+ tools as statement kinds grow) with **generic** ops — one `add-statement` takes the whole `Statement` discriminated union (Zod 4 `toJSONSchema` → clean `oneOf`), plus `update-statement` (replace in place), `move-statement` (reorder), `remove-statement`. Manipulate tools: **15 → 10, and flat** (a new statement kind adds zero tools). Reverses KTD-4/KTD-7's flattening, which was a hedge against weak LLM union-fill — **prototype-validated live**: gpt-5-mini filled the union across scene/show/say/end/choice correctly, clean+valid. Guardrails unchanged (terminal rule, say.who, cross-refs, stable-id injection at `params.statement.id`).
- **Story map + script lens + play-from-here ✅ (2026-06-24):** read-only branching **story map** in the editor (React Flow + dagre, deterministic layered layout, start/unreachable/dead-end badges, labelled choice/jump/branch edges via the world's `flow-edges` task — same derivation the agent queries), a **script lens** pretty-printing the selected node's statements, and **play-from-here** (engine `Simulation` gained an optional `start` node; fresh var state, documented v1 limitation). Plan: `docs/plans/2026-06-24-001-feat-editor-story-map-plan.md`.
- **Repo review implemented ✅ (2026-07-03):** a full review (5 package deep-dives + market research) and the implementation of all its recommendations — tracking doc `docs/plans/2026-07-03-001-repo-review-implementation.md`. Highlights:
  - **Correctness batch:** state hash now covers the transcript (text edits show in replay); `choice` is terminal in `validateStory` (dead code after it is rejected); `importLog` never throws (per-line parse + shape check); a clean `done` ends its tool batch (no `completed:true/ok:false`); Interrupt during a checkpoint aborts instead of hanging; provider retry/backoff (429/5xx/network, honours `Retry-After`), temperature only-when-set (authoring defaults 0.2), explicit `maxTokens`. Dialog renders the **declared character name in its color** (was: raw id in hardcoded blue — new `PixiRenderer.setCharacters()`; visual baseline regenerated); asset-load failures hit the player's error overlay; saves carry a story fingerprint + `SAVE_VERSION` and invalidate on mismatch; the editor preview's error state overlays (not replaces) the Pixi host; the chat checkpoints every 25 turns (the prompt was unreachable at the 500 default).
  - **MCP server ✅:** `ludelier mcp <story.json> [--log <path>]` — stdio MCP server (`@modelcontextprotocol/sdk`) over the same registry: understand tasks as read tools, manipulate through an `EditLog`, story persisted atomically per edit, `describe`/`export-log` extras, one `mcp-<pid>` runId per session (so a whole session is `revertRun`-able). Claude Code / Cursor can drive the world API directly.
  - **The parity payoff ✅ — manifest-driven edit forms:** a pure JSON-Schema→form-field derivation (`editor-web/src/forms/`) renders a working human form for **every** manipulate task from `describe()` (objects, enums, scalar unions, `oneOf` discriminated on `op`; raw-JSON fallback) submitting through `EditorSession.edit` — a new world task gets a human form with zero editor code. Entry points: per-statement edit/delete + add-statement in the script lens; all 10 tasks in the side panel. Plus **story open/save/new** and **edit-log import** (sessions swap at runtime).
  - **Infra:** MIT `LICENSE` (was missing!); CI now builds editor-web (previously `.tsx` was never typechecked in CI) and gates **Biome** lint/format (`just lint`) + `just fmt-check`; `.gitignore` covers `.env`; `CONTRIBUTING.md`; README rewritten (it still claimed "P0 — no rendering yet").
- **Follow-up round ✅ (2026-07-03, same day):** `add/update/remove-choice-option` world ops (manifest 21 → 24; CLI/LLM/MCP/forms pick them up with zero further code); a 6-test Playwright smoke suite for the editor (`editor` e2e project, port 5180); play position survives edits (the preview replays its own recorded actions); per-run **Revert** in the History panel (runs grouped; the contiguous-tail run is actionable); a React error boundary; opt-in "remember key"; renderer HiDPI (`resolution` defaults to `devicePixelRatio`; visual baseline unchanged) + first renderer unit tests (pure display math in `layout.ts`); player keyboard input (Enter/Space/1–9 through the reducer's own guards) + a polite `aria-live` transcript line; `just coverage` + CI Playwright browser caching.
- **Polish round ✅ (2026-07-04):** responsive editor layout (center-first stacking at 1280/820px, browser-verified) + story map keyed by session swap (Open/New re-frames; edits keep the viewport; fit-on-demand via the map controls); the agent gate gained a **non-blocking warnings channel** — newly-introduced statically-reachable-but-runtime-unreached nodes ride along on an accepted `done` (`{ok:true, warnings}`) and in the editor feed (closes the last `architecture-risks.md` open follow-up); a seeded **fuzz harness** over `applyEdit` (2×400 random commands incl. undo/redo interleave — always-valid after every apply, export/import refolds identically).
- **Graph-centric editor layout ✅ (2026-07-07):** the editor shell was redesigned around the story graph — a large central React Flow canvas flanked by a collapsible agent-chat dock (left) and a tabbed inspector (right; Node / Edit / Health / History), with drag-to-resize splitters whose sizes persist across reloads (`react-resizable-panels`) and a slim activity rail to toggle either dock. The inspector scrolls internally, so selecting a node no longer reflows the graph or the chat (the long-standing "windows jump around when you click a node" behaviour is gone; the graph gets far more room). The Pixi play preview became **on-demand**: a Play control opens it as a modal overlay (Escape / backdrop / Close), and it can **pop out into a separate window** for multi-monitor use while staying in sync with edits.
- **Runtime-coverage surfacing + editor component tests ✅ (2026-07-10) — P2's last two open items:** the editor **Health** tab now surfaces the bounded all-paths `explore` report (the world's `explore` task / engine `exploreStory`) beside the static `graph`, giving the human editor parity with what the agent's `done` gate verifies — played-through node count, the **static-vs-runtime divergence** (statically wired but never played, warning-grade), whether an ending is actually reachable, self-gated `stuck` nodes, plus `crashed` / `truncated` notices. Added as `EditorSnapshot.explore` (computed via the same `query("explore")` the agent uses; memoized per edit); `HealthPanel` extracted to a pure, prop-driven component with matching `unhealthy`-dot severity. And a **jsdom + React Testing Library** component-test harness (`.test.tsx`, per-file `@vitest-environment jsdom`, automatic-JSX esbuild) covering `HealthPanel`, the manifest-driven `TaskForm`, and the `ScriptLens`. `pnpm test` 234 → **287/287** across 34 files.
- **P3 — multi-provider assets, provenance, and deterministic audio ✅ (2026-07-10):** added portable OpenAI image/TTS + OpenRouter image targets with capability resolution, safe retry semantics, redacted provenance, and verified cache identity; Node-only processing/persistence uses controlled paths, reservations, recovery-safe replacement, and private sidecars. Schema/world/engine now carry typed media metadata and deterministic `sound` / `stop-sound` cues. CLI/MCP/editor support authorized generation and redacted inventory, while the editor shares its transaction path with the agent and browser dev persistence preflights/reserves before paid dispatch. Runtime/editor Howler adapters reconcile desired audio, suppress stale cues, disclose generated voice, and retain image-only Pixi preload.

### Tooling ✅
- changesets (independent, version-PR only); `release.yml` + `changeset-check.yml`.
- `justfile` task runner; `AGENTS.md` + `CLAUDE.md`.
- Fixed a WSL2 e2e wall-clock issue (2:17 → ~2s) — see §11.

---

## 7. Verification status (full CI re-run 2026-07-12)

- `pnpm typecheck` — clean (tsc strict).
- `pnpm lint` — clean (Biome lint + format); configuration uses the current `preset: "recommended"` syntax.
- `pnpm test` — **432/432** unit/component tests pass across **48** files, including provider, persistence, replay, agent/MCP, editor, and audio regression coverage.
- `pnpm build:web` + `pnpm build:editor` — OK (both gate CI).
- `just e2e` — **20/20** Playwright tests pass across runtime and editor projects.
- **Manual BYOK smoke** — passed in isolated temporary roots: one OpenAI opaque image, one OpenAI TTS response, and one configured OpenRouter image target; all persisted assets were redacted-inventory `valid` and the resulting Story validated.

---

## 8. Roadmap

| Phase | Status | Scope |
|---|---|---|
| **P0** headless core | ✅ done | engine + schema + CLI harness + Vitest |
| **P1** render + play | ✅ done | PixiJS renderer, Vite/PWA shell, Dexie saves, Playwright, **backgrounds + character sprites** (scene/show/hide + crossfades) |
| **P2** AI authoring + world API | ✅ done | multi-provider LLM adapter (OpenAI + OpenRouter) + self-correction loop; understand/manipulate world API + registry + agent loop + CLI + **MCP**; React editor + **agentic chat**; manifest-driven edit forms; graph-centric layout; static **+ runtime** health surfacing; unit + component + e2e tests |
| **P3** AI assets | ✅ done | OpenAI image/TTS + OpenRouter images, model-targeted capability routing, redacted provenance + verified cache/persistence, CLI/MCP/editor/agent generation parity, deterministic audio + Howler presentation; live BYOK smoke passed |
| **P4** cloud seam | ▶ planned | self-host BYOK config ↔ metered cloud per-tenant keys; first slice is an EE-owned credential broker over existing provider seams, with LiteLLM deferred as an optional EE-only adapter — [architecture plan](docs/plans/2026-07-12-001-feat-p4-cloud-seam-architecture-plan.md) |

---

## 9. Open tasks / TODO

- **P2 — COMPLETE (2026-07-10).** The last two items — editor component tests and bounded all-paths (`explore`) surfacing in the editor — landed 2026-07-10 (see §6). (Choice-option ops, the editor Playwright smoke, play-position preservation, per-run History revert landed 2026-07-03; the graph-centric layout 2026-07-07.)
- **P3 — COMPLETE (2026-07-10).** Multi-provider image/TTS generation, private redacted provenance, controlled host persistence/recovery, authorized CLI/MCP/editor/agent workflows, deterministic audio presentation, and the documented manual BYOK smoke all passed; the detailed execution record is `docs/plans/2026-07-10-001-p3-ai-assets-plan.md`.
- **Presentation debt** (from the 2026-07-03 review, tracked in `docs/plans/2026-07-03-001-repo-review-implementation.md` "not in scope") — still open: live viewport resize (beyond DPI), save slots / backlog / text-speed UI. (Renderer unit tests, DPI, keyboard + ARIA floor, error boundary, remember-key landed 2026-07-03; **responsive layout + map-viewport persistence landed 2026-07-04**, superseded by the **graph-centric layout 2026-07-07**.)
- **Transitions** are a renderer-side crossfade only (instant data model; hash-neutral). Future polish: per-statement transition hints, named/custom sprite positions, sprite layering effects.
- **Version Packages PR #18 merged (`b85c622`, 2026-07-11).** It consumed the P2/P3 changesets: `@ludelier/assets` and `@ludelier/assets-node` are `0.2.0`, `@ludelier/renderer-pixi` is `0.2.1`, and the remaining nine packages are `0.3.0`. New code changes need a new changeset and Version PR.
- Switch changelog generator to `@changesets/changelog-github` once ready.
- Live-provider smoke test in CI (needs a secrets story); transcript/`raw` redaction before persisting provenance; coverage reporting; Playwright browser caching in CI.

---

## 10. Open questions / deferred decisions

- **P4 gateway strategy — RESOLVED (2026-07-12):** the first hosted slice is an EE-owned credential broker that remains the tenant authorization and authoritative metering boundary while it composes the existing provider seams directly. LiteLLM is not adopted in the first slice; it may later be an EE-only adapter after the broker's idempotent reconciliation contract is proven. See `docs/plans/2026-07-12-001-feat-p4-cloud-seam-architecture-plan.md`.
- **Asset providers beyond OpenRouter** — fal.ai (FLUX/LoRA) + ElevenLabs (voice/SFX) are planned later adapters; no delivery phase is committed.
- **Transparent sprites — RESOLVED:** resolution is model-targeted, not provider-wide. A transparent request succeeds only when its selected configured target explicitly advertises compatible alpha/background and output-format support; no opaque/deprecated fallback is implicit.
- **Editor app shell — RESOLVED (2026-06-22): React.** The editor chrome (panels/inspectors + chat) around the Pixi canvas uses React (largest ecosystem + most AI-codegen training data, aligning with the agent-grows-the-app goal) in a new `@ludelier/editor-web` (Vite + React) package binding to `@ludelier/editor-core`. The runtime-web player stays the embedded play mode.
- **Agent tool-calling — RESOLVED:** `LLMProvider` exposes OpenAI-compatible tool-calling and the agentic chat invokes registry-derived world tasks; paid host tools remain explicitly injected and authorized.
- ~~**World-API home**~~ — RESOLVED: split into `@ludelier/world` (task registry + EditLog) and `@ludelier/editor-core` (the `EditorSession` façade); `authoring` keeps only the LLM provider + agent loop.
- **Default model slugs — VERIFIED FOR OPENROUTER:** the live P2 smoke exercised `openai/gpt-5-mini`; confirm provider availability again before changing defaults.
- **Author-facing DSL** — a simpler Ren'Py-like surface that compiles down to the canonical JSON; design later.
- **Character/style consistency** strategy for AI art (per-character LoRA vs. model-native multi-subject like Nano Banana Pro) — deferred for a future content/asset iteration.

---

## 11. Known gotchas

- **WSL2 e2e connect hang (fixed):** a TCP connect to a _not-yet-bound_ loopback port hangs ~135s for **Node and Python** (curl/Chromium refuse instantly). Playwright's Node webServer probe hit this every run → "1.6s of tests, 2.3m total". **Fix:** `just e2e` starts the Vite dev server itself, health-checks via `curl --connect-timeout` (fast-fail), then runs Playwright with `E2E_EXTERNAL_SERVER=1` so it never probes a closed port (config skips its own webServer; recipe pre-cleans + kills by-port to avoid orphaned vite). **Don't** revert the e2e recipe to a Playwright-managed webServer locally. CI (Linux) is unaffected and uses `pnpm e2e`.
- Prefer `127.0.0.1` over `localhost` in local tooling/health-checks to avoid IPv6-first resolution stalls.
- Playwright visual baselines are platform-tagged (`-chromium-linux.png`) — CI must run Linux to match.
- iOS PWA storage: ~50 MB quota, 7-day eviction; call `navigator.storage.persist()` (to wire up later).

---

## 12. Git & release state

- Repo on `github.com/schlessera/ludelier`; `main` tracks `origin/main` (pushed). Identity: Alain Schlesser.
- The milestone list below intentionally ends at the early P1 e2e work. Current `origin/main` is `b85c622` after Version PR #18 consumed the completed P2/P3 changesets.

```
361783e chore: bootstrap pnpm + TypeScript monorepo
5d7c240 feat(schema): Zod-validated Story DSL with JSON Schema export
b8c9efe feat(engine): deterministic headless core
b6cfae6 feat(cli): validate/simulate/replay agent harness + example VN
00a221d chore(release): changesets (independent, version-PR only) + CI
3c3f0a2 docs: AGENTS.md project guide + CLAUDE.md pointer + README
38c571f chore: configure workspace for web runtime + e2e
43a7be1 feat(renderer-pixi): PixiJS v8 display-only renderer
1228df4 feat(runtime-web): browser player — Vite + PWA + Dexie autosave
b7d7336 test(e2e): Playwright play-through + visual regression + CI
bcafd0e chore: add justfile task runner; document as canonical entrypoint in AGENTS.md
0da7975 fix(e2e): probe IPv4 127.0.0.1 instead of localhost
50b6923 fix(e2e): manage dev server externally to dodge WSL2 loopback connect hang
27d0662 feat(runtime-web): installable PWA icons (standard + maskable)
73938ea test(e2e): cover advance + choice via real canvas clicks
```

- Version state after PR #18: `@ludelier/assets` and `@ludelier/assets-node` are `0.2.0`, `@ludelier/renderer-pixi` is `0.2.1`, and the remaining nine private packages are `0.3.0`. Future code changes accumulate through new changesets and the next Version PR.

---

## 13. Pre-public-launch checklist

- [ ] Register `ludelier.com` + `.io` / `.ai`.
- [ ] Human USPTO + EUIPO trademark search; file in classes 9 / 41 / 42.
- [x] Push to remote (`github.com/schlessera/ludelier`, `main` tracks `origin/main`). _Still: enable GitHub Actions to create PRs + read/write permissions._
- [ ] Before first npm publish: drop `private`, add `publishConfig.access: public`, set `access: public` in changesets config, add a build step, enable the `publish:` input in `release.yml` (prefer OIDC trusted publishing).
- [ ] Add a brand style guide noting the _luder_ connotation for Scandinavian/German markets.
