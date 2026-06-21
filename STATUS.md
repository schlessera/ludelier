# Ludelier — Project Status & Handoff

_Last updated: 2026-06-21_

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
| Audio | **Howler.js** — deferred to P3 (no assets yet) |
| Assets (v1) | **Multi-provider** behind an `AssetProvider` interface — **OpenAI + OpenRouter** from the start, **BYOK per provider**, capability-routed (transparency → a provider that supports it, e.g. OpenAI `gpt-image-1.5`). fal.ai / ElevenLabs are later drop-ins via a provider registry. Provenance sidecars `{provider,model,prompt,seed,params,cost,hash}` + hash-cache |
| AI authoring (P2) | **Multi-provider `LLMProvider`** (OpenAI + OpenRouter, shared OpenAI-compatible core, BYOK per provider) + `generateStory()` self-correction loop; evolving into a **world API** (understand + manipulate tasks over the Story) exposed as LLM tools for the editor's agentic chat |
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
  cli/            @ludelier/cli    — validate | simulate | replay | world … | author run (the agent harness)
  authoring/      @ludelier/authoring — P2: LLMProvider (+tool-calling) + generateStory() loop + worldTools/dispatch + runAgent
  renderer-pixi/  @ludelier/renderer-pixi — PixiJS v8 display-only renderer
  runtime-web/    @ludelier/runtime-web   — Vite + PWA player, Dexie autosave, window.__ludelier
