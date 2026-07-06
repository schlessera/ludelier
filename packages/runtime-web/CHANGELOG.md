# @ludelier/runtime-web

## 0.2.0

### Minor Changes

- 092ca2f: Player presentation hardening: high-DPI rendering, keyboard input + a screen-reader path, and unit-testable display math.

  - **High-DPI rendering.** The renderer initialized Pixi at a fixed 1× resolution, so Retina/HiDPI screens got a CSS-upscaled (blurry) 1280×720 buffer. `RendererOptions` gains `resolution?: number` (default: the device's `devicePixelRatio`), rendering the backing store at device resolution. The logical 1280×720 coordinate space is unchanged, and the CSS-displayed size stays under the host page's control — deliberately no `autoDensity`, whose inline `style.width/height` would override the stylesheet-driven canvas sizing both the player and the editor preview rely on (Pixi maps pointer events through canvas-rect × resolution, so hit-testing is resolution-independent either way). The player's CSS now caps the displayed canvas at the logical 1280×720 so the denser backing store doesn't enlarge it. Playwright runs at DPR 1, so the visual baseline is byte-identical (verified, not regenerated); pin `resolution: 1` wherever byte-stable frames matter.
  - **Keyboard input.** The player was pointer-only. Enter/Space now advance and digits 1–9 pick a choice option — the handler only dispatches the same `ADVANCE`/`CHOOSE` actions as clicks, so the reducer's guards (advance only a pending `say`; choose only an enabled option) are never bypassed. Space's page-scroll default is suppressed; modifier combos and key repeats are ignored; the listener attaches only once the simulation exists.
  - **Screen-reader path (accessibility floor).** A visually-hidden polite `aria-live` region mirrors the current step: "Name: line" for dialog (declared display name, not the character id), the prompt plus numbered options (disabled ones marked unavailable) for choices, "The end." at the end. Updated only when the line actually changes so it isn't re-announced.
  - **Renderer display math is now pure + unit-tested** (`layout.ts`): `coverScale`, `slotX`, `characterScale`, `tweenAlpha` (incl. the snap-to-final screenshot-stability rule), and `resolveSpeaker` (id → display name/color with the default-color fallback) extracted from the renderer behaviour-identically and covered by Vitest tests with no DOM/GL — the package's first unit tests. `PixiRenderer` consumes the helpers; the visual baseline is unchanged.

- 7e4c2be: Repo-review correctness batch (presentation): character names/colors render, asset failures surface, saves invalidate, preview error recovery, reachable checkpoints.

  Five fixes from the 2026-07-03 repo review (see `docs/plans/2026-07-03-001-repo-review-implementation.md`):

  - **Dialog shows the declared character, not its id.** The engine's `pending.who` is the character _id_; the renderer displayed it verbatim in one hardcoded blue, so the schema's `Character.name`/`color` were dead at runtime ("narrator" instead of "Narrator", no per-character colors). New `PixiRenderer.setCharacters()` declares the cast; dialog resolves id → display name + color (fallback unchanged). The player wires it at startup, the editor preview re-wires per edit. Visual baseline regenerated.
  - **Asset-load failure shows the error overlay.** `renderer.mount()`/`preload()` ran outside the player's try/catch — a 404'd asset was an unhandled rejection with neither `data-ready` nor `data-error` ever set. Both now route through the recoverable `fatal()` overlay.
  - **Saves are bound to their story.** A resumed save was restored blindly; with the PWA auto-updating underneath saved games, a changed story could strand the cursor on a node that no longer exists. Save rows now carry a story fingerprint (`hashState(story)`) + a `SAVE_VERSION`; a mismatch (including all pre-existing rows) is treated as no save.
  - **Preview error recovery no longer draws into a detached node.** The editor's play preview replaced the Pixi host div with the error message; after recovery the canvas could live in a detached element. The host now stays mounted and the error overlays it.
  - **The checkpoint prompt is reachable.** The editor chat never passed `checkpointEvery`, so the run-loop default (500 turns) made the entire Continue/Stop checkpoint UI dead code. It now checkpoints every 25 turns, and a run ending while the prompt is showing (e.g. via Interrupt, which no longer hangs — see the core batch) clears it.

### Patch Changes

- b32366b: Extend the café demo with a scene change and a second on-stage character.

  New committed art (`packages/runtime-web/public/assets/cafe/`, generated via the `image-generation` skill, matching the existing warm anime VN style):

  - `bg_street.webp` — an evening street exterior, used as a `scene` change in both endings (you step outside the café).
  - `rin.webp` — a barista character (transparent sprite), distinct from `her`.

  Story (`examples/cafe.story.json`): the `talk` path now shows **two characters at once** — `her` (left) and `rin` (right) — with `rin` joining the conversation as a new speaking character, then leaving (`hide`). The endings `scene`-change to `bg_street`, so the demo exercises mid-story background swaps as well as a multi-character stage. The opening frame and the existing play-through are unchanged (e2e visual + play tests green); the sample `cafe.actions.json` walks the new `talk` → lucky-street ending.

- b4beead: Close the three open robustness issues from the architecture review.

  - **Defined comparison semantics (no silent coercion).** `compare` (engine reducer) no longer casts operands: `eq`/`ne` stay strict, and the ordered ops (`gt`/`lt`/`gte`/`lte`) are number-only — a non-number operand yields `false` instead of a coerced/lexical surprise. New `conditionTypeIssues` (world) statically flags ordered comparisons that can't behave as intended (a non-number literal, or a var `set` to a non-number elsewhere); `runAgent`'s gate surfaces newly-introduced ones so the agent fixes them before `done`.
  - **EditorSession run lock.** An agent `chat` run mutates the shared log across `await` boundaries and snapshots a pre-run baseline, so a concurrent human edit would corrupt the run's diff and break `revertRun`. `edit`/`revertRun` now refuse (return a failure) and `undo`/`redo`/a second `chat` throw while a run is in flight; a new `busy` getter lets the UI disable its controls. Reads stay allowed.
  - **Recoverable runtime cycle.** The reducer now throws a typed `StatementBudgetError` (exported from `@ludelier/engine`) on an infinite jump loop. The web player (`runtime-web`) and the editor play preview (`editor-web`) catch it — and any playback throw — and show a recoverable error (with a restart) instead of white-screening.

- Updated dependencies [b4beead]
- Updated dependencies [e2da20a]
- Updated dependencies [b4beead]
- Updated dependencies [092ca2f]
- Updated dependencies [b8fe968]
- Updated dependencies [7e4c2be]
- Updated dependencies [b8a118d]
- Updated dependencies [d746333]
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/schema@0.2.0
  - @ludelier/engine@0.2.0
  - @ludelier/renderer-pixi@0.2.0

## 0.1.0

### Minor Changes

- fd44662: P1 backgrounds + character sprites. Story DSL gains a central `assets` declaration and three non-blocking statements — `scene` (set/clear background, clears sprites), `show` (sprite in a named slot at left/center/right), `hide` — all cross-reference validated. The engine tracks a persistent `stage` (background + id-sorted sprites) threaded through the reducer and folded into the deterministic state hash, so replay covers visual state. The PixiJS renderer preloads declared assets, draws a cover-fit background and bottom-anchored sprites under the dialog UI on dedicated (configurable) layer z-indices, and crossfades background/sprite changes with a settle signal for screenshot tests. The runtime preloads assets and the `cafe` example now plays as a real visual novel (café background + character). `cli simulate` reports `stage`.
- b7d7336: P1 web player: PixiJS v8 display-only renderer (`@ludelier/renderer-pixi`) plus a Vite + `vite-plugin-pwa` runtime (`@ludelier/runtime-web`) that plays a Story in the browser with Dexie local autosave/resume. Includes a Playwright play-through + visual-regression test driven through an agent-native `window.__ludelier` handle, with a `data-ready` first-paint flag and SwiftShader software GL for GPU-free CI.

### Patch Changes

- 27d0662: Add SVG app icons (standard + maskable) to the PWA manifest so the web player is installable.
- Updated dependencies [00a221d]
- Updated dependencies [fd44662]
- Updated dependencies [b7d7336]
  - @ludelier/schema@0.1.0
  - @ludelier/engine@0.1.0
  - @ludelier/renderer-pixi@0.1.0
