---
"@ludelier/world": minor
---

Add `deriveFlowEdges` + the `flow-edges` understand task — labelled node transitions for the editor's structure map.

`GraphReport.edges` is bare `{from,to}` adjacency, which can't drive a map that labels and styles edges. `deriveFlowEdges(story)` walks each node's body (id-sorted for determinism) and returns one `FlowEdge` per `jump` / `branch` / `choice` option, carrying the edge `kind`, a human `label` (choice text, or the condition for a `branch` / gated option), a `conditional` flag, and the originating statement id. It is derived the same way the engine transitions between nodes, so the map matches real execution. Exposed both as a pure import and as the registered `flow-edges` task (agent-native parity — the agent can query the same edges the human sees). The existing `GraphReport` shape is unchanged.
