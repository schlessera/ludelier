import { validateStory } from "@ludelier/schema";
import { Simulation, StatementBudgetError } from "@ludelier/engine";
import { PixiRenderer } from "@ludelier/renderer-pixi";
import storyData from "../../../examples/cafe.story.json";
import { clearSave, loadSave, saveState } from "./save";

// Content is validated at load time — the same Zod guardrail AI-authored stories pass.
const parsed = validateStory(storyData);
if (!parsed.success) {
  throw new Error("invalid story: " + JSON.stringify(parsed.issues, null, 2));
}
const story = parsed.data;

let sim: Simulation;

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
  }

  // Building the initial state runs the opening statements — a looping story throws here too.
  try {
    sim = new Simulation(story, { seed: story.meta.seed });
    if (!fresh) {
      const saved = await loadSave(story.meta.id);
      if (saved) sim.state = saved;
    }
    update();
  } catch (err) {
    fatal(err);
    return;
  }
  // Signal first paint is done — Playwright waits on this before asserting/screenshotting.
  requestAnimationFrame(() => {
    document.documentElement.dataset.ready = "1";
  });
}

void main();
