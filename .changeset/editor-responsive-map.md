---
"@ludelier/editor-web": patch
---

Responsive editor layout + correct story-map framing on story switch.

- The three-column layout now adapts: below 1280px the center column (preview + map + lens) goes full-width with chat and the side panel sharing a row beneath (and the page scrolls instead of pinning to the viewport); below 820px everything stacks in a single column, center first, with a wrapping toolbar.
- The story map is keyed by the session-swap counter: Open/New now re-frames the new story instead of keeping the previous story's pan/zoom over a different graph. Within a session, edits still deliberately preserve the viewport — the map controls' fit button re-frames on demand.
