# Contributing to Ludelier

Thanks for your interest! This page covers the mechanics of getting a change landed.
The project's context, architecture, and non-negotiable conventions live in
**[AGENTS.md](./AGENTS.md)** — read it first; it applies to humans and AI agents alike.

## Setup

Requirements: Node ≥ 20 (CI runs 22, see `.nvmrc`), [pnpm](https://pnpm.io) 10.x, and
[`just`](https://github.com/casey/just) (the canonical task runner — every workflow below
has a `just` recipe; run `just` with no arguments to list them all).

```bash
just setup    # pnpm install + Playwright Chromium (first-time bootstrap)
just demo     # sanity check: play the example story headlessly via the CLI
just dev      # web player dev server
just dev-editor  # the agent-native editor
```

## Making a change

1. Branch off `main`.
2. Keep the golden rules (AGENTS.md) — the short version: strict TypeScript everywhere,
   never `Math.random` in game logic, content stays Zod-valid, logic/state stay
   browser-free and Vitest-testable.
3. Run the gates locally:

```bash
just check    # typecheck + unit tests + web & editor builds (fast, no browser)
just e2e      # Playwright end-to-end (WSL2 users: use this recipe, not raw playwright)
just fmt-check  # justfile formatting (CI-enforced)
```

4. **Add a changeset — every code change needs one** (CI blocks PRs without it):

```bash
just changeset          # pick the affected packages + bump levels, write a summary
pnpm changeset --empty  # escape hatch for changes with no releasable effect
```

Write the summary value-first: what a consumer of the package gains or is protected
from, not a list of files. See `.changeset/*.md` in history for the house style.

5. Open a PR against `main`. CI runs typecheck, unit tests, both web builds, formatting,
   and the Playwright suite (visual baselines are Linux-tagged; if your change legitimately
   alters the rendered frame, regenerate with `just e2e-update` and commit the PNG).

## Releases

Versioning is [changesets](https://github.com/changesets/changesets)-driven and
Version-PR-only: merging to `main` updates a "Version Packages" PR; merging that PR
applies the bumps and changelogs. Nothing publishes to npm yet (packages are
`private: true`, pre-release) — see the header of `.github/workflows/release.yml`
for what enabling publish will take.

## Reporting issues / security

Bugs and feature requests: GitHub issues. For anything security-sensitive, email the
maintainer (see `package.json` author / commit identity) rather than filing publicly.
