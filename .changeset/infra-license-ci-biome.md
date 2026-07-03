---
---

Repo infrastructure from the 2026-07-03 review (no package behaviour changes):

- **MIT `LICENSE` file** — README/AGENTS claimed MIT with no license file (a public-launch blocker).
- **CI hardening** — the check job now runs `pnpm build:editor` (previously editor-web's `.tsx` was never typechecked in CI: the root tsconfig includes only `*.ts` and only the editor build checks TSX) and `pnpm lint`; a new `fmt` job gates `just fmt-check`.
- **Biome** (lint + format, one fast tool) added repo-wide: `just lint` / `just lint-fix`, wired into `just check` and CI. Config matches the existing style (2-space, double quotes, 110 columns); repo formatted once; deliberate React hook dependency choices are annotated with explained `biome-ignore`s; all interactive buttons gained explicit `type="button"` (they defaulted to form-submit).
- **`.gitignore`** now covers `.env`/`.env.*`/`*.local` (the justfile `dotenv-load`s an `.env` for BYOK keys — accidental-commit risk) plus IDE state dirs.
