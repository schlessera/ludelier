import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateStory, type Issue, type Story } from "@ludelier/schema";
import { Simulation, replayTrace, type Action } from "@ludelier/engine";
import { createWorld, EditLog, importLog, parseParams, type Registry, type Result } from "@ludelier/world";
import { runAgent, providersFromEnv } from "@ludelier/authoring";
import type { AssetGenerationRequest } from "@ludelier/assets";
import {
  createAssetHostFromEnvironment,
  createAssetInventoryHost,
  defaultAssetStoreRoots,
  hasConfiguredAssetProvider,
} from "./assets";
import { createPersister, serveMcp } from "./mcp";

/** A CLI failure carrying the process exit code to return (no process.exit in run()). */
class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function loadStory(path: string | undefined): Story {
  if (!path) throw new CliError("missing --story <story.json>", 2);
  const res = validateStory(JSON.parse(readFileSync(path, "utf8")));
  if (!res.success) {
    const lines = res.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
    throw new CliError(`INVALID story (${res.issues.length} issue(s)):\n${lines}`, 1);
  }
  return res.data;
}

function readActions(path: string | undefined): Action[] {
  if (!path) return [];
  return JSON.parse(readFileSync(path, "utf8")) as Action[];
}

/** Load an EditLog from a base story file + an optional JSONL log file. */
function loadLog(world: Registry, storyPath: string | undefined, logPath: string | undefined): EditLog {
  const base = loadStory(storyPath);
  if (logPath && existsSync(logPath)) {
    const res = importLog(world, base, readFileSync(logPath, "utf8"));
    if (!res.success) throw new CliError(`invalid log: ${JSON.stringify(res.issues)}`, 1);
    return res.data;
  }
  return new EditLog(world, base);
}

function writeOut(text: string, outPath: string | undefined): void {
  if (outPath) writeFileSync(outPath, text);
  else console.log(text);
}

/** Persist a log's current story (-o or stdout) and its records (--log), after an edit. */
function persist(log: EditLog, logPath: string | undefined, outPath: string | undefined): void {
  if (logPath) writeFileSync(logPath, log.export());
  writeOut(JSON.stringify(log.currentStory(), null, 2), outPath);
}

function printIssues(issues: Issue[]): number {
  for (const i of issues) console.error(`  ${i.path}: ${i.message}`);
  return 1;
}

function printResult(res: Result<unknown>): number {
  if (!res.success) return printIssues(res.issues);
  console.log(JSON.stringify(res.data, null, 2));
  return 0;
}

/** `world <describe|query|edit|undo|redo|export> …` — all derived from the registry. */
function runWorld(rest: string[]): number {
  const world = createWorld();
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      story: { type: "string" },
      json: { type: "string" },
      log: { type: "string" },
      out: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  const args = values.json ? (JSON.parse(values.json) as unknown) : {};

  switch (sub) {
    case "describe":
      console.log(JSON.stringify(world.describe(), null, 2));
      return 0;
    case "query": {
      const name = positionals[1];
      const task = name ? world.get(name) : undefined;
      if (!task || task.kind !== "understand" || !task.run) {
        throw new CliError(`unknown understand task "${name ?? ""}"`, 2);
      }
      const parsed = parseParams(task.params, args);
      if (!parsed.success) return printIssues(parsed.issues);
      return printResult(task.run(loadLog(world, values.story, values.log).currentStory(), parsed.data));
    }
    case "edit": {
      const name = positionals[1];
      const task = name ? world.get(name) : undefined;
      if (!name || !task || task.kind !== "manipulate") {
        throw new CliError(`unknown manipulate command "${name ?? ""}"`, 2);
      }
      const log = loadLog(world, values.story, values.log);
      const res = log.apply(name, args, { runId: "cli" });
      if (!res.success) return printIssues(res.issues);
      persist(log, values.log, values.out);
      return 0;
    }
    case "undo":
    case "redo": {
      if (!values.log) throw new CliError(`world ${sub} requires --log`, 2);
      const log = loadLog(world, values.story, values.log);
      if (sub === "undo") log.undo();
      else log.redo();
      persist(log, values.log, values.out);
      return 0;
    }
    case "export":
      console.log(loadLog(world, values.story, values.log).export());
      return 0;
    default:
      throw new CliError(
        "usage: world <describe|query|edit|undo|redo|export> --story <f> [--json '<args>'] [--log l] [-o out]",
        2,
      );
  }
}

