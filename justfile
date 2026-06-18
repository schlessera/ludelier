# Ludelier task runner. Run `just` (or `just --list`) to see all recipes.
# Docs: https://just.systems/man/en/
# ── Settings ──────────────────────────────────────────────────────────────
# Strict bash for every recipe line: exit on error, unset vars, pipe failures.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Load a local .env if present (e.g. BYOK provider keys later). Missing file is fine.

set dotenv-load := true

# Make local binaries (vitest, tsc, playwright, changeset) reachable without ./node_modules/.bin.

export PATH := justfile_directory() / "node_modules/.bin:" + env_var('PATH')

# ── Meta ──────────────────────────────────────────────────────────────────

# List all recipes (default when you run bare `just`).
default:
    @{{ just_executable() }} --list

# ── Setup ─────────────────────────────────────────────────────────────────

# Install all workspace dependencies.
[group('setup')]
install:
    pnpm install

# Full bootstrap: deps + the Playwright Chromium browser (needed for `just e2e`).
[group('setup')]
setup: install
    pnpm exec playwright install chromium

# Remove build/test artifacts (keeps node_modules).
[group('setup')]
clean:
    rm -rf packages/*/dist dev-dist test-results playwright-report coverage

# ── Dev ───────────────────────────────────────────────────────────────────

# Run the web player dev server (Vite).
[group('dev')]
dev:
    pnpm dev:web

# Run the CLI harness. e.g. `just cli validate examples/cafe.story.json`
[group('dev')]
cli *args:
    pnpm cli {{ args }}

# Play the example story headlessly through the CLI (good ending path).
[group('dev')]
demo:
    pnpm cli simulate examples/cafe.story.json --actions examples/cafe.actions.json --seed 42

# Build the web player for production.
[group('dev')]
build:
    pnpm build:web

# ── Quality ───────────────────────────────────────────────────────────────

# Type-check the whole workspace (tsc --noEmit, strict).
[group('quality')]
typecheck:
    pnpm typecheck

# Run unit tests (Vitest). Forwards args: `just test --watch`
[group('quality')]
test *args:
    pnpm test {{ args }}

# Run Playwright e2e (boots the dev server + Chromium). `just test` for units.
[group('quality')]
e2e *args:
    pnpm e2e {{ args }}

# Regenerate Playwright visual baselines (commit the result).
[group('quality')]
e2e-update:
    pnpm exec playwright test --update-snapshots

# Fast pre-push gate: types + units + web build (no browser).
[group('quality')]
check: typecheck test build

# Full gate incl. browser e2e (mirrors CI).
[group('quality')]
ci: check e2e

# ── Release (changesets) ────────────────────────────────────────────────────

# Author a changeset for your change (required with code changes).
[group('release')]
changeset:
    pnpm changeset

# Show pending changesets since main.
[group('release')]
changes:
    pnpm changeset:status

# Consume changesets: bump versions + write CHANGELOGs + refresh lockfile.
[group('release')]
version:
    pnpm version

# Publish to npm. OFF until packages go public (see release.yml header).
[confirm('Publishing is disabled until packages are public. Continue anyway?')]
[group('release')]
release:
    pnpm release

# ── Justfile maintenance ────────────────────────────────────────────────────

# Format this justfile in place.
[group('meta')]
fmt:
    {{ just_executable() }} --fmt --unstable

# Check this justfile is formatted (CI).
[group('meta')]
fmt-check:
    {{ just_executable() }} --fmt --check --unstable
