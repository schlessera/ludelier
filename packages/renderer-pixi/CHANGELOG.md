# @ludelier/renderer-pixi

## 0.1.1

### Patch Changes

- Updated dependencies [b4beead]
- Updated dependencies [e2da20a]
- Updated dependencies [b4beead]
- Updated dependencies [d746333]
  - @ludelier/engine@0.2.0

## 0.1.0

### Minor Changes

- fd44662: P1 backgrounds + character sprites. Story DSL gains a central `assets` declaration and three non-blocking statements — `scene` (set/clear background, clears sprites), `show` (sprite in a named slot at left/center/right), `hide` — all cross-reference validated. The engine tracks a persistent `stage` (background + id-sorted sprites) threaded through the reducer and folded into the deterministic state hash, so replay covers visual state. The PixiJS renderer preloads declared assets, draws a cover-fit background and bottom-anchored sprites under the dialog UI on dedicated (configurable) layer z-indices, and crossfades background/sprite changes with a settle signal for screenshot tests. The runtime preloads assets and the `cafe` example now plays as a real visual novel (café background + character). `cli simulate` reports `stage`.
- b7d7336: P1 web player: PixiJS v8 display-only renderer (`@ludelier/renderer-pixi`) plus a Vite + `vite-plugin-pwa` runtime (`@ludelier/runtime-web`) that plays a Story in the browser with Dexie local autosave/resume. Includes a Playwright play-through + visual-regression test driven through an agent-native `window.__ludelier` handle, with a `data-ready` first-paint flag and SwiftShader software GL for GPU-free CI.

### Patch Changes

- Updated dependencies [00a221d]
- Updated dependencies [fd44662]
  - @ludelier/engine@0.1.0
