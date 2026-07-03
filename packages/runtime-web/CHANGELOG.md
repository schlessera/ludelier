# @ludelier/runtime-web

## 0.1.1

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
- Updated dependencies [b8a118d]
- Updated dependencies [d746333]
- Updated dependencies [93bb287]
- Updated dependencies [e6ec2c4]
  - @ludelier/schema@0.2.0
  - @ludelier/engine@0.2.0
  - @ludelier/renderer-pixi@0.1.1

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
