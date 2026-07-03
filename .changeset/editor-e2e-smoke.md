---
"@ludelier/editor-web": patch
---

Playwright smoke coverage for the editor shell: a second `editor` e2e project (port 5180, same SwiftShader Chromium) drives the real UI end-to-end — load (valid badge + café title), story map nodes with start/unreachable/dead-end badges, click-to-open script lens, toolbar create-node + undo, a manifest-driven `set-meta` form edit that updates the toolbar title, and the live play-preview canvas.

- **Functional-only, concrete waits.** No visual baseline (the Pixi canvas is visually covered by runtime-web); every wait is a real signal — a new `data-ready` flag flips after the shell's first render, everything else waits on selectors/text, never timeouts.
- **Minimal stable hooks** added to the shell: `data-testid` on the validity badge, story title, new-node input, map nodes (`map-node-<id>`), and the script lens.
- **Both server-management paths covered:** `just e2e` now starts + curl-health-checks both dev servers and cleans up by port (the WSL2 connect-hang pattern, STATUS §11); CI keeps plain `pnpm e2e` via Playwright's `webServer` array.
