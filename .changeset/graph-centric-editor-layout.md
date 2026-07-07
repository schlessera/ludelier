---
"@ludelier/editor-web": minor
---

Redesign the editor shell around the story graph. The old fixed three-column grid is
replaced by a graph-centric layout: a large central React Flow canvas flanked by a
collapsible agent-chat dock (left) and a tabbed inspector (right), with drag-to-resize
splitters whose sizes persist across reloads (`react-resizable-panels`). A slim activity
rail toggles either side dock.

The inspector consolidates the former center-stacked script lens and side panel into one
scroll-isolated body with **Node / Edit / Health / History** tabs — selecting a graph node
jumps to the Node tab (and expands the dock if collapsed). Because the inspector scrolls
internally, selecting a node no longer reflows the graph or the chat: the long-standing
"windows jump around when you click a node" behaviour is gone, and the graph gets far more
room.

The Pixi play preview is now on-demand: a Play control opens it as a modal overlay
(Escape / backdrop / Close to dismiss) instead of permanently occupying center space, and
it can **pop out into a separate window** for multi-monitor use while staying in sync with
edits.
