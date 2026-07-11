---
"@ludelier/editor-core": minor
"@ludelier/editor-web": minor
---

Surface bounded all-paths runtime coverage in the editor. `EditorSession.snapshot()` now
carries an `explore` report (played-through nodes, whether an ending is reachable, self-gated
`stuck` nodes, and `truncated`/`crashed` flags) alongside the static `graph` — computed via the
same `explore` task the agent's `done` gate verifies against, so the human editor has parity
with what the agent sees.

The editor **Health** tab renders it beside the static wiring, including the actionable
static-vs-runtime divergence (nodes statically wired but never played, warning-grade) and folds
the blocking runtime signals (no ending reachable, stuck, crashed) into the Health-tab warning
dot. `HealthPanel` is extracted to a pure, prop-driven component.

Also adds a jsdom + React Testing Library component-test harness for the editor, covering
`HealthPanel`, the manifest-driven `TaskForm`, and the `ScriptLens`.
