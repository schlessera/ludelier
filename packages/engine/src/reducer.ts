import type { Story, Condition, VarValue } from "@ludelier/schema";
import type { Action, GameState, StageSprite } from "./state";
import { rollInt } from "./rng";

const MAX_STEPS = 100_000;

/**
 * Thrown when statement execution exceeds the budget — in practice always an infinite jump
 * loop (a cycle of nodes with no blocking/terminal statement). A named class so players can
 * catch this specific failure and recover gracefully instead of hard-crashing on a bad story.
 */
export class StatementBudgetError extends Error {
  constructor(public readonly node: string) {
    super(`statement budget exceeded at node "${node}" (possible infinite jump loop)`);
    this.name = "StatementBudgetError";
  }
}

function nodeBody(story: Story, id: string) {
  const node = story.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node not found: "${id}"`);
  return node.body;
}

/**
 * Evaluate a condition. eq/ne are strict (value type matters: "5" never equals 5). The ordered
 * comparisons (gt/lt/gte/lte) are number-only by design: if either side is not a number the
 * result is `false` — no silent string/undefined coercion. A non-numeric ordered comparison is
 * almost always an authoring mistake, so `conditionTypeIssues` (world) flags it statically.
 */
function compare(a: VarValue | undefined, cmp: Condition["cmp"], b: VarValue): boolean {
  switch (cmp) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      if (typeof a !== "number" || typeof b !== "number") return false;
      if (cmp === "gt") return a > b;
      if (cmp === "lt") return a < b;
      if (cmp === "gte") return a >= b;
      return a <= b;
    }
  }
}

/**
 * Execute statements from the cursor, applying non-blocking ops (set/add/roll/jump)
 * until reaching a blocking one (say/choice) or the end. Pure: returns a new state.
 */
function resolve(story: Story, state: GameState): GameState {
  let node = state.cursor.node;
  let index = state.cursor.index;
  let vars = state.vars;
  let rng = state.rng;
  let stage = state.stage;
  const transcript = state.transcript;
  let steps = 0;

  for (;;) {
    if (steps++ > MAX_STEPS) {
      throw new StatementBudgetError(node);
    }
    const body = nodeBody(story, node);
    if (index >= body.length) {
      return { cursor: { node, index }, vars, rng, stage, transcript, pending: { kind: "end" }, done: true };
    }
    const stmt = body[index]!;
    switch (stmt.op) {
      case "say":
        return {
          cursor: { node, index },
          vars,
          rng,
          stage,
          transcript: [...transcript, { who: stmt.who, text: stmt.text }],
          pending: { kind: "say", who: stmt.who, text: stmt.text },
          done: false,
        };
      case "set":
        vars = { ...vars, [stmt.var]: stmt.value };
        index++;
        break;
      case "add": {
        const current = typeof vars[stmt.var] === "number" ? (vars[stmt.var] as number) : 0;
        vars = { ...vars, [stmt.var]: current + stmt.amount };
        index++;
        break;
      }
      case "roll": {
        const [value, next] = rollInt(rng, stmt.min, stmt.max);
        rng = next;
        vars = { ...vars, [stmt.var]: value };
        index++;
        break;
      }
      case "jump":
        node = stmt.goto;
        index = 0;
        break;
      case "branch":
        // Conditional jump: take the goto when the condition holds, else fall through.
        if (compare(vars[stmt.cond.var], stmt.cond.cmp, stmt.cond.value)) {
          node = stmt.goto;
          index = 0;
        } else {
          index++;
        }
        break;
      case "scene":
        // A new scene replaces the background and clears all sprites.
        stage = { bg: stmt.bg ?? null, sprites: [] };
        index++;
        break;
      case "show": {
        // Replace any existing sprite in this slot, then keep the list sorted by
        // id so the stage hashes deterministically regardless of show order.
        const sprite: StageSprite = { id: stmt.sprite, asset: stmt.asset, at: stmt.at };
        const sprites = stage.sprites
          .filter((s) => s.id !== stmt.sprite)
          .concat(sprite)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        stage = { ...stage, sprites };
        index++;
        break;
      }
      case "hide":
        stage = { ...stage, sprites: stage.sprites.filter((s) => s.id !== stmt.sprite) };
        index++;
        break;
      case "choice":
        return {
          cursor: { node, index },
          vars,
          rng,
          stage,
          transcript,
          pending: {
            kind: "choice",
            prompt: stmt.prompt,
            options: stmt.options.map((o) => ({
              label: o.label,
              goto: o.goto,
              enabled: o.if ? compare(vars[o.if.var], o.if.cmp, o.if.value) : true,
            })),
          },
          done: false,
        };
      case "end":
        return {
          cursor: { node, index },
          vars,
          rng,
          stage,
          transcript,
          pending: { kind: "end" },
          done: true,
        };
    }
  }
}

/**
 * Build the starting state and resolve to the first blocking statement. `start` overrides the
 * entry node (the editor's "play from here"); it begins at that node with fresh default variable
 * state — upstream `set`/`add`/`roll` have not run, so downstream conditional flow reflects
 * defaults, not a real path to that node. Defaults to `story.meta.start`. An unknown `start`
 * surfaces as a "node not found" error (via `resolve`), never a silent fallback.
 */
export function initialState(story: Story, seed?: number, start?: string): GameState {
  const seeded = (seed ?? story.meta.seed ?? 0) | 0;
  return resolve(story, {
    cursor: { node: start ?? story.meta.start, index: 0 },
    vars: {},
    rng: seeded,
    stage: { bg: null, sprites: [] },
    pending: { kind: "end" },
    done: false,
    transcript: [],
  });
}

/** Pure reducer: (story, state, action) => state. The whole engine, deterministically. */
export function reducer(story: Story, state: GameState, action: Action): GameState {
  if (state.done) return state;
  switch (action.type) {
    case "ADVANCE":
      if (state.pending.kind !== "say") return state;
      return resolve(story, { ...state, cursor: { ...state.cursor, index: state.cursor.index + 1 } });
    case "CHOOSE": {
      if (state.pending.kind !== "choice") return state;
      const option = state.pending.options[action.index];
      if (!option || !option.enabled) return state;
      return resolve(story, { ...state, cursor: { node: option.goto, index: 0 } });
    }
  }
}
