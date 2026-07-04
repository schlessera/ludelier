import { describe, expect, it } from "vitest";
import { nextRandom } from "@ludelier/engine";
import { validateStory, type Statement, type Story } from "@ludelier/schema";
import { createWorld } from "../src/index";
import { EditLog, importLog } from "../src/log";
import { hashStory } from "../src/canonical";

/**
 * Deterministic fuzz over the always-valid invariant: hammer an EditLog with hundreds of
 * randomly generated commands (many intentionally nonsensical) and assert that
 *   1. the current story validates after EVERY apply — accepted or rejected,
 *   2. apply() never throws (failures are envelopes),
 *   3. the surviving history refolds identically through export → import.
 * Seeded with the engine's own PRNG, so a failure reproduces exactly — print the seed.
 */

const world = createWorld();

const base: Story = {
  meta: { id: "fuzz", title: "Fuzz", start: "a" },
  characters: [{ id: "n", name: "N" }],
  assets: [{ id: "bg", src: "/bg.png" }],
  nodes: [
    { id: "a", body: [{ op: "say", who: "n", text: "hi" }, { op: "end" }] },
    { id: "b", body: [{ op: "end" }] },
  ],
};

/** Small pools so generated ids collide often — collisions are where invariants crack. */
const NODE_IDS = ["a", "b", "c", "d", "e"];
const CHARS = ["n", "m", "ghost"];
const VARS = ["trust", "luck"];

class Rand {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    const [v, s] = nextRandom(this.state);
    this.state = s;
    return v;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
}

/** A random statement — valid-shaped, but its refs may dangle (that's the point). */
function randomStatement(r: Rand): Statement {
  switch (r.int(6)) {
    case 0:
      return { op: "say", who: r.pick(CHARS), text: `t${r.int(100)}` };
    case 1:
      return { op: "set", var: r.pick(VARS), value: r.int(5) };
    case 2:
      return { op: "jump", goto: r.pick(NODE_IDS) };
    case 3:
      return {
        op: "choice",
        options: [
          { label: "x", goto: r.pick(NODE_IDS) },
          { label: "y", goto: r.pick(NODE_IDS) },
        ],
      };
    case 4:
      return { op: "end" };
    default:
      return { op: "show", sprite: "s", asset: "bg", at: "center" };
  }
}

/** One random command + params. Statement ids are guessed positionally — often stale/wrong. */
function randomCommand(r: Rand): { command: string; params: unknown } {
  const nodeId = r.pick(NODE_IDS);
  const guessedStmt = `${r.pick(NODE_IDS)}#${r.int(4)}`;
  const editStmt = `s${r.int(20)}`;
  switch (r.int(10)) {
    case 0:
      return { command: "create-node", params: { id: nodeId } };
    case 1:
      return { command: "delete-node", params: { id: nodeId } };
    case 2:
      return { command: "add-statement", params: { nodeId, statement: randomStatement(r) } };
    case 3:
      return {
        command: "add-statement",
        params: { nodeId, statement: randomStatement(r), before: r.next() < 0.5 ? guessedStmt : editStmt },
      };
    case 4:
      return {
        command: "update-statement",
        params: {
          nodeId,
          statementId: r.next() < 0.5 ? guessedStmt : editStmt,
          statement: randomStatement(r),
        },
      };
    case 5:
      return {
        command: "remove-statement",
        params: { nodeId, statementId: r.next() < 0.5 ? guessedStmt : editStmt },
      };
    case 6:
      return { command: "rewire-goto", params: { nodeId, statementId: guessedStmt, goto: r.pick(NODE_IDS) } };
    case 7:
      return { command: "add-character", params: { id: r.pick(CHARS), name: "X" } };
    case 8:
      return {
        command: "add-choice-option",
        params: {
          nodeId,
          statementId: r.next() < 0.5 ? guessedStmt : editStmt,
          option: { label: "z", goto: r.pick(NODE_IDS) },
        },
      };
    default:
      return {
        command: "remove-choice-option",
        params: { nodeId, statementId: guessedStmt, index: r.int(3) },
      };
  }
}

function fuzzRun(seed: number, steps: number): void {
  const r = new Rand(seed);
  const log = new EditLog(world, base);
  let applied = 0;
  for (let i = 0; i < steps; i++) {
    // Sprinkle undo/redo through the stream — head movement is where refolds happen.
    const roll = r.next();
    if (roll < 0.05) {
      log.undo();
    } else if (roll < 0.1) {
      log.redo();
    } else {
      const { command, params } = randomCommand(r);
      const res = log.apply(command, params, { runId: `fuzz-${i % 7}` });
      if (res.success) applied++;
    }
    const check = validateStory(log.currentStory());
    if (!check.success) {
      throw new Error(
        `always-valid violated at step ${i} (seed ${seed}): ${JSON.stringify(check.issues.slice(0, 3))}`,
      );
    }
  }
  // The random walk must actually exercise the mutation paths, not just bounce off them.
  expect(applied).toBeGreaterThan(20);
  // Export → import refolds to the identical canonical story.
  const round = importLog(world, base, log.export());
  expect(round.success).toBe(true);
  if (round.success) expect(hashStory(round.data.currentStory())).toBe(hashStory(log.currentStory()));
}

describe("applyEdit fuzz (seeded, deterministic)", () => {
  it("survives 400 random commands without ever holding an invalid story (seed 1)", () => {
    fuzzRun(1, 400);
  });

  it("survives 400 random commands without ever holding an invalid story (seed 424242)", () => {
    fuzzRun(424242, 400);
  });
});
