---
"@ludelier/renderer-pixi": minor
"@ludelier/runtime-web": minor
"@ludelier/editor-web": patch
---

Repo-review correctness batch (presentation): character names/colors render, asset failures surface, saves invalidate, preview error recovery, reachable checkpoints.

Five fixes from the 2026-07-03 repo review (see `docs/plans/2026-07-03-001-repo-review-implementation.md`):

- **Dialog shows the declared character, not its id.** The engine's `pending.who` is the character *id*; the renderer displayed it verbatim in one hardcoded blue, so the schema's `Character.name`/`color` were dead at runtime ("narrator" instead of "Narrator", no per-character colors). New `PixiRenderer.setCharacters()` declares the cast; dialog resolves id → display name + color (fallback unchanged). The player wires it at startup, the editor preview re-wires per edit. Visual baseline regenerated.
- **Asset-load failure shows the error overlay.** `renderer.mount()`/`preload()` ran outside the player's try/catch — a 404'd asset was an unhandled rejection with neither `data-ready` nor `data-error` ever set. Both now route through the recoverable `fatal()` overlay.
- **Saves are bound to their story.** A resumed save was restored blindly; with the PWA auto-updating underneath saved games, a changed story could strand the cursor on a node that no longer exists. Save rows now carry a story fingerprint (`hashState(story)`) + a `SAVE_VERSION`; a mismatch (including all pre-existing rows) is treated as no save.
- **Preview error recovery no longer draws into a detached node.** The editor's play preview replaced the Pixi host div with the error message; after recovery the canvas could live in a detached element. The host now stays mounted and the error overlays it.
- **The checkpoint prompt is reachable.** The editor chat never passed `checkpointEvery`, so the run-loop default (500 turns) made the entire Continue/Stop checkpoint UI dead code. It now checkpoints every 25 turns, and a run ending while the prompt is showing (e.g. via Interrupt, which no longer hangs — see the core batch) clears it.
