# ludelier

Tech stack / framework / runtime for **AI-augmented game development**. Initial scope: web-based interactive visual novels (Ren'Py-style), built so AI agents can grow and maintain a game with no manual steps.

This is **P0 — the headless deterministic core + agent harness**. No rendering yet. The point of P0 is to prove the two properties everything else depends on:

1. **Determinism** — same story + same seed + same actions ⇒ identical state (byte-stable hash).
2. **An agent harness** — validate / simulate / replay content as plain data, no browser, no DOM.

## Layout

```
packages/
  schema/   Zod = single source of truth for game content. JSON canonical.
            validateStory() (parse + cross-reference checks) + JSON Schema export.
  engine/   Pure logic. Redux-style reducer, seeded RNG (injected), headless
            Simulation runner, JSONL trace record/replay. No engine/DOM deps.
  cli/      Agent + human entry point: validate | simulate | replay.
examples/   cafe.story.json (canonical JSON content) + cafe.actions.json
```

## Quickstart

```bash
pnpm install
pnpm test          # vitest: determinism, conditional choices, replay
pnpm typecheck     # tsc --noEmit, strict

# agent harness (the product surface):
pnpm cli validate examples/cafe.story.json
pnpm cli simulate examples/cafe.story.json --actions examples/cafe.actions.json --seed 42
pnpm cli replay   examples/cafe.story.json <trace.jsonl> --seed 42
```

## Design rules (locked)

- **TypeScript strict** end-to-end (tightest AI-codegen feedback loop).
- **No `Math.random` in logic** — all randomness via injected seeded PRNG (`packages/engine/src/rng.ts`, mulberry32).
- **Sort by stable id** before any order-sensitive iteration (determinism).
- **Content is plain data** validated by Zod; the engine never `eval`s authored logic.
- Author-facing DSLs (Ren'Py-like) come later and compile **down to this JSON**.

## Versioning (changesets)

Versions + changelogs are managed with [changesets](https://github.com/changesets/changesets), **independent** per package.

```bash
pnpm changeset          # author a changeset for your change (pick packages + bump level)
pnpm changeset:status   # see what's pending since main
pnpm version            # consume changesets -> bump versions + write CHANGELOGs + refresh lockfile
```

Day-to-day: every code PR includes a `.changeset/*.md` file (CI enforces it; use `pnpm changeset --empty` for no-release changes). On push to `main`, the **Release** workflow opens a "Version Packages" PR; merging it applies the bumps.

Currently **version-PR only — nothing publishes to npm**. Packages are `"private": true` (changesets still versions them + writes changelogs, just skips publish). To go public later: drop `"private"`, add `publishConfig.access: "public"`, set `access: "public"` in `.changeset/config.json`, add a build step, and enable the `publish:` input in `.github/workflows/release.yml` (see header there). Prefer npm OIDC trusted publishing over a long-lived token.

## Not yet (later phases)

- P1 renderer (PixiJS v8) + Vite PWA shell + Playwright visual tests
- P2 AI authoring (OpenRouter LLM → Zod-valid content, self-correction loop)
- P3 AI asset generation + provenance pipeline
- P4 cloud seam (BYOK self-host ↔ metered cloud) — gateway choice still open

License: MIT (open core). Cloud-only features will live under `/ee` (commercial).
