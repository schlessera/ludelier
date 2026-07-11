import type { ExploreReport, GraphReport } from "@ludelier/world";

/**
 * Compact story-health readout, split into the two signals the agent's `done` gate verifies:
 * static wiring (`graph` — "is it wired?") and runtime behavioural coverage (`explore` — "does
 * it actually play through?"). Surfacing `explore` here gives the human editor parity with what
 * the agent sees: a node the static graph calls reachable can still never play through if every
 * path in is gated off, an ending can be statically present but never actually hit, and a jump
 * cycle only shows up when the story is run. Pure/presentational — the caller memoizes.
 *
 * Severity mirrors the gate: invalid / unreachable / static dead-end / no-ending-reachable /
 * stuck / crashed are blocking-grade (`bad`); runtime-`notReached` and `truncated` are the
 * non-blocking warnings the gate rides along on an accepted run (`warn` / `muted`).
 */
export function HealthPanel({
  valid,
  graph,
  explore,
}: {
  valid: boolean;
  graph: GraphReport;
  explore: ExploreReport;
}): JSX.Element {
  // The actionable divergence between the two analyses: nodes the static graph says are
  // reachable but that no runtime path actually plays through (every way in is gated off by
  // an `if` that is never satisfiable). `explore.reached` is always a subset of the statically
  // reachable set, so this difference is exactly "wired but never played". Warning-grade: the
  // agent gate surfaces the same set as a non-blocking warning, not a hard failure.
  const notReached = graph.reachable.filter((id) => !explore.reached.includes(id));
  return (
    <dl className="health" data-testid="health">
      <dt>valid</dt>
      <dd className={valid ? "ok" : "bad"}>{String(valid)}</dd>

      {/* Static wiring (graph): reachability + can-reach-an-end, ignoring runtime conditions. */}
      <dt>reachable</dt>
      <dd>{graph.reachable.length}</dd>
      <dt>unreachable</dt>
      <dd className={graph.unreachable.length ? "bad" : "ok"}>{graph.unreachable.join(", ") || "none"}</dd>
      <dt>dead ends</dt>
      <dd className={graph.deadEnds.length ? "bad" : "ok"}>{graph.deadEnds.join(", ") || "none"}</dd>

      {/* Runtime coverage (explore): bounded all-paths run through the reducer, honouring `if`. */}
      <dt>played through</dt>
      <dd data-testid="reached">{explore.reached.length}</dd>
      <dt>not reached (runtime)</dt>
      <dd className={notReached.length ? "warn" : "ok"} data-testid="not-reached">
        {notReached.join(", ") || "none"}
      </dd>
      <dt>ending reachable</dt>
      <dd className={explore.endReachable ? "ok" : "bad"} data-testid="end-reachable">
        {String(explore.endReachable)}
      </dd>
      <dt>stuck</dt>
      <dd className={explore.stuck.length ? "bad" : "ok"} data-testid="stuck">
        {explore.stuck.join(", ") || "none"}
      </dd>
      {explore.crashed && (
        <>
          <dt>crashed</dt>
          <dd className="bad" data-testid="crashed">
            a path loops forever (statement budget tripped)
          </dd>
        </>
      )}
      {explore.truncated && (
        <>
          <dt>coverage</dt>
          <dd className="muted" data-testid="truncated">
            partial — state cap hit; reached / ending are lower bounds
          </dd>
        </>
      )}
    </dl>
  );
}
