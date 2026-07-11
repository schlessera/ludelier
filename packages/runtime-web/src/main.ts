import { validateStory } from "@ludelier/schema";
import { hashState, type Pending, Simulation, StatementBudgetError } from "@ludelier/engine";
import { AudioPlayer, type AudioSource } from "@ludelier/audio-web";
import { Howl } from "howler";
import { PixiRenderer } from "@ludelier/renderer-pixi";
import storyData from "../../../examples/cafe.story.json";
import { clearSave, loadSave, saveState } from "./save";

// This query-selected fixture exercises browser-only audio presentation behavior without
// changing the playable café example. Its generated flag is the disclosure boundary under test.
const generatedVoiceFixture = {
  meta: { id: "generated-voice-e2e", title: "Generated voice fixture", start: "start", seed: 1 },
  characters: [{ id: "narrator", name: "Narrator" }],
  assets: [
    { id: "ordinary", src: "/assets/e2e-generated-voice.wav", kind: "audio", generated: false },
    // Three seconds gives browser E2E a deterministic visible playback window before onend.
    { id: "generated-natural", src: "/assets/e2e-generated-voice.wav", kind: "audio", generated: true },
    { id: "generated-loop", src: "/assets/e2e-generated-voice.wav", kind: "audio", generated: true },
  ],
  nodes: [
    {
      id: "start",
      body: [
        { op: "say", who: "narrator", text: "Ready." },
        { op: "sound", channel: "voice", asset: "ordinary", loop: true },
        { op: "say", who: "narrator", text: "Ordinary voice." },
        { op: "stop-sound", channel: "voice" },
        { op: "sound", channel: "voice", asset: "generated-natural" },
        { op: "say", who: "narrator", text: "Generated natural voice." },
        { op: "sound", channel: "voice", asset: "generated-loop", loop: true },
        { op: "say", who: "narrator", text: "Generated looping voice." },
        { op: "stop-sound", channel: "voice" },
        { op: "say", who: "narrator", text: "Voice stopped." },
        { op: "end" },
      ],
    },
  ],
};

// Content is validated at load time — the same Zod guardrail AI-authored stories pass.
const fixture = new URLSearchParams(location.search).get("fixture");
const parsed = validateStory(fixture === "generated-voice" ? generatedVoiceFixture : storyData);
if (!parsed.success) {
  throw new Error("invalid story: " + JSON.stringify(parsed.issues, null, 2));
}
const story = parsed.data;
// Fingerprint binds saves to this exact story: a PWA update that changes the story
// invalidates old saves instead of restoring a cursor into nodes that moved/vanished.
const storyHash = hashState(story);
// id → display name for screen-reader announcements (`pending.who` is the character *id*).
const characterNames = new Map(story.characters.map((c) => [c.id, c.name]));

// The renderer receives only images. Audio remains a browser presentation concern with its own
// source resolver, rather than leaking media policy into Pixi or the simulation.
const imageAssets = story.assets.filter((asset) => asset.kind === "image");
const audioSources = new Map<string, AudioSource>(
  story.assets
    .filter((asset) => asset.kind === "audio")
    .map((asset) => [asset.id, { src: asset.src, generated: asset.generated }]),
);

let sim: Simulation;
let liveRegion: HTMLElement | null = null;
let audioPlayer: AudioPlayer | null = null;
let generatedVoiceNotice: HTMLElement | null = null;

/**
 * Show a recoverable error overlay instead of hard-crashing the page. The reducer throws a
 * `StatementBudgetError` on an infinite jump loop (a story bug that can slip past static
 * validation via conditions); catching it keeps the player from white-screening.
 */
