import { useEffect, useRef, useState } from "react";
import { type Action, Simulation } from "@ludelier/engine";
import { PixiRenderer, type AssetRef } from "@ludelier/renderer-pixi";
import type { EditorSession } from "@ludelier/editor-core";

// Pixi's Assets registry is a global singleton; track which id → src pairs are already
// loaded so a rebuild (after an edit) only loads newly-added assets and never re-adds a
// live alias. Tracking the src too matters since sessions can be swapped (Open/New): an
// opened story reusing an id for a *different* src must fail loudly (below) rather than
// silently rendering the previous story's texture.
const loadedAssets = new Map<string, string>();

async function ensureAssets(renderer: PixiRenderer, assets: readonly AssetRef[]): Promise<void> {
  const fresh: AssetRef[] = [];
  for (const a of assets) {
    const src = loadedAssets.get(a.id);
    if (src === undefined) fresh.push(a);
    else if (src !== a.src) {
      throw new Error(`asset "${a.id}" is already loaded from "${src}" — reload the page to load "${a.src}"`);
    }
  }
  if (fresh.length === 0) return;
  await renderer.preload(fresh);
  for (const a of fresh) loadedAssets.set(a.id, a.src);
}

/**
 * Live play preview: mounts the display-only PixiJS renderer once, then replays the
 * session's current story on every edit (`version` bump) and whenever the selected
 * `startNode` changes (the map's "play from here"). Advancing / choosing drives a local
 * `Simulation` — the preview is a throwaway playthrough, never a mutation of the authored
 * story (that only happens through the session's edit tasks).
 */
export function PlayCanvas({
  session,
  version,
  startNode,
  bare = false,
}: {
  session: EditorSession;
  version: number;
  startNode?: string;
  /** Drop the panel header when hosted inside chrome that already labels the preview
   *  (the play overlay / popped-out window). */
  bare?: boolean;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const simRef = useRef<Simulation | null>(null);
  const mountedRef = useRef(false);
  /** The preview playthrough's own action history — replayed after an edit so the author
   *  isn't yanked back to the start on every change. Cleared by Restart / play-from-here. */
  const actionsRef = useRef<Action[]>([]);
  const [error, setError] = useState<string | null>(null);

  function draw(): void {
    const sim = simRef.current;
    const renderer = rendererRef.current;
    if (sim && renderer) renderer.render(sim.state);
  }

  /** Dispatch a play action, surfacing an engine throw (e.g. an infinite loop) as the inline
   *  error instead of letting it escape the Pixi event handler and crash the preview. */
  function step(action: Action): void {
    try {
      simRef.current?.dispatch(action);
      actionsRef.current.push(action);
      draw();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function rebuild(): Promise<void> {
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      const story = session.story;
      await ensureAssets(renderer, story.assets);
      renderer.setCharacters(story.characters); // dialog resolves id → name/color per edit
      // Guard a stale selection (a node the agent has since deleted) — fall back to the
      // story's own start rather than letting the engine throw "node not found".
      const start = startNode && story.nodes.some((n) => n.id === startNode) ? startNode : undefined;
      const sim = new Simulation(story, { seed: story.meta.seed, start });
      // Replay this preview's recorded actions against the edited story so the play
      // position survives an edit. The reducer's own guards make stale actions harmless
      // no-ops (ADVANCE on a choice, out-of-range CHOOSE); only an engine throw — the
      // edit put an infinite loop on the replayed path — discards and restarts clean.
      try {
        for (const a of actionsRef.current) sim.dispatch(a);
        simRef.current = sim;
      } catch {
        actionsRef.current = [];
        simRef.current = new Simulation(story, { seed: story.meta.seed, start });
      }
      draw();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Forget the recorded playthrough and rebuild from the (selected) start. */
  function restart(): void {
    actionsRef.current = [];
    void rebuild();
  }

  // Mount the renderer once; tear it down on unmount. `destroy()` requires a completed
  // `mount()`, so under StrictMode's mount→unmount→mount probe we must not destroy a
  // renderer whose async init is still in flight — defer that to the init path instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once by design — rebuild/step read refs, and re-running this effect would tear down the live Pixi app
  useEffect(() => {
    let disposed = false;
    const renderer = new PixiRenderer({
      onAdvance: () => step({ type: "ADVANCE" }),
      onChoose: (index) => step({ type: "CHOOSE", index }),
    });
    rendererRef.current = renderer;
    void (async () => {
      const host = hostRef.current;
      if (host) await renderer.mount(host);
      if (disposed) {
        renderer.destroy(); // cleanup ran while init was in flight — tear down now
        return;
      }
      mountedRef.current = true;
      await rebuild();
    })();
    return () => {
      disposed = true;
      if (mountedRef.current) {
        mountedRef.current = false;
        renderer.destroy();
        if (rendererRef.current === renderer) rendererRef.current = null;
      }
    };
  }, []);

  // Rebuild whenever the story changes (holding position via the action replay above),
  // or from scratch when a different start node is selected — "play from here" is
  // explicitly a fresh run, so the recorded history is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/startNode are the replay signals (session.story is read fresh inside rebuild); adding rebuild would replay every render
  useEffect(() => {
    if (mountedRef.current) void rebuild();
  }, [version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart reads refs; startNode is the reset signal
  useEffect(() => {
    if (mountedRef.current) restart();
  }, [startNode]);

  return (
    <section className={bare ? "play bare" : "panel play"}>
      {!bare && (
        <h2>
          Play preview{" "}
          <span className="muted">· {startNode ? `from ${startNode} · fresh state` : "from start"}</span>
        </h2>
      )}
      {/* The host div must stay mounted through error states — the Pixi canvas was appended
          to THIS node at mount time, and swapping it out would leave the renderer drawing
          into a detached element after recovery. The error renders as an overlay instead. */}
      <div className="stage-wrap">
        <div className="stage-host" ref={hostRef} />
        {error && (
          <p className="err stage-error" role="alert">
            preview error: {error}
          </p>
        )}
      </div>
      <div className="play-actions">
        <button type="button" onClick={restart}>
          ⟳ Restart
        </button>
      </div>
    </section>
  );
}
