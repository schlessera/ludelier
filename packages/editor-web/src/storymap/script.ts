import type { Statement } from "@ludelier/schema";
import { formatCondition } from "@ludelier/world";

/**
 * Render one statement as a readable, screenplay-style line. A one-way pretty-printer
 * (statements -> text): it never parses text back, and is the read-only half of an
 * eventual round-trippable author DSL. `choice` spans multiple lines (one per option).
 * Pure and exhaustive over the statement union.
 */
export function renderStatement(s: Statement): string {
  switch (s.op) {
    case "say":
      return `${s.who}: "${s.text}"`;
    case "set":
      return `set ${s.var} = ${String(s.value)}`;
    case "add":
      return `${s.var} ${s.amount >= 0 ? "+=" : "-="} ${Math.abs(s.amount)}`;
    case "roll":
      return `roll ${s.var} = ${s.min}..${s.max}`;
    case "scene":
      return `scene · bg ${s.bg ?? "(none)"}`;
    case "show":
      return `show ${s.sprite} = ${s.asset} @ ${s.at}`;
    case "hide":
      return `hide ${s.sprite}`;
    case "sound":
      return `sound ${s.channel} = ${s.asset}${s.loop ? " (loop)" : ""}`;
    case "stop-sound":
      return `stop sound ${s.channel}`;
    case "jump":
      return `jump → ${s.goto}`;
    case "branch":
      return `branch if ${formatCondition(s.cond)} → ${s.goto}`;
    case "end":
      return "end";
    case "choice": {
      const head = s.prompt ? `choice "${s.prompt}"` : "choice";
      const opts = s.options.map(
        (o) => `  → "${o.label}" → ${o.goto}${o.if ? ` (if ${formatCondition(o.if)})` : ""}`,
      );
      return [head, ...opts].join("\n");
    }
    default: {
      // Exhaustiveness guard: a new statement op becomes a compile error here.
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}
