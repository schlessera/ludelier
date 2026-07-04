---
"@ludelier/authoring": minor
"@ludelier/editor-web": patch
---

The agent gate gains a non-blocking warnings channel; the always-valid invariant gains a fuzz harness.

- **Runtime-unreached warnings.** `Verification` now reports `runtimeUnreached` — nodes that are statically reachable but that no condition-honouring play-through ever visits (every path in is gated off). Newly-introduced ones surface as **warnings** delivered *with* an accepted `done` (`{ok:true, warnings:[…]}`) and on the `verify` event — visible to the model and in the editor's feed, but never wedging the loop, since a branch awaiting its unlock legitimately looks like this mid-build. (Closes the last open follow-up from `docs/architecture-risks.md`.)
- **Seeded fuzz over `applyEdit`** (world tests): 2×400 randomly generated commands — colliding ids, dangling refs, stale statement targets, interleaved undo/redo — asserting the story validates after every single apply, nothing ever throws, and the surviving history refolds byte-identically through export → import. Deterministic via the engine's own PRNG, so any failure reproduces from its seed.
