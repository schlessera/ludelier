import { validateStory } from "@ludelier/schema";
import { Simulation } from "@ludelier/engine";
import { PixiRenderer } from "@ludelier/renderer-pixi";
import storyData from "../../../examples/cafe.story.json";
import { clearSave, loadSave, saveState } from "./save";

// Content is validated at load time — the same Zod guardrail AI-authored stories pass.
const parsed = validateStory(storyData);
if (!parsed.success) {
  throw new Error("invalid story: " + JSON.stringify(parsed.issues, null, 2));
}
const story = parsed.data;

const sim = new Simulation(story, { seed: story.meta.seed });

function doAdvance(): void {
  sim.dispatch({ type: "ADVANCE" });
  update();
}

function doChoose(index: number): void {
  sim.dispatch({ type: "CHOOSE", index });
  update();
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
  void saveState(story.meta.id, sim.state);
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

  await renderer.mount(root);
  // Preload every declared asset up front so render() stays synchronous.
  await renderer.preload(story.assets);

  // ?new starts fresh; otherwise resume the local save (local-first).
  const fresh = new URLSearchParams(location.search).has("new");
  if (fresh) {
    await clearSave(story.meta.id);
  } else {
    const saved = await loadSave(story.meta.id);
    if (saved) sim.state = saved;
  }

  update();
  // Signal first paint is done — Playwright waits on this before asserting/screenshotting.
  requestAnimationFrame(() => {
    document.documentElement.dataset.ready = "1";
  });
}

void main();
