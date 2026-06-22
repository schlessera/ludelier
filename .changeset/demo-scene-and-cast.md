---
"@ludelier/runtime-web": patch
---

Extend the café demo with a scene change and a second on-stage character.

New committed art (`packages/runtime-web/public/assets/cafe/`, generated via the `image-generation` skill, matching the existing warm anime VN style):
- `bg_street.webp` — an evening street exterior, used as a `scene` change in both endings (you step outside the café).
- `rin.webp` — a barista character (transparent sprite), distinct from `her`.

Story (`examples/cafe.story.json`): the `talk` path now shows **two characters at once** — `her` (left) and `rin` (right) — with `rin` joining the conversation as a new speaking character, then leaving (`hide`). The endings `scene`-change to `bg_street`, so the demo exercises mid-story background swaps as well as a multi-character stage. The opening frame and the existing play-through are unchanged (e2e visual + play tests green); the sample `cafe.actions.json` walks the new `talk` → lucky-street ending.
