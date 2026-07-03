import { renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok, type EditLog, type Registry, type Result, type Task, type TaskKind } from "@ludelier/world";
import { dispatch } from "@ludelier/authoring";

/**
 * `ludelier mcp` — a Model Context Protocol stdio server over the world API, so external
 * agents (Claude Code, Cursor, …) drive the same understand/manipulate tasks as the CLI,
 * the editor, and the in-app agent. Zero hardcoded task names: every tool is derived from
 * the registry manifest, and routing reuses authoring's `dispatch` — `kind` comes from the
 * registry (never the request), and every mutation goes through `EditLog.apply`, the
 * always-valid chokepoint.
 *
 * State model: the story FILE is the source of truth. It is loaded + validated once at
 * startup and atomically rewritten after every successful edit. `--log` is a session
 * transcript (JSONL, rewritten from the in-memory EditLog after each edit) — deliberately
 * NOT re-imported at startup, because the story file already contains the folded state
 * (folding an old log onto it again would double-apply the edits).
 */

/** Where a successful edit is persisted: the story file (atomic) + an optional JSONL log. */
export interface PersistTarget {
  storyPath: string;
  logPath?: string;
}

/**
 * One MCP tool spec. Registry tasks keep their registry `kind`; `"server"` marks the two
 * extras (`describe`, `export-log`) that live at the server level, not in the world.
 */
export interface McpTool {
  name: string;
  kind: TaskKind | "server";
  description: string;
  /** Live Zod params schema — the SDK advertises it as the tool's JSON `inputSchema`. */
  params?: Task["params"];
  /** Kind-routed implementation; a validation failure returns a fail envelope, never a throw. */
  handler: (args: unknown) => CallToolResult;
}

/** Wrap a world `{success}` envelope as MCP text content, flagging failures as tool errors. */
function toToolResult(res: Result<unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    isError: !res.success,
  };
}

/**
 * Build the persist step run after every successful edit. The story write is atomic —
 * sibling temp file + rename, so a crash mid-write leaves either the old or the new story
 * on disk, never a torn JSON file (same-directory rename stays on one filesystem). The
 * JSONL log is rewritten whole from the in-memory EditLog (same as `world edit`'s persist).
 */
export function createPersister(log: EditLog, target: PersistTarget): () => void {
  return () => {
    const tmp = `${target.storyPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(log.currentStory(), null, 2));
    renameSync(tmp, target.storyPath);
    if (target.logPath) writeFileSync(target.logPath, log.export());
  };
}

/** The server-level extra tool names — guarded against future registry collisions. */
const SERVER_TOOL_NAMES = ["describe", "export-log"] as const;

/**
 * Derive the MCP toolset from the registry: one tool per world task (parity with the CLI,
 * the LLM toolset, and the UI), plus the two server-level extras. `opts.persist` runs after
 * every SUCCESSFUL manipulate call — understand calls and failed edits never touch disk.
 */
export function buildMcpTools(
  world: Registry,
  log: EditLog,
  opts: { runId: string; persist: () => void },
): McpTool[] {
  for (const name of SERVER_TOOL_NAMES) {
    // Fail at construction (a startup error, not an MCP-boundary throw): a registry task
    // with this name would silently shadow — or be shadowed by — the server-level tool.
    if (world.get(name)) throw new Error(`registry task "${name}" collides with a server-level MCP tool`);
  }

  const tools: McpTool[] = world.describe().map((entry) => {
    const task = world.get(entry.name);
    if (!task) throw new Error(`manifest/registry drift: no task "${entry.name}"`);
    return {
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      params: task.params,
      handler: (args: unknown): CallToolResult => {
        // Same adapter the in-editor agent uses: understand runs on the current story,
        // manipulate applies through the log. `id` is provider bookkeeping dispatch ignores.
        const res = dispatch(world, log, opts.runId, {
          id: entry.name,
          name: entry.name,
          arguments: args ?? {},
        });
        if (res.success && entry.kind === "manipulate") opts.persist();
        return toToolResult(res);
      },
    };
  });

  // Server-level extras (not world tasks): the manifest itself + the session edit log.
  tools.push(
    {
      name: "describe",
      kind: "server",
      description:
        "Server-level (not a world task): the full world task manifest — every tool's name, kind, description, and JSON Schema.",
      handler: () => toToolResult(ok(world.describe())),
    },
    {
      name: "export-log",
      kind: "server",
      description:
        "Server-level (not a world task): this session's JSONL edit log (one record per applied edit; empty string if none yet).",
      handler: () => toToolResult(ok(log.export())),
    },
  );
  return tools;
}

// serverInfo tracks the published package version without a hardcoded copy to drift.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Register the derived toolset on an `McpServer` (SDK 1.x `registerTool` config API). */
export function buildMcpServer(tools: McpTool[]): McpServer {
  const server = new McpServer({ name: "ludelier", version: pkg.version });
  for (const tool of tools) {
    const annotations = { readOnlyHint: tool.kind !== "manipulate" };
    if (tool.params) {
      // The live Zod schema doubles as the advertised inputSchema; the SDK pre-validates
      // args against it and reports failures as isError results (never a transport crash).
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.params, annotations },
        (args: unknown) => tool.handler(args),
      );
    } else {
      server.registerTool(tool.name, { description: tool.description, annotations }, () => tool.handler({}));
    }
  }
  return server;
}

/** Serve the world over stdio until the client disconnects. Returns the process exit code. */
export async function serveMcp(world: Registry, log: EditLog, target: PersistTarget): Promise<number> {
  // One runId for the whole server session: `revertRun` semantics are per-run, so a single
  // id lets a later `world`/editor invocation revert everything this MCP session did as one
  // contiguous unit (per-call runIds would fragment the history and defeat revertRun).
  const runId = `mcp-${process.pid}`;
  const tools = buildMcpTools(world, log, { runId, persist: createPersister(log, target) });
  const server = buildMcpServer(tools);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel — human-facing status goes to stderr only.
  console.error(
    `ludelier mcp: serving ${tools.length} tools over stdio (story: ${target.storyPath}, runId: ${runId})`,
  );
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve; // fires when stdin closes (client disconnect)
  });
  return 0;
}
