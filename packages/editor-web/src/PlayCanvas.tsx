import { useEffect, useRef, useState } from "react";
import { type Action, Simulation } from "@ludelier/engine";
import { AudioPlayer, type AudioSource } from "@ludelier/audio-web";
import { Howl } from "howler";
import { PixiRenderer, type AssetRef } from "@ludelier/renderer-pixi";
import type { Asset } from "@ludelier/schema";
import type { EditorSession } from "@ludelier/editor-core";

// Pixi's Assets registry is a global singleton; track each completed alias and reserve aliases
// while their preload is in flight. Reserving before awaiting prevents two rebuilds from racing
// the same id to different URLs and lets an already-current same-URL preload be shared.
const loadedAssets = new Map<string, string>();
const pendingAssets = new Map<string, { src: string; settled: Promise<void> }>();

/** Pixi only preloads visual media. Audio URLs are resolved by the separate AudioPlayer. */
export function imageAssets(assets: readonly Asset[]): readonly AssetRef[] {
  return assets.filter((asset) => asset.kind === "image");
}

export function resolveAudioSource(assets: readonly Asset[], assetId: string): AudioSource | undefined {
  const asset = assets.find((candidate) => candidate.id === assetId && candidate.kind === "audio");
  return asset ? { src: asset.src, generated: asset.generated } : undefined;
}

export async function ensureAssets(
  renderer: Pick<PixiRenderer, "preload">,
  assets: readonly AssetRef[],
): Promise<void> {
  const fresh: AssetRef[] = [];
  const pending: Promise<void>[] = [];
  for (const asset of assets) {
    const loadedSrc = loadedAssets.get(asset.id);
    if (loadedSrc !== undefined) {
      if (loadedSrc !== asset.src) {
        throw new Error(
          `asset "${asset.id}" is already loaded from "${loadedSrc}" — reload the page to load "${asset.src}"`,
        );
      }
      continue;
    }

    const loading = pendingAssets.get(asset.id);
    if (loading) {
      if (loading.src !== asset.src) {
        throw new Error(
          `asset "${asset.id}" is already loading from "${loading.src}" — reload the page to load "${asset.src}"`,
        );
      }
      pending.push(loading.settled);
      continue;
    }
    fresh.push(asset);
  }

  if (fresh.length > 0) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((resolveLoad, rejectLoad) => {
      resolve = resolveLoad;
      reject = rejectLoad;
    });
    // A failed first preload may not have a concurrent waiter; observe that rejection here while
    // still propagating it through this caller's awaited preload.
    void settled.catch(() => undefined);
    for (const asset of fresh) pendingAssets.set(asset.id, { src: asset.src, settled });
    try {
      await renderer.preload(fresh);
      for (const asset of fresh) loadedAssets.set(asset.id, asset.src);
      resolve();
    } catch (error) {
      reject(error);
      throw error;
    } finally {
      for (const asset of fresh) {
        if (pendingAssets.get(asset.id)?.settled === settled) pendingAssets.delete(asset.id);
      }
    }
  }

  await Promise.all(pending);
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
  const playerRef = useRef<AudioPlayer | null>(null);
  /** Every rebuild claims a generation; an older async preload must never replace newer preview state. */
  const rebuildGenerationRef = useRef(0);
  /** The preview playthrough's own action history — replayed after an edit so the author
   *  isn't yanked back to the start on every change. Cleared by Restart / play-from-here. */
  const actionsRef = useRef<Action[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [generatedVoice, setGeneratedVoice] = useState(false);

  function draw(): void {
    const sim = simRef.current;
    const renderer = rendererRef.current;
    if (sim && renderer) renderer.render(sim.state);
  }

  function reconcileAudio(initializing = false): void {
    const audio = simRef.current?.state.audio;
    const player = playerRef.current;
    if (!audio || !player) return;
    if (initializing) player.initialize(audio);
    else player.reconcile(audio);
  }

  /** Dispatch a play action, surfacing an engine throw (e.g. an infinite loop) as the inline
   *  error instead of letting it escape the Pixi event handler and crash the preview. */
  function step(action: Action): void {
    try {
      simRef.current?.dispatch(action);
      actionsRef.current.push(action);
      reconcileAudio();
      draw();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function rebuild(): Promise<void> {
    const generation = ++rebuildGenerationRef.current;
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      const story = session.story;
      await ensureAssets(renderer, imageAssets(story.assets));
      if (generation !== rebuildGenerationRef.current || renderer !== rendererRef.current) return;

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
      reconcileAudio(true);
      draw();
      setError(null);
    } catch (e) {
      if (generation !== rebuildGenerationRef.current || renderer !== rendererRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Forget the recorded playthrough and rebuild from the (selected) start. */
  function restart(): void {
    actionsRef.current = [];
    void rebuild();
  }

  function toggleMuted(): void {
    const nextMuted = !muted;
    playerRef.current?.activate();
    playerRef.current?.setMuted(nextMuted);
    setMuted(nextMuted);
  }

  function changeVolume(nextVolume: number): void {
    playerRef.current?.setVolume(nextVolume);
    setVolume(nextVolume);
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
    const player = new AudioPlayer({
      createHowl: (options) => new Howl(options),
      resolveSource: (asset) => resolveAudioSource(session.story.assets, asset),
      muted: true,
      onVoiceStart: (_asset, source) => setGeneratedVoice(source.generated),
      onVoiceEnd: () => setGeneratedVoice(false),
    });
    playerRef.current = player;
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
      rebuildGenerationRef.current += 1;
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
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
        <button
          type="button"
          onClick={toggleMuted}
          aria-pressed={muted}
          aria-label={muted ? "Unmute audio" : "Mute audio"}
        >
          {muted ? "Unmute audio" : "Mute audio"}
        </button>
        <label>
          Volume
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            aria-label="Audio volume"
            onChange={(event) => changeVolume(event.currentTarget.valueAsNumber)}
          />
        </label>
        {generatedVoice && <p role="status">Generated voice audio is playing.</p>}
      </div>
    </section>
  );
}
