import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  fail,
  ok,
  type EditLog,
  type Registry,
  type Result,
  type Task,
  type TaskKind,
} from "@ludelier/world";
import type { AssetGenerationRequest } from "@ludelier/assets";
import { dispatch } from "@ludelier/authoring";
import {
  assetGenerationInputSchema,
  createAssetInventoryHost,
  defaultAssetStoreRoots,
  withAssetHostEditLogTransaction,
  type AssetHost,
} from "./assets";

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
 * One MCP tool spec. Registry tasks keep their registry `kind`; `"server"` marks extras that
 * live at the server level rather than in the world manifest.
 */
export interface McpTool {
  name: string;
  kind: TaskKind | "server";
  description: string;
  /** Live Zod params schema — the SDK advertises it as the tool's JSON `inputSchema`. */
  params?: Task["params"];
  /** The asset server tool mutates Story metadata despite living outside the world registry. */
  mutates?: boolean;
  /** Handlers may await shared log coordination, host persistence, or external I/O. */
  handler: (args: unknown) => CallToolResult | Promise<CallToolResult>;
}

/** Wrap a world `{success}` envelope as MCP text content, flagging failures as tool errors. */
function toToolResult(res: Result<unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    isError: !res.success,
  };
}

/**
 * Persist Story and its optional session log as a recoverable two-file transaction. Both new
 * contents are staged before either final path changes; a later rename failure restores the
 * prior pair. Each rename is same-directory and therefore individually atomic.
 */
export function createPersister(log: EditLog, target: PersistTarget): () => void {
  return () => {
    const story = JSON.stringify(log.currentStory(), null, 2);
    const previousStory = readFileSync(target.storyPath);
    const storyMode = statSync(target.storyPath).mode & 0o777;
    const previousLog =
      target.logPath && existsSync(target.logPath) ? readFileSync(target.logPath) : undefined;
    const logMode =
      target.logPath && previousLog !== undefined ? statSync(target.logPath).mode & 0o777 : 0o600;
    const suffix = `${process.pid}.${randomUUID()}.tmp`;
    const storyTemporary = `${target.storyPath}.${suffix}`;
    const logTemporary = target.logPath ? `${target.logPath}.${suffix}` : undefined;

    try {
      writeFileSync(storyTemporary, story, { mode: storyMode });
      chmodSync(storyTemporary, storyMode);
      if (logTemporary) {
        writeFileSync(logTemporary, log.export(), { mode: logMode });
        chmodSync(logTemporary, logMode);
      }
      renameSync(storyTemporary, target.storyPath);
      if (logTemporary && target.logPath) renameSync(logTemporary, target.logPath);
    } catch (error) {
      try {
        const restoreStory = `${target.storyPath}.${suffix}.restore`;
        writeFileSync(restoreStory, previousStory, { mode: storyMode });
        chmodSync(restoreStory, storyMode);
        renameSync(restoreStory, target.storyPath);
        if (target.logPath) {
          if (previousLog === undefined) rmSync(target.logPath, { force: true });
          else {
            const restoreLog = `${target.logPath}.${suffix}.restore`;
            writeFileSync(restoreLog, previousLog, { mode: logMode });
            chmodSync(restoreLog, logMode);
            renameSync(restoreLog, target.logPath);
          }
        }
      } catch {
        // The original persistence failure remains the only caller-visible signal.
      }
      throw error;
    } finally {
      rmSync(storyTemporary, { force: true });
      if (logTemporary) rmSync(logTemporary, { force: true });
    }
  };
}

/**
 * Server-level names are guarded whether a host is supplied or not, so registry tasks cannot
 * shadow optional generation or the always-safe inventory surface.
 */
const SERVER_TOOL_NAMES = ["describe", "export-log", "generate-asset", "list-asset-inventory"] as const;

/**
 * Derive the MCP toolset from the registry: one tool per world task (parity with the CLI,
 * the LLM toolset, and the UI), plus read-only extras, optional asset inventory, and optionally
 * authorized generation. `opts.persist` runs after every SUCCESSFUL manipulate call — understand
 * calls and failed edits never touch disk.
 */
