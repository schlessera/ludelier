import type { Story, Condition, VarValue } from "@ludelier/schema";
import type { Action, GameState } from "./state";
import { rollInt } from "./rng";

const MAX_STEPS = 100_000;

function nodeBody(story: Story, id: string) {
  const node = story.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node not found: "${id}"`);
  return node.body;
}

function compare(a: VarValue | undefined, cmp: Condition["cmp"], b: VarValue): boolean {
  switch (cmp) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "gt":
      return (a as number) > (b as number);
    case "lt":
      return (a as number) < (b as number);
    case "gte":
      return (a as number) >= (b as number);
    case "lte":
      return (a as number) <= (b as number);
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
  let transcript = state.transcript;
  let steps = 0;

  for (;;) {
    if (steps++ > MAX_STEPS) {
      throw new Error("statement budget exceeded (possible infinite jump loop)");
    }
    const body = nodeBody(story, node);
    if (index >= body.length) {
      return { cursor: { node, index }, vars, rng, transcript, pending: { kind: "end" }, done: true };
    }
    const stmt = body[index]!;
    switch (stmt.op) {
      case "say":
        return {
          cursor: { node, index },
          vars,
          rng,
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
      case "choice":
        return {
          cursor: { node, index },
          vars,
          rng,
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
        return { cursor: { node, index }, vars, rng, transcript, pending: { kind: "end" }, done: true };
    }
  }
}

/** Build the starting state and resolve to the first blocking statement. */
export function initialState(story: Story, seed?: number): GameState {
  const seeded = (seed ?? story.meta.seed ?? 0) | 0;
  return resolve(story, {
    cursor: { node: story.meta.start, index: 0 },
    vars: {},
    rng: seeded,
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