function fatal(err: unknown): void {
  const message =
    err instanceof StatementBudgetError
      ? "This story has an infinite loop and can't be played. (A node jumps in a cycle with no way to stop.)"
      : `Playback error: ${err instanceof Error ? err.message : String(err)}`;
  const root = document.getElementById("app");
  if (root) {
    root.innerHTML = "";
    const box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif;color:#eee;background:#1a1a1a";
    const p = document.createElement("p");
    p.textContent = message;
    p.style.cssText = "max-width:32rem;font-size:1rem;line-height:1.5";
    const a = document.createElement("a");
    a.href = "?new";
    a.textContent = "Restart from the beginning";
    a.style.cssText = "color:#8ab4f8";
    box.append(p, a);
    root.append(box);
  }
  audioPlayer?.dispose();
  document.documentElement.dataset.error = "1";
}

/** Run a play step, surfacing any engine throw as a recoverable overlay rather than a crash. */
function safeStep(step: () => void): void {
  try {
    step();
    update();
  } catch (err) {
    fatal(err);
  }
}

function doAdvance(): void {
  safeStep(() => sim.dispatch({ type: "ADVANCE" }));
}

function doChoose(index: number): void {
  safeStep(() => sim.dispatch({ type: "CHOOSE", index }));
}

/**
 * Keyboard input: Enter/Space advance, digits 1–9 pick a choice option. The handler only
 * dispatches — the reducer's own guards decide (ADVANCE acts only on a pending `say`;
 * CHOOSE only on an enabled option of a pending choice), so it can never bypass game rules.
 * Registered after the simulation exists (see `main`).
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.target instanceof Element && e.target.closest('[aria-label="Audio controls"]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return; // don't hijack shortcuts / held keys
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault(); // Space must not scroll the page
    doAdvance();
  } else if (e.key >= "1" && e.key <= "9") {
    doChoose(Number(e.key) - 1);
  }
}

/**
 * Visually-hidden polite live region mirroring the current step, so screen-reader users
 * can follow the canvas-only presentation. The accessibility floor, not the ceiling.
 */
function createLiveRegion(parent: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-live", "polite");
  el.style.cssText =
    "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
  parent.append(el);
  return el;
}

/** Build keyboard-accessible controls without coupling playback state back into GameState. */
function createAudioControls(parent: HTMLElement, player: AudioPlayer): HTMLElement {
  const controls = document.createElement("div");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Audio controls");
  controls.style.cssText =
    "position:fixed;right:12px;bottom:12px;z-index:1;display:flex;align-items:center;gap:8px;padding:8px;background:#0e1117d9;color:#eee;font:14px system-ui,sans-serif";

  const mute = document.createElement("button");
  mute.type = "button";
  const volumeLabel = document.createElement("label");
  volumeLabel.textContent = "Volume";
  const volume = document.createElement("input");
  volume.id = "audio-volume";
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.05";
  volume.value = String(player.getVolume());
  volume.setAttribute("aria-label", "Audio volume");
  volumeLabel.htmlFor = volume.id;
  const disclosure = document.createElement("p");
  disclosure.hidden = true;
  disclosure.setAttribute("role", "status");
  disclosure.style.margin = "0";

  const updateMuteLabel = () => {
    const muted = player.isMuted();
    mute.textContent = muted ? "Unmute audio" : "Mute audio";
    mute.setAttribute("aria-label", muted ? "Unmute audio" : "Mute audio");
    mute.setAttribute("aria-pressed", String(muted));
    document.documentElement.dataset.audioMuted = muted ? "1" : "0";
  };
  mute.addEventListener("click", () => {
    const nextMuted = !player.isMuted();
    player.activate();
    player.setMuted(nextMuted);
    updateMuteLabel();
  });
  volume.addEventListener("input", () => player.setVolume(volume.valueAsNumber));
  updateMuteLabel();

  controls.append(mute, volumeLabel, volume, disclosure);
  parent.append(controls);
  return disclosure;
}

function updateGeneratedVoiceNotice(source: AudioSource | null): void {
  if (!generatedVoiceNotice) return;
  const generated = source?.generated === true;
  generatedVoiceNotice.hidden = !generated;
  generatedVoiceNotice.textContent = generated ? "Generated voice audio is playing." : "";
}

