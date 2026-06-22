import { useEffect, useRef, useState } from "react";
import { Simulation } from "@ludelier/engine";
import { PixiRenderer, type AssetRef } from "@ludelier/renderer-pixi";
import type { EditorSession } from "@ludelier/editor-core";

// Pixi's Assets registry is a global singleton; track which ids are already loaded so a
// rebuild (after an edit) only loads newly-added assets and never re-adds a live alias.
const loadedAssetIds = new Set<string>();

async function ensureAssets(renderer: PixiRenderer, assets: readonly AssetRef[]): Promise<void> {
  const fresh = assets.filter((a) => !loadedAssetIds.has(a.id));
  if (fresh.length === 0) return;
  await renderer.preload(fresh);
  for (const a of fresh) loadedAssetIds.add(a.id);
}

/**
 * Live play preview: mounts the display-only PixiJS renderer once, then replays the
 * session's current story from its start on every edit (`version` bump). Advancing /
 * choosing drives a local `Simulation` — the preview is a throwaway playthrough, never a
 * mutation of the authored story (that only happens through the session's edit tasks).
 */
export function PlayCanvas({
  session,
  version,
}: {
  session: EditorSession;
  version: number;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);
  const simRef = useRef<Simulation | null>(null);
  const mountedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  function draw(): void {
    const sim = simRef.current;
    const renderer = rendererRef.current;
    if (sim && renderer) renderer.render(sim.state);
  }

  /** Dispatch a play action, surfacing an engine throw (e.g. an infinite loop) as the inline
   *  error instead of letting it escape the Pixi event handler and crash the preview. */
  function step(action: () => void): void {
    try {
      action();
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
      simRef.current = new Simulation(story, { seed: story.meta.seed });
      draw();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Mount the renderer once; tear it down on unmount. `destroy()` requires a completed
  // `mount()`, so under StrictMode's mount→unmount→mount probe we must not destroy a
  // renderer whose async init is still in flight — defer that to the init path instead.
  useEffect(() => {
    let disposed = false;
    const renderer = new PixiRenderer({
      onAdvance: () => step(() => simRef.current?.dispatch({ type: "ADVANCE" })),
      onChoose: (index) => step(() => simRef.current?.dispatch({ type: "CHOOSE", index })),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replay from start whenever the story changes.
  useEffect(() => {
    if (mountedRef.current) void rebuild();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return (
    <section className="panel play">
      <h2>
        Play preview <span className="muted">· replays from start on every edit</span>
      </h2>
      {error ? (
        <p className="err">preview error: {error}</p>
      ) : (
        <div className="stage-host" ref={hostRef} />
      )}
      <div className="play-actions">
        <button onClick={() => void rebuild()}>⟳ Restart</button>
      </div>
    </section>
  );
}
