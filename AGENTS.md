# AGENTS.md — Ludelier

Canonical context + conventions for any AI agent (or human) working in this repo. Read this fully before making changes.

## What this is

**Ludelier** is a TypeScript, web-first engine + editor + runtime for **AI-augmented game development**. Initial scope: interactive visual novels (Ren'Py-style); open to other game types later. The whole point is that AI agents can reliably **grow and maintain** a game with no manual steps where avoidable.

Business model: open-core **MIT** engine (bring-your-own-key AI, self-hostable) + a planned hosted **cloud** tier (paid usage + hosting). Cloud-only code will live under `/ee` (commercial license).

> Name note: "Ludelier" is the chosen name (ludo "play" + atelier "workshop"). The working title was **gaimez** — the directory may still be `gaimez` until renamed to `ludelier`.

## Golden rules (do not violate)

1. **TypeScript strict, end-to-end.** The compiler is the tightest feedback loop; keep `pnpm typecheck` green.
2. **Determinism is sacred.** Same story + seed + actions ⇒ identical state (byte-stable hash). Therefore:
   - **Never call `Math.random` in game logic.** Use the seeded PRNG in `packages/engine/src/rng.ts`; thread RNG state through state.
   - **Sort by a stable id before any order-sensitive iteration.** Unordered iteration is the #1 determinism bug.
3. **Game content is plain data validated by Zod** (`packages/schema`). The engine **never `eval`s** authored logic. AI-authored content passes through `validateStory()` as a guardrail.
4. **Three-layer separation:** pure logic / state / renderer. Logic + state must be testable in Vitest **without a browser**.
5. **Every code change ships with a changeset** (`pnpm changeset`). CI enforces it.
6. **Do not publish to npm.** Packages are `private: true` and pre-release; changesets versions them locally only (see Versioning).

## Repo layout (pnpm workspaces monorepo)

```
packages/
  schema/   @ludelier/schema — Zod = single source of truth for game content.
            Story DSL (nodes of statements), validateStory() (shape + cross-ref),
            storyJsonSchema() (JSON Schema export to constrain LLM output).
  engine/   @ludelier/engine — pure deterministic core. Redux-style reducer,
            seeded RNG (rng.ts), stable-key hash (hash.ts), headless Simulation
            runner + JSONL trace record/replay (simulation.ts). No engine/DOM deps.
  cli/      @ludelier/cli — the agent harness. `validate | simulate | replay`.
examples/   cafe.story.json + cafe.actions.json (sample VN).
.changeset/ changesets config + pending changesets.
.github/    release.yml (Version-PR flow) + changeset-check.yml (PR gate).
```

Internal deps use `workspace:*` (`engine` → `schema`, `cli` → both).

## Commands

Tasks are run with **[`just`](https://github.com/casey/just)** — the canonical entrypoint (`justfile` at the repo root). Run `just` with no args to list every recipe (grouped, with one-line docs). Recipes are thin wrappers over the pnpm scripts, so `pnpm <script>` still works directly.

```bash
just              # list all recipes (grouped: setup / dev / quality / release / meta)
just setup        # install deps + Playwright Chromium (first-time bootstrap)
just demo         # play the example story headlessly via the CLI
just dev          # web player dev server (Vite)
just check        # fast gate: typecheck + unit tests + web build (no browser)
just ci           # full gate incl. Playwright e2e
just cli validate examples/cafe.story.json   # the agent harness; args forwarded
just test [args]  # Vitest (units + replay determinism); just e2e for Playwright
just changeset    # author a changeset (required with code changes)
just version      # consume changesets: bump versions + CHANGELOGs + refresh lockfile
```

When adding a new common task, add a `just` recipe for it (with a `# doc comment` and a `[group(...)]`); keep `justfile` formatted via `just fmt` (CI-checkable with `just fmt-check`). If you don't have `just`, run the underlying `pnpm` script the recipe wraps.

Toolchain: Node ≥20 (CI uses 22, see `.nvmrc`), pnpm 10.32, Zod 4, Vitest 2, tsx, Vite 5 + vite-plugin-pwa, PixiJS 8, Dexie, Playwright. `just build` / `pnpm build:web` bundles the web player; the engine/schema/cli still run as TS directly via tsx/vitest (no build step).

## The agent harness (this is the product)

The engine exposes a programmatic surface so an agent can grow/verify a game with no DOM:
- `validateStory(data)` → Zod + cross-reference errors (gate on AI-generated content).
- `new Simulation(story, {seed}).run(actions)` → final state; `.hash()` → stable hash; `.transcript()`.
- `Simulation.record(actions)` → JSONL trace; `replayTrace(story, jsonl, {seed})` → asserts hash per step (regression tests from recorded sessions).

Invest in this surface, not in renderer cleverness.

## Versioning (changesets)

[changesets](https://github.com/changesets/changesets), **independent** per package, **Version-PR only — no npm publish yet**. Packages stay `private: true`, so changesets versions + writes changelogs but skips publish. On push to `main`, `release.yml` opens a "Version Packages" PR; merging applies bumps. To enable publishing later, follow the header in `.github/workflows/release.yml` (drop `private`, set `publishConfig.access: public`, add a build step, enable the `publish:` input with OIDC trusted publishing).

`changeset status` needs a git repo with a `main` branch — initialize with `git init -b main`.

## Phase roadmap

- **P0 — DONE:** headless deterministic core + Zod DSL + CLI harness + Vitest. (current)
- **P1:** PixiJS v8 renderer + Vite + vite-plugin-pwa shell + Howler audio + Dexie saves + Playwright visual tests (`--use-gl=swiftshader`, `data-ready` flag). Make `cafe.story.json` play in a browser.
- **P2:** AI authoring — OpenRouter LLM adapter generates Zod-valid content + self-correction loop.
- **P3:** AI asset generation (OpenRouter BYOK v1) + provenance pipeline (prompt/model/seed sidecars, hash-cache).
- **P4:** cloud seam — self-host BYOK config ↔ metered cloud per-tenant keys. AI-gateway tool choice is deferred (not locked).

## Locked stack decisions

Renderer PixiJS v8 (WebGL2 primary, WebGPU opt-in) · build Vite + vite-plugin-pwa (injectManifest, two-tier cache) · audio Howler.js · saves Dexie.js (→ Dexie Cloud for sync upsell) · content Zod (JSON canonical; author DSLs compile down to JSON later) · tests Vitest + Playwright · assets v1 OpenRouter-only BYOK behind an `AssetProvider` interface (fal.ai/ElevenLabs are later drop-ins) · license MIT + `/ee`.
