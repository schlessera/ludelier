# @ludelier/cli

## 0.1.0

### Minor Changes

- 00a221d: P0 headless core: deterministic Redux-style engine (seeded RNG, stable-hash snapshots, JSONL trace record/replay), Zod-validated Story DSL (`say`/`set`/`add`/`roll`/`choice`/`jump`/`end` + cross-reference validation + JSON Schema export), and a `validate`/`simulate`/`replay` CLI. No renderer yet.

### Patch Changes

- fd44662: P1 backgrounds + character sprites. Story DSL gains a central `assets` declaration and three non-blocking statements — `scene` (set/clear background, clears sprites), `show` (sprite in a named slot at left/center/right), `hide` — all cross-reference validated. The engine tracks a persistent `stage` (background + id-sorted sprites) threaded through the reducer and folded into the deterministic state hash, so replay covers visual state. The PixiJS renderer preloads declared assets, draws a cover-fit background and bottom-anchored sprites under the dialog UI on dedicated (configurable) layer z-indices, and crossfades background/sprite changes with a settle signal for screenshot tests. The runtime preloads assets and the `cafe` example now plays as a real visual novel (café background + character). `cli simulate` reports `stage`.
- Updated dependencies [00a221d]
- Updated dependencies [fd44662]
  - @ludelier/schema@0.1.0
  - @ludelier/engine@0.1.0
