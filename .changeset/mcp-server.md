---
"@ludelier/cli": minor
---

MCP server: `ludelier mcp <story.json> [--log <log.jsonl>]` serves the world API over stdio, so external agents (Claude Code, Cursor, …) can understand and edit a story with the same guardrails as the CLI and the in-app agent.

- **Registry-derived, zero hardcoded task names.** Every world task in `describe()` becomes one MCP tool (name, description, live Zod `inputSchema` via `@modelcontextprotocol/sdk` 1.x `registerTool`); routing reuses authoring's `dispatch`, so `kind` comes from the registry — understand tasks read the current story, manipulate tasks go through `EditLog.apply`, the always-valid chokepoint.
- **The story file is the source of truth.** Loaded + validated at startup (invalid story = exit 1 with issues); after every successful edit the folded story is atomically rewritten (sibling temp file + rename — a crash never leaves a torn file) and `--log` captures the session's JSONL edit log. One `mcp-<pid>` runId per server session, so `revertRun` can drop everything the session did as one contiguous unit.
- **Uniform `{success}` envelopes.** Tool results carry the world's result envelope as JSON text with `isError` set on failed envelopes — a validation failure never throws across the MCP boundary. Two server-level extras beyond the registry: `describe` (the full manifest) and `export-log` (the session JSONL).
