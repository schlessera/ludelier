# Ludelier (WIP)

A TypeScript, web-first **engine + agent-native editor + runtime for AI-augmented game development**. Initial scope: interactive visual novels (Ren'Py-style), built so AI agents can reliably **grow and maintain** a game — with a human co-building in the same environment.

Three properties everything rests on:

1. **Determinism** — same story + same seed + same actions ⇒ identical state (byte-stable hash). Recorded playthroughs replay as regression tests, so AI-authored content is *verifiable*, not just plausible.
2. **Always-valid content** — a game is plain JSON validated by Zod (shape + cross-references). Every edit — human form, agent tool call, or CLI — passes the same validation chokepoint; the story can never be left broken.
3. **Agent-native parity** — one self-describing task registry ("understand" the world: graph, validate, simulate, explore; "manipulate" it: validated structured edits) drives the editor UI, the agentic chat's LLM tools, the CLI, *and* an MCP server. No human-only or agent-only escape hatches.

## What works today

- **Play**: `examples/cafe.story.json` runs in the browser as an installable PWA — PixiJS v8 renderer (backgrounds, character sprites, crossfades), Dexie autosave, and a `window.__ludelier` handle so agents can drive the player too.
- **Edit**: a React editor built around the story graph (React Flow canvas flanked by a collapsible agent-chat dock and a tabbed inspector) — script lens, on-demand play preview (pops out for multi-monitor use), manifest-derived edit forms, story open/save, undo/redo over an event-sourced edit log, and **static (`graph`) + runtime (`explore`) story-health** surfaced side by side — plus a built-in **agentic chat** (BYOK OpenRouter) whose edits join the same undoable history, gated by the same graph-health self-verification the editor shows.
- **Automate**: a CLI (`validate | simulate | replay | world … | author run`) and `ludelier mcp <story>` — an MCP stdio server exposing the full world API to Claude Code, Cursor, or any MCP client, with edits persisted atomically back to the story file.

## Quickstart

Tasks run through [`just`](https://github.com/casey/just) (run bare `just` to list everything); recipes wrap pnpm scripts if you prefer those.

```bash
just setup        # pnpm install + Playwright Chromium
just demo         # play the example story headlessly via the CLI
just dev          # browser player (Vite dev server)
just dev-editor   # the agent-native editor
just check        # typecheck + lint + unit tests + web/editor builds
just e2e          # Playwright end-to-end (visual baselines, real canvas clicks)
```

The agent harness — the surface everything else is built on:

```bash
just cli validate examples/cafe.story.json
just cli simulate examples/cafe.story.json --actions examples/cafe.actions.json --seed 42
just cli world describe                      # the self-describing task manifest
just cli mcp examples/cafe.story.json        # serve the world API over MCP (stdio)
just cli author run examples/cafe.story.json --prompt "…"   # autonomous agent run (BYOK)
```

## Layout

```
packages/
  schema/        Zod Story DSL (single source of truth), validateStory(), JSON Schema export
  engine/        pure deterministic core: reducer, seeded RNG, stable hash, Simulation, replay
  world/         the agent world API: task registry → describe(), understand + manipulate
                 tasks through an always-valid applyEdit, event-sourced EditLog
  cli/           validate | simulate | replay | world … | author run | mcp
  authoring/     LLM layer: OpenAI/OpenRouter providers (BYOK), generateStory() self-correction
                 loop, runAgent (run-until-done, verification gate, streaming)
  editor-core/   headless EditorSession — the parity façade the UI and the chat both drive
  editor-web/    React editor: story map + script lens + play preview + edit forms + agent chat
  renderer-pixi/ display-only PixiJS v8 renderer
  runtime-web/   Vite + PWA browser player with Dexie autosave
examples/        cafe.story.json + cafe.actions.json (exercises every statement kind)
```

Full conventions, golden rules, and architecture context: **[AGENTS.md](./AGENTS.md)** (written for AI agents and humans alike). Project status and roadmap: **[STATUS.md](./STATUS.md)**. Contributing mechanics: **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Design rules (locked)

- **TypeScript strict** end-to-end (tightest AI-codegen feedback loop).
- **No `Math.random` in game logic** — all randomness via the injected seeded PRNG (mulberry32).
- **Sort by stable id** before any order-sensitive iteration (determinism).
- **Content is plain data** validated by Zod; the engine never `eval`s authored logic.
- **Every code change ships with a changeset**; logic and state stay testable without a browser.
- Author-facing DSLs (Ren'Py-like) come later and compile **down to this JSON**.

## Versioning (changesets)

Versions + changelogs are managed with [changesets](https://github.com/changesets/changesets), **independent** per package.

```bash
just changeset          # author a changeset for your change (pick packages + bump level)
just changes            # see what's pending since main
just version            # consume changesets → bump versions + write CHANGELOGs
```

Every code PR includes a `.changeset/*.md` file (CI enforces it; `pnpm changeset --empty` for no-release changes). On push to `main`, the **Release** workflow maintains a "Version Packages" PR; merging it applies the bumps.

Currently **version-PR only — nothing publishes to npm**. Packages are `"private": true`. To go public later: drop `"private"`, add `publishConfig.access: "public"`, set `access: "public"` in `.changeset/config.json`, add a build step, and enable the `publish:` input in `.github/workflows/release.yml` (see header there). Prefer npm OIDC trusted publishing over a long-lived token.

## Roadmap

- **P0 ✅** headless deterministic core + Zod DSL + CLI harness
- **P1 ✅** PixiJS renderer, PWA player, saves, Playwright visual tests
- **P2 ✅** AI authoring + the agent world API: multi-provider LLM adapter + self-correction, understand/manipulate registry, run-until-done agent loop, React editor + agentic chat, manifest-driven forms, MCP server, static + runtime health
- **P3 ✅** Multi-provider AI generation — OpenAI image/TTS plus OpenRouter images, BYOK, and capability routing — with redacted provenance + verified persistence, authorized CLI/MCP/editor/agent workflows, and deterministic Howler audio — [technical plan](./docs/plans/2026-07-10-001-p3-ai-assets-plan.md)
- **P4 🔜** Cloud seam (BYOK self-host ↔ metered per-tenant provider keys). The first slice is an EE-owned credential broker over existing provider seams; LiteLLM remains a deferred optional EE adapter — [architecture plan](./docs/plans/2026-07-12-001-feat-p4-cloud-seam-architecture-plan.md)

License: [MIT](./LICENSE) (open core). Cloud-only features will live under `/ee` (commercial).
