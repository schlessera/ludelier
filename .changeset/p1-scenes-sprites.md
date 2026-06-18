---
"@ludelier/schema": minor
"@ludelier/engine": minor
"@ludelier/renderer-pixi": minor
"@ludelier/runtime-web": minor
"@ludelier/cli": patch
---

P1 backgrounds + character sprites. Story DSL gains a central `assets` declaration and three non-blocking statements — `scene` (set/clear background, clears sprites), `show` (sprite in a named slot at left/center/right), `hide` — all cross-reference validated. The engine tracks a persistent `stage` (background + id-sorted sprites) threaded through the reducer and folded into the deterministic state hash, so replay covers visual state. The PixiJS renderer preloads declared assets, draws a cover-fit background and bottom-anchored sprites under the dialog UI on dedicated (configurable) layer z-indices, and crossfades background/sprite changes with a settle signal for screenshot tests. The runtime preloads assets and the `cafe` example now plays as a real visual novel (café background + character). `cli simulate` reports `stage`.