/** `author run "<prompt>" --story <f> [--log l] [-o out]` — BYOK, live LLM optional. */
async function runAuthor(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      story: { type: "string" },
      log: { type: "string" },
      out: { type: "string", short: "o" },
      "max-steps": { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals[0] !== "run") {
    throw new CliError('usage: author run "<prompt>" --story <f> [--log l] [-o out] [--max-steps n]', 2);
  }
  const prompt = positionals[1];
  if (!prompt) throw new CliError("author run requires a prompt", 2);

  let maxSteps: number | undefined;
  if (values["max-steps"] !== undefined) {
    maxSteps = Number(values["max-steps"]);
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new CliError("--max-steps must be a positive integer", 2);
    }
  }

  const providers = providersFromEnv(process.env);
  const provider = providers.openai ?? providers.openrouter;
  if (!provider) {
    console.error(
      "author run needs an LLM key (BYOK). Set OPENAI_API_KEY or OPENROUTER_API_KEY. Live LLM is optional in slice 1.",
    );
    return 1;
  }

  const story = loadStory(values.story);
  // Stream progress to stderr (the run is otherwise opaque); Ctrl-C aborts via the signal.
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once("SIGINT", onSigint);
  const res = await runAgent({
    provider,
    prompt,
    story,
    maxSteps,
    signal: ac.signal,
    onEvent: (e) => {
      if (e.kind === "edit")
        console.error(`  ${e.success ? "+" : "✗"} ${e.command} ${JSON.stringify(e.params)}`);
      else if (e.kind === "verify" && !e.clean) console.error(`  ⚠ ${e.problems.join("; ")}`);
    },
  });
  process.removeListener("SIGINT", onSigint);
  writeOut(JSON.stringify(res.story, null, 2), values.out);
  if (values.log) writeFileSync(values.log, res.log.export());
  const v = res.verification;
  const graphNote =
    v.unreachable.length || v.deadEnds.length
      ? ` unreachable=[${v.unreachable.join(",")}] deadEnds=[${v.deadEnds.join(",")}]`
      : "";
  console.error(
    `run ${res.runId}: ${res.commands.length} command(s), ok=${res.ok}, valid=${v.valid}, stop=${res.stopReason}${graphNote}`,
  );
  return res.ok ? 0 : 1;
}

/** `asset <gen|ls>` — controlled media generation and redacted inventory; `--force` only regenerates a verified cache hit and may charge. */
async function runAsset(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      story: { type: "string" },
      id: { type: "string" },
      destination: { type: "string" },
      json: { type: "string" },
      log: { type: "string" },
      "public-root": { type: "string" },
      "provenance-root": { type: "string" },
      force: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  const storyPath = values.story;
  const defaults = defaultAssetStoreRoots();
  const roots = {
    publicRoot: path.resolve(values["public-root"] ?? defaults.publicRoot),
    provenanceRoot: path.resolve(values["provenance-root"] ?? defaults.provenanceRoot),
  };

  if (sub === "ls") {
    const story = loadStory(storyPath);
    return printResult(await createAssetInventoryHost(roots).list(story.meta.id));
  }
  if (sub !== "gen") {
    throw new CliError(
      "usage: asset <gen|ls> --story <story.json> [--public-root <dir> --provenance-root <dir>]",
      2,
    );
  }
  if (!storyPath || !values.id || !values.destination || !values.json) {
    throw new CliError(
      "usage: asset gen --story <story.json> --id <asset-id> --destination <relative-path> --json '<request>' [--log <log.jsonl>] [--force]",
      2,
    );
  }

  let request: unknown;
  try {
    request = JSON.parse(values.json);
  } catch {
    throw new CliError("asset request must be valid JSON", 2);
  }
  if (!hasConfiguredAssetProvider()) {
    throw new CliError("asset gen needs a configured asset BYOK provider", 1);
  }

  const world = createWorld();
  // The rewritten Story is authoritative on every invocation; --log is reusable output, never
  // input to fold again after that Story already contains the records.
  const log = new EditLog(world, loadStory(storyPath));
  const target = { storyPath, logPath: values.log };
  const host = await createAssetHostFromEnvironment({
    roots,
    persist: (activeLog) => createPersister(activeLog, target)(),
  });
  if (!host.hasGenerationProvider) {
    throw new CliError("asset gen has no compatible configured provider", 1);
  }
  return printResult(
    await host.generate({
      log,
      runId: "cli-asset",
      id: values.id,
      destination: values.destination,
      request: request as AssetGenerationRequest,
      force: values.force,
    }),
  );
}