/** The current pending step as one announceable line. */
function announcement(p: Pending): string {
  switch (p.kind) {
    case "say":
      return `${characterNames.get(p.who) ?? p.who}: ${p.text}`;
    case "choice": {
      const options = p.options
        .map((o, i) => `${i + 1}. ${o.label}${o.enabled ? "" : " (unavailable)"}`)
        .join(" ");
      return `${p.prompt ?? "Choose:"} ${options}`;
    }
    case "end":
      return "The end.";
  }
}

const renderer = new PixiRenderer({
  onAdvance: doAdvance,
  onChoose: doChoose,
  // Mirror transition state into the DOM so tests can wait for a settled frame.
  onAnimating: (active) => {
    if (active) document.documentElement.dataset.anim = "1";
    else delete document.documentElement.dataset.anim;
  },
});

function update(): void {
  renderer.render(sim.state);
  if (liveRegion) {
    const line = announcement(sim.state.pending);
    // Only touch the DOM when the line changes — rewriting identical text re-announces it.
    if (liveRegion.textContent !== line) liveRegion.textContent = line;
  }
  audioPlayer?.reconcile(sim.state.audio);
  void saveState(story.meta.id, storyHash, sim.state);
  // Agent-native test surface: every action a player can take is callable here too.
  (window as unknown as { __ludelier: unknown }).__ludelier = {
    pending: sim.state.pending,
    vars: sim.state.vars,
    stage: sim.state.stage,
    done: sim.state.done,
    hash: sim.hash(),
    transcript: sim.transcript(),
    advance: doAdvance,
    choose: doChoose,
  };
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app not found");

  // Mount + preload are the likeliest real-world failures (a 404'd asset, WebGL init) —
  // they must surface as the recoverable overlay too, not an unhandled rejection with
  // neither data-ready nor data-error ever set.
  try {
    await renderer.mount(root);
    renderer.setCharacters(story.characters);
    // Preload every declared asset up front so render() stays synchronous.
    // Preload only visual assets; audio URLs are resolved by AudioPlayer when a cue is played.
    await renderer.preload(imageAssets);
  } catch (err) {
    fatal(err);
    return;
  }

  // ?new starts fresh; otherwise resume the local save (local-first).
  const fresh = new URLSearchParams(location.search).has("new");
  if (fresh) {
    await clearSave(story.meta.id);
  }

  liveRegion = createLiveRegion(root);

  // Building the initial state runs the opening statements — a looping story throws here too.
  try {
    sim = new Simulation(story, { seed: story.meta.seed });
    if (!fresh) {
      const saved = await loadSave(story.meta.id, storyHash);
      if (saved) sim.state = saved;
    }
    audioPlayer = new AudioPlayer({
      createHowl: (options) => new Howl(options),
      resolveSource: (asset) => audioSources.get(asset),
      // Do not create/play Howls until the explicit Unmute control is clicked.
      muted: true,
      onVoiceStart: (_asset, source) => updateGeneratedVoiceNotice(source),
      onVoiceEnd: () => updateGeneratedVoiceNotice(null),
    });
    generatedVoiceNotice = createAudioControls(root, audioPlayer);
    audioPlayer.initialize(sim.state.audio);
    update();
  } catch (err) {
    fatal(err);
    return;
  }
  // Only listen once a simulation exists — a keypress during init must not dispatch into nothing.
  document.addEventListener("keydown", onKeydown);
  // BFCache preserves this document and its controls. Keep the presentation adapter alive for a
  // persisted pagehide; only a real unload must release its browser-owned audio resources.
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    audioPlayer?.dispose();
    audioPlayer = null;
  });
  // Signal first paint is done — Playwright waits on this before asserting/screenshotting.
  requestAnimationFrame(() => {
    document.documentElement.dataset.ready = "1";
  });
}

void main();
