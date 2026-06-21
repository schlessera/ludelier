---
"@ludelier/editor-web": minor
---

Embed the live Pixi play preview in the editor, closing the edit → see loop.

- New `PlayCanvas` mounts the display-only `@ludelier/renderer-pixi` renderer and replays the session's current story (from its start) on every edit — background, sprites, dialog, and choices render live beside the editing surface. Advancing/choosing drives a throwaway `Simulation`, never the authored story. The renderer lifecycle is StrictMode-safe (destroy is deferred until async `mount()` completes). Assets are served from the shared `runtime-web/public` (`publicDir`), loaded once and reused across replays.
- Replaced the `+ Node` `prompt()`/`alert()` with an inline node-id input + inline error (better UX; no blocking dialogs).

Verified in a headless browser: renders the café scene; a manual `create-node` updates the node list, graph-health (flags the new node unreachable + dead end), history, and the preview live; undo reverts it; clean load reports no console errors.