examples/         cafe.story.json + cafe.actions.json
.agents/skills/   checked-in agent skills (image-generation)
.changeset/       changesets config + pending changesets
.github/workflows/ release.yml (Version PR), changeset-check.yml (PR gate), ci.yml (typecheck/unit/build + e2e)
justfile          canonical task runner
AGENTS.md         conventions + golden rules (CLAUDE.md imports it)
```

Toolchain: Node ≥20 (CI 22, `.nvmrc`), pnpm 10.32, Zod 4, Vitest 2, Vite 5, PixiJS 8, Dexie 4, Playwright, tsx.

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
- **`@ludelier/schema`** — Story = nodes of statements (`say`/`set`/`add`/`roll`/`choice`/`jump`/`end`), discriminated union on `op`. `validateStory()` = Zod shape + cross-reference checks (unique ids, gotos resolve, start exists). `storyJsonSchema()` exports JSON Schema for LLM constraint.
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

### P2 — AI authoring + agent world API 🔨 (in progress)
- **`@ludelier/authoring`** (first slice) — `LLMProvider` seam mirroring `AssetProvider` (OpenAI + OpenRouter over a shared OpenAI-compatible core; BYOK-per-provider registry) + `generateStory()`: a provider-agnostic **self-correction loop** that constrains output with `storyJsonSchema()`, validates with `validateStory()`, and feeds issues back until valid or attempts exhausted. Hermetic mock-provider / fake-fetch tests.
- **World API & agent harness — slice 1 ✅ (2026-06-21):** new pure **`@ludelier/world`** package — self-describing task registry (`describe()` manifest derives CLI subcommands + LLM tools), 9 understand tasks + a 12-command flattened manipulate spine through an always-valid `applyEdit` (validateStory + world-local `say.who` check), event-sourced `EditLog` (linear-history undo/redo, contiguous-tail `revertRun`, JSONL replay), `{success}` envelope, canonical `hashStory`. `@ludelier/authoring` gained provider tool-calling + a `worldTools`/`dispatch` adapter + the autonomous `runAgent` loop (self-verify, partial-run aware, hermetic via scripted provider). `@ludelier/cli` gained registry-derived `world …` subcommands + `author run` (entrypoint refactored to a testable `run(argv)`). 60 unit tests across world/authoring/cli; `just check` green. Plan: `docs/plans/2026-06-19-001-feat-world-api-agent-harness-plan.md` (deepened + reviewed; units U1–U12).
- **Next:** the **editor agentic-chat UI** (runtime-web player → editor) wiring the world API to the chat panel + inspectors; deferred manipulate commands (additive registry entries); a live-LLM smoke test (BYOK).

### Tooling ✅
- changesets (independent, version-PR only); `release.yml` + `changeset-check.yml`.
- `justfile` task runner; `AGENTS.md` + `CLAUDE.md`.
- Fixed a WSL2 e2e wall-clock issue (2:17 → ~2s) — see §11.

---

## 7. Verification status (as of last run)

- `pnpm typecheck` — clean (tsc strict).
- `pnpm test` — 38/38 unit tests pass (+ `@ludelier/authoring`: self-correction loop + OpenAI/OpenRouter provider tests).
- `pnpm build:web` — OK (PixiJS bundle + PWA SW, 19 precache entries incl. webp art, icons in manifest).
- `just e2e` — 3/3 pass, ~4–6s (opening frame now renders the café bg + character sprite).

---

## 8. Roadmap

| Phase | Status | Scope |
|---|---|---|
| **P0** headless core | ✅ done | engine + schema + CLI harness + Vitest |
| **P1** render + play | ✅ done | PixiJS renderer, Vite/PWA shell, Dexie saves, Playwright, **backgrounds + character sprites** (scene/show/hide + crossfades) |
| **P2** AI authoring + world API | 🔨 in progress | multi-provider LLM adapter (OpenAI + OpenRouter) + self-correction loop **[done]**; understand/manipulate world API + registry + agent loop + CLI surface **[done, slice 1]**; editor agentic chat (next) |
| **P3** AI assets | ⬜ | image/TTS gen behind a **multi-provider `AssetProvider`** (OpenAI + OpenRouter v1, BYOK per provider, capability-routed), provenance pipeline, Howler audio |
| **P4** cloud seam | ⬜ | self-host BYOK config ↔ metered cloud per-tenant keys (gateway tool not yet chosen) |

---

## 9. Open tasks / TODO

- **P2 world API (slice 1 ✅ done):** `@ludelier/world` shipped — understand + manipulate tasks through a self-describing registry + always-valid `applyEdit` + event-sourced `EditLog`, exposed as LLM tools (`worldTools`/`dispatch` + `runAgent`) and registry-derived CLI subcommands. **Next:** wire the editor agentic chat (runtime-web → editor) to the world API; add the deferred manipulate commands (rename/update/move/remove variants, choice-option ops) as additive registry entries; bounded `simulate` all-paths.
- **P2 validation (next):** live smoke test of `generateStory()` against a real provider/model (BYOK) + a CLI `author` command. Needs a current model slug (e.g. OpenRouter `openai/gpt-5-mini`).
- ~~Backgrounds + character sprites~~ ✅ **done** — `scene`/`show`/`hide` + central `assets`, persistent `stage` in the hash, renderer preload + cover-fit bg + bottom-anchored sprites + crossfades. Demo art is committed under `runtime-web/public/assets/cafe/` (generated via the `image-generation` skill).
- **Transitions** are a renderer-side crossfade only (instant data model; hash-neutral). Future polish: per-statement transition hints, named/custom sprite positions, sprite layering effects.
- Consume pending changesets via the first Version PR → bumps all packages to **0.1.0** (currently all `0.0.0`). Pending: `p0-initial-core` (minor ×3), `p1-web-player` (renderer+runtime minor), `p1-pwa-icons` (runtime patch), `p1-scenes-sprites` (schema/engine/renderer/runtime minor, cli patch), `p2-authoring` (authoring minor).
- Switch changelog generator to `@changesets/changelog-github` once on GitHub.
- Add `just fmt-check` (and optionally `just`) to CI, if desired (needs installing `just` on the runner).
- No linter/formatter configured yet (no ESLint/Prettier) — add if wanted.
- Move working directory `gaimez` → `ludelier` (deferred; user does between sessions).

---

## 10. Open questions / deferred decisions

- **P4 AI gateway tool** — NOT chosen. LiteLLM is a research candidate but explicitly deferred. Concept is locked (self-host BYOK config ↔ cloud metered per-tenant keys → usage billing; metering boundary = per-tenant key; monetize workflow + hosting, never the copyable artifact). Decide later.
- **Asset providers beyond OpenRouter** — fal.ai (FLUX/LoRA) + ElevenLabs (voice/SFX) are the planned adapters; timing TBD (likely P3).
- **Transparent sprites — RESOLVED (2026-06-18, see §2):** `AssetProvider` is **multi-provider**, so transparency is a routing decision, not a gap. OpenAI (`gpt-image-1.5`/`gpt-image-1`) supplies native transparency; OpenRouter covers everything else (and Sourceful riverflow-v2.5 if transparency is wanted on that path). The resolver routes a transparent request to a capable configured provider — no single-provider lock, no keying fallback needed when OpenAI is configured.
- **Editor app shell** — the editor chrome (panels/inspectors + chat) around the Pixi canvas: plain DOM/Web Components vs a UI framework (React/Svelte/Solid)? Not chosen. The runtime-web player stays the embedded play mode.
- **Agent tool-calling** — extend `LLMProvider` with function/tool-calling (OpenAI-compatible `tools`/`tool_calls`) so the agentic chat invokes world-API tasks; define the tool schemas + the agent loop (where it runs — client-side BYOK first).
- **World-API home** — `@ludelier/authoring` vs a dedicated `@ludelier/world` / `editor-core` package. Lean toward a split once the manipulate surface grows.
- **Default model slugs** — `providersFromEnv()` defaults (`gpt-5-mini`, `openai/gpt-5-mini`) are unverified placeholders; confirm current slugs at the live smoke test.
- **Author-facing DSL** — a simpler Ren'Py-like surface that compiles down to the canonical JSON; design later.
- **Character/style consistency** strategy for AI art (per-character LoRA vs. model-native multi-subject like Nano Banana Pro) — revisit at P3.

---

## 11. Known gotchas

- **WSL2 e2e connect hang (fixed):** a TCP connect to a _not-yet-bound_ loopback port hangs ~135s for **Node and Python** (curl/Chromium refuse instantly). Playwright's Node webServer probe hit this every run → "1.6s of tests, 2.3m total". **Fix:** `just e2e` starts the Vite dev server itself, health-checks via `curl --connect-timeout` (fast-fail), then runs Playwright with `E2E_EXTERNAL_SERVER=1` so it never probes a closed port (config skips its own webServer; recipe pre-cleans + kills by-port to avoid orphaned vite). **Don't** revert the e2e recipe to a Playwright-managed webServer locally. CI (Linux) is unaffected and uses `pnpm e2e`.
- Prefer `127.0.0.1` over `localhost` in local tooling/health-checks to avoid IPv6-first resolution stalls.
- Playwright visual baselines are platform-tagged (`-chromium-linux.png`) — CI must run Linux to match.
- iOS PWA storage: ~50 MB quota, 7-day eviction; call `navigator.storage.persist()` (to wire up later).

---

## 12. Git & release state

- Repo on `github.com/schlessera/ludelier`; `main` tracks `origin/main` (pushed). Identity: Alain Schlesser.
- History (oldest → newest) below ends at the P1 e2e work; **HEAD is well ahead** (`origin/main` @ `22023c1`, pushed) and additionally includes: the STATUS doc, **P1 backgrounds + sprites** (scene/show/hide + crossfades + committed café art), the **`image-generation`** agent skill + OpenRouter caveat, the **multi-provider `AssetProvider`** plan, **P2 `@ludelier/authoring`** (LLM provider seam + self-correction loop), and the **agent-native editor** vision docs:

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

- All packages at `0.0.0` (pre-release, `private: true`). First Version PR will bump to `0.1.0`.

---

## 13. Pre-public-launch checklist

- [ ] Register `ludelier.com` + `.io` / `.ai`.
- [ ] Human USPTO + EUIPO trademark search; file in classes 9 / 41 / 42.
- [x] Push to remote (`github.com/schlessera/ludelier`, `main` tracks `origin/main`). _Still: enable GitHub Actions to create PRs + read/write permissions._
- [ ] Before first npm publish: drop `private`, add `publishConfig.access: public`, set `access: public` in changesets config, add a build step, enable the `publish:` input in `release.yml` (prefer OIDC trusted publishing).
- [ ] Add a brand style guide noting the _luder_ connotation for Scandinavian/German markets.
