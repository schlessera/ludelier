import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateStory, type Story } from "@ludelier/schema";
import { Simulation, replayTrace, type Action } from "@ludelier/engine";

function loadStory(path: string | undefined): Story {
  if (!path) {
    console.error("error: missing <story.json> path");
    process.exit(2);
  }
  const res = validateStory(JSON.parse(readFileSync(path, "utf8")));
  if (!res.success) {
    console.error(`INVALID story (${res.issues.length} issue(s)):`);
    for (const issue of res.issues) console.error(`  ${issue.path}: ${issue.message}`);
    process.exit(1);
  }
  return res.data;
}

function readActions(path: string | undefined): Action[] {
  if (!path) return [];
  return JSON.parse(readFileSync(path, "utf8")) as Action[];
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "validate": {
    loadStory(rest[0]);
    console.log("OK: story valid");
    break;
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
    break;
  }
  case "replay": {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { seed: { type: "string" } },
      allowPositionals: true,
    });
    const story = loadStory(positionals[0]);
    const trace = readFileSync(positionals[1] ?? "", "utf8");
    const result = replayTrace(story, trace, { seed: values.seed ? Number(values.seed) : undefined });
    console.log(`OK: replay matched ${result.steps} step(s)`);
    break;
  }
  default:
    console.error("usage: ludelier <validate|simulate|replay> <story.json> [--actions f] [--seed n]");
    process.exit(2);
}
