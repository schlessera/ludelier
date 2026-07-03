---
---

CI/test tooling (no package behaviour changes): Vitest v8 coverage (`just coverage` — source-only, text + HTML report, no thresholds yet) and CI now caches the Playwright Chromium download keyed on the lockfile (OS deps still install every run).