/** Parse + dispatch a CLI invocation, returning the process exit code. Never calls process.exit. */
export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "validate": {
        loadStory(rest[0]);
        console.log("OK: story valid");
        return 0;
      }
      case "simulate": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { actions: { type: "string" }, seed: { type: "string" } },
          allowPositionals: true,
        });
        const story = loadStory(positionals[0]);
        const sim = new Simulation(story, { seed: values.seed ? Number(values.seed) : undefined });
        sim.run(readActions(values.actions));
        console.log(
          JSON.stringify(
            {
              hash: sim.hash(),
              done: sim.state.done,
              pending: sim.state.pending,
              vars: sim.state.vars,
              stage: sim.state.stage,
              transcript: sim.transcript(),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      /** `replay <story> <trace> [--seed <number>] [--start <node-id>]` checks a recorded path. */
      case "replay": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { seed: { type: "string" }, start: { type: "string" } },
          allowPositionals: true,
        });
        const story = loadStory(positionals[0]);
        const trace = readFileSync(positionals[1] ?? "", "utf8");
        const result = replayTrace(story, trace, {
          seed: values.seed ? Number(values.seed) : undefined,
          start: values.start,
        });
        console.log(`OK: replay matched ${result.steps} step(s)`);
        return 0;
      }
      case "world":
        return runWorld(rest);
      case "asset":
        return await runAsset(rest);
      case "author":
        return await runAuthor(rest);
      case "mcp": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            log: { type: "string" },
            "enable-asset-generation": { type: "boolean" },
            "public-root": { type: "string" },
            "provenance-root": { type: "string" },
          },
          allowPositionals: true,
        });
        const storyPath = positionals[0];
        if (!storyPath) {
          throw new CliError(
            "usage: mcp <story.json> [--log <log.jsonl>] [--enable-asset-generation --public-root <dir> --provenance-root <dir>]",
            2,
          );
        }
        // The story FILE is the source of truth (rewritten after every successful edit), so
        // the session log starts fresh on it — an existing --log file is output, not input.
        const world = createWorld();
        const log = new EditLog(world, loadStory(storyPath));
        const target = { storyPath, logPath: values.log };
        if (!values["enable-asset-generation"]) return await serveMcp(world, log, target);

        if (!hasConfiguredAssetProvider()) {
          throw new CliError("MCP asset generation needs a configured asset BYOK provider", 1);
        }
        const defaults = defaultAssetStoreRoots();
        const host = await createAssetHostFromEnvironment({
          roots: {
            publicRoot: path.resolve(values["public-root"] ?? defaults.publicRoot),
            provenanceRoot: path.resolve(values["provenance-root"] ?? defaults.provenanceRoot),
          },
          persist: (activeLog) => createPersister(activeLog, target)(),
        });
        if (!host.hasGenerationProvider) {
          throw new CliError("MCP asset generation has no compatible configured provider", 1);
        }
        return await serveMcp(world, log, target, { assetGeneration: { enabled: true, host } });
      }
      default:
        console.error(
          "usage: ludelier <validate|simulate|replay|world|author|asset|mcp> … (run `ludelier world describe` for the task list)",
        );
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`error: ${e.message}`);
      return e.code;
    }
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

// Run as the binary, but stay importable (tests call run() directly).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
