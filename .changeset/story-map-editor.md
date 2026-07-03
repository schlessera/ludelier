---
"@ludelier/editor-web": minor
---

Add a read-only **story map** to the editor — a flow diagram of the branching structure.

The center column now shows an auto-laid-out graph (React Flow + dagre, layered top-down): one box per node, a labelled directed edge for every `choice` / `jump` / `branch` (conditional edges styled distinctly), and start / unreachable / dead-end badges read from the session's graph analysis. Clicking a node opens a read-only, screenplay-style **script lens** of its statements (with stable ids surfaced) and plays the embedded preview **from that node**. The map, lens, and preview re-render on every session change (agent edit, undo, redo, revert). It replaces the old text-list inspector; editing stays agent-only, and node positions are always auto-computed, never stored in the story.