export function buildMcpTools(
  world: Registry,
  log: EditLog,
  opts: {
    runId: string;
    persist: () => void | Promise<void>;
    /** Paid generation stays absent unless an authorized host is explicitly supplied. */
    assetHost?: AssetHost;
    /** Listing uses the same redacted host API as `ludelier asset ls`; it never enables generation. */
    assetInventoryHost?: AssetHost;
  },
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
      handler: async (args: unknown): Promise<CallToolResult> => {
        // Understand handlers are pure reads. Every mutation shares the AssetHost's per-log
        // coordinator so an interleaved asset persistence failure can safely undo its own record.
        if (entry.kind === "understand") {
          return toToolResult(
            dispatch(world, log, opts.runId, {
              id: entry.name,
              name: entry.name,
              arguments: args ?? {},
            }),
          );
        }

        return withAssetHostEditLogTransaction(log, async () => {
          const recordCount = log.recordsView().length;
          const res = dispatch(world, log, opts.runId, {
            id: entry.name,
            name: entry.name,
            arguments: args ?? {},
          });
          if (!res.success) return toToolResult(res);

          try {
            await opts.persist();
            return toToolResult(res);
          } catch {
            // The shared coordinator makes this the record this call appended; never leave a
            // live, unpersisted Story edit after the persistence boundary failed.
            if (log.recordsView().length === recordCount + 1) log.undo();
            return toToolResult(
              fail([{ path: "persistence", message: "story changes could not be persisted" }]),
            );
          }
        });
      },
    };
  });

  if (opts.assetHost) {
    tools.push({
      name: "generate-asset",
      kind: "server",
      mutates: true,
      description:
        "Authorized server-level media generation. Stores controlled media and registers its safe public URL in the active Story.",
      params: assetGenerationInputSchema,
      handler: async (args: unknown): Promise<CallToolResult> => {
        const raw = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
        return toToolResult(
          await opts.assetHost!.generate({
            log,
            runId: opts.runId,
            id: raw.id as string,
            destination: raw.destination as string,
            request: raw.request as AssetGenerationRequest,
            force: raw.force as boolean | undefined,
          }),
        );
      },
    });
  }
  if (opts.assetInventoryHost) {
    tools.push({
      name: "list-asset-inventory",
      kind: "server",
      description:
        "Read-only server-level asset inventory for this Story. Returns controlled public URLs and status/hashes only; never filesystem paths or provenance.",
      handler: async (): Promise<CallToolResult> =>
        toToolResult(await opts.assetInventoryHost!.list(log.currentStory().meta.id)),
    });
  }

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
    const annotations = {
      readOnlyHint: tool.kind === "understand" || (tool.kind === "server" && !tool.mutates),
    };
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

/** Explicit authorization is required because this server-level tool can spend BYOK provider funds. */
export interface McpAssetGenerationAuthorization {
  readonly enabled: true;
  readonly host: AssetHost;
}

/** Serve the world over stdio until the client disconnects. Returns the process exit code. */
export async function serveMcp(
  world: Registry,
  log: EditLog,
  target: PersistTarget,
  options: { readonly assetGeneration?: McpAssetGenerationAuthorization } = {},
): Promise<number> {
  // One runId for the whole server session: `revertRun` semantics are per-run, so a single
  // id lets a later `world`/editor invocation revert everything this MCP session did as one
  // contiguous unit (per-call runIds would fragment the history and defeat revertRun).
  const runId = `mcp-${process.pid}`;
  const assetHost =
    options.assetGeneration?.enabled && options.assetGeneration.host.hasGenerationProvider
      ? options.assetGeneration.host
      : undefined;
  // Listing is safe without provider credentials: construct the same listing-only host used by
  // `ludelier asset ls`. An authorized generation host doubles as its inventory host so both
  // surfaces honour its configured controlled roots.
  const assetInventoryHost = assetHost ?? createAssetInventoryHost(defaultAssetStoreRoots());
  const tools = buildMcpTools(world, log, {
    runId,
    persist: createPersister(log, target),
    assetHost,
    assetInventoryHost,
  });
  const server = buildMcpServer(tools);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel — human-facing status stays redacted on stderr.
  console.error(`ludelier mcp: serving ${tools.length} tools over stdio (runId: ${runId})`);
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve; // fires when stdin closes (client disconnect)
  });
  return 0;
}
