import { Application, Assets, Container, Graphics, Sprite, Text, type Ticker } from "pixi.js";
import type { GameState, Pending, StageSprite } from "@ludelier/engine";

export interface RendererHandlers {
  onAdvance: () => void;
  onChoose: (index: number) => void;
  /** Called when transitions start (true) and settle (false). The runtime uses
   *  this to expose a "settled" flag so screenshot tests wait for a stable frame. */
  onAnimating?: (active: boolean) => void;
}

/** Per-layer stacking order (higher = nearer the viewer). All fields optional. */
export interface LayerZIndices {
  bg?: number;
  characters?: number;
  ui?: number;
}

export interface RendererOptions {
  /** Override the stacking order of the stage's top-level layers. */
  layers?: LayerZIndices;
}

/** A media asset to preload. Structurally matches @ludelier/schema's `Asset`. */
export interface AssetRef {
  id: string;
  src: string;
}

const W = 1280;
const H = 720;
const PAD = 48;
const FADE_MS = 300;
const CHAR_H = 620;
const SLOTS: Record<StageSprite["at"], number> = {
  left: W * 0.25,
  center: W * 0.5,
  right: W * 0.75,
};

/** Sane default stacking order; spaced to leave room for future layers between. */
const DEFAULT_LAYERS: Required<LayerZIndices> = { bg: 0, characters: 10, ui: 20 };

interface Tween {
  target: Container;
  from: number;
  to: number;
  elapsed: number;
  onDone?: () => void;
}

interface ShownSprite {
  sprite: Sprite;
  asset: string;
  at: StageSprite["at"];
}

/**
 * Display-only PixiJS v8 renderer for a visual-novel GameState. It draws a
 * persistent stage (background + character sprites from `state.stage`) under an
 * immediate-mode UI layer (dialog/choices from `state.pending`). Background and
 * sprite changes crossfade; all game logic lives in @ludelier/engine.
 */
export class PixiRenderer {
  readonly app: Application;
  private readonly handlers: RendererHandlers;
  private readonly layers: Required<LayerZIndices>;
  private bgLayer!: Container;
  private charLayer!: Container;
  private uiLayer!: Container;

  private bgSprite: Sprite | null = null;
  private currentBg: string | null = null;
  private readonly sprites = new Map<string, ShownSprite>();

  private tweens: Tween[] = [];
  private animating = false;

  constructor(handlers: RendererHandlers, options: RendererOptions = {}) {
    this.app = new Application();
    this.handlers = handlers;
    this.layers = {
      bg: options.layers?.bg ?? DEFAULT_LAYERS.bg,
      characters: options.layers?.characters ?? DEFAULT_LAYERS.characters,
      ui: options.layers?.ui ?? DEFAULT_LAYERS.ui,
    };
  }

  async mount(parent: HTMLElement): Promise<void> {
    await this.app.init({ width: W, height: H, background: "#0e1117", antialias: true });
    this.app.canvas.setAttribute("data-testid", "stage");
    parent.appendChild(this.app.canvas);

    // Each layer owns a dedicated zIndex so stacking is explicit and independent of
    // add-order: background < characters < UI. Spaced to leave room for future layers.
    this.app.stage.sortableChildren = true;
    this.bgLayer = new Container();
    this.bgLayer.zIndex = this.layers.bg;
    this.charLayer = new Container();
    this.charLayer.zIndex = this.layers.characters;
    this.charLayer.sortableChildren = true; // sprites ordered by zIndex = stable id rank
    this.uiLayer = new Container();
    this.uiLayer.zIndex = this.layers.ui;
    this.app.stage.addChild(this.bgLayer, this.charLayer, this.uiLayer);

    this.app.ticker.add(this.tick);
  }

  destroy(): void {
    this.app.ticker.remove(this.tick);
    this.app.destroy(true, { children: true });
  }

  /** True while a transition is in flight; screenshot tests should wait for false. */
  isAnimating(): boolean {
    return this.animating;
  }

  /** Register and load every story asset up front so `render()` is synchronous. */
  async preload(assets: readonly AssetRef[]): Promise<void> {
    if (assets.length === 0) return;
    Assets.add(assets.map((a) => ({ alias: a.id, src: a.src })));
    await Assets.load(assets.map((a) => a.id));
  }

  render(state: GameState): void {
    this.reconcileBackground(state.stage.bg);
    this.reconcileSprites(state.stage.sprites);
    this.drawUi(state.pending);
  }

  // ---- stage: background ----------------------------------------------------

  private reconcileBackground(bg: string | null): void {
    if (bg === this.currentBg) return;
    const old = this.bgSprite;
    if (bg) {
      const next = this.makeBackground(bg);
      next.alpha = 0;
      this.bgLayer.addChild(next);
      this.bgSprite = next;
      this.startTween(next, 1, () => this.discard(this.bgLayer, old));
    } else {
      this.bgSprite = null;
      if (old) this.startTween(old, 0, () => this.discard(this.bgLayer, old));
    }
    this.currentBg = bg;
  }

  private makeBackground(asset: string): Sprite {
    const sprite = new Sprite(this.texture(asset));
    sprite.anchor.set(0.5);
    sprite.position.set(W / 2, H / 2);
    // Cover-fit: fill the stage, cropping overflow, preserving aspect ratio.
    sprite.scale.set(Math.max(W / sprite.texture.width, H / sprite.texture.height));
    return sprite;
  }

  // ---- stage: character sprites ---------------------------------------------

  private reconcileSprites(target: readonly StageSprite[]): void {
    const wanted = new Set(target.map((s) => s.id));
    for (const [id, shown] of this.sprites) {
      if (!wanted.has(id)) {
        this.sprites.delete(id);
        this.startTween(shown.sprite, 0, () => this.discard(this.charLayer, shown.sprite));
      }
    }
    // `target` is sorted by id (engine guarantee); zIndex = rank gives stable z-order.
    target.forEach((spec, rank) => {
      const existing = this.sprites.get(spec.id);
      if (existing && existing.asset === spec.asset && existing.at === spec.at) {
        existing.sprite.zIndex = rank;
        return;
      }
      if (existing) this.startTween(existing.sprite, 0, () => this.discard(this.charLayer, existing.sprite));
      const sprite = this.makeCharacter(spec.asset, spec.at);
      sprite.zIndex = rank;
      sprite.alpha = 0;
      this.charLayer.addChild(sprite);
      this.sprites.set(spec.id, { sprite, asset: spec.asset, at: spec.at });
      this.startTween(sprite, 1);
    });
  }

  private makeCharacter(asset: string, at: StageSprite["at"]): Sprite {
    const sprite = new Sprite(this.texture(asset));
    sprite.anchor.set(0.5, 1); // bottom-center: sprites "stand" on the stage floor
    sprite.position.set(SLOTS[at], H);
    sprite.scale.set(CHAR_H / sprite.texture.height);
    return sprite;
  }

  // ---- UI layer (immediate mode) --------------------------------------------

  private drawUi(p: Pending): void {
    for (const child of this.uiLayer.removeChildren()) child.destroy();

    if (p.kind === "say") {
      this.addAdvanceLayer();
      this.addDialog(p.who, p.text);
      this.addHint("click to continue ▸");
    } else if (p.kind === "choice") {
      if (p.prompt) this.addDialog("", p.prompt);
      this.addChoices(p.options);
    } else {
      this.addDialog("", "— fin —");
    }
  }

  /** Full-screen transparent hit layer: clicking anywhere advances a `say`. */
  private addAdvanceLayer(): void {
    const layer = new Graphics().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.001 });
    layer.eventMode = "static";
    layer.cursor = "pointer";
    layer.on("pointertap", () => this.handlers.onAdvance());
    this.uiLayer.addChild(layer);
  }

  private addDialog(who: string, text: string): void {
    const boxH = 220;
    const y = H - boxH - PAD;
    this.uiLayer.addChild(
      new Graphics().roundRect(PAD, y, W - PAD * 2, boxH, 16).fill({ color: 0x161b26, alpha: 0.96 }),
    );

    if (who) {
      const name = new Text({
        text: who,
        style: { fill: "#6ab0ff", fontSize: 26, fontWeight: "700", fontFamily: "system-ui, sans-serif" },
      });
      name.position.set(PAD + 28, y + 22);
      this.uiLayer.addChild(name);
    }

    const body = new Text({
      text,
      style: {
        fill: "#e8ecf4",
        fontSize: 28,
        fontFamily: "system-ui, sans-serif",
        wordWrap: true,
        wordWrapWidth: W - PAD * 2 - 56,
        lineHeight: 38,
      },
    });
    body.position.set(PAD + 28, y + (who ? 64 : 28));
    this.uiLayer.addChild(body);
  }

  private addHint(text: string): void {
    const hint = new Text({ text, style: { fill: "#5b6577", fontSize: 18, fontFamily: "system-ui, sans-serif" } });
    hint.position.set(W - PAD - 28 - hint.width, H - PAD - 36);
    this.uiLayer.addChild(hint);
  }

  private addChoices(options: { label: string; goto: string; enabled: boolean }[]): void {
    const btnH = 64;
    const gap = 16;
    const btnW = 720;
    const totalH = options.length * btnH + Math.max(0, options.length - 1) * gap;
    let y = (H - totalH) / 2;
    const x = (W - btnW) / 2;

    options.forEach((opt, i) => {
      const container = new Container();
      const fillColor = opt.enabled ? 0x1f2a3d : 0x161922;
      container.addChild(
        new Graphics()
          .roundRect(0, 0, btnW, btnH, 12)
          .fill(fillColor)
          .stroke({ color: opt.enabled ? 0x2f6fb0 : 0x2a2f3a, width: 2 }),
      );

      const label = new Text({
        text: opt.label,
        style: { fill: opt.enabled ? "#e8ecf4" : "#5b6577", fontSize: 24, fontFamily: "system-ui, sans-serif" },
      });
      label.position.set(24, (btnH - label.height) / 2);
      container.addChild(label);

      container.position.set(x, y);
      if (opt.enabled) {
        container.eventMode = "static";
        container.cursor = "pointer";
        container.on("pointertap", () => this.handlers.onChoose(i));
      }
      this.uiLayer.addChild(container);
      y += btnH + gap;
    });
  }

  // ---- tween engine ---------------------------------------------------------

  private texture(asset: string) {
    const tex = Assets.get(asset);
    if (!tex) throw new Error(`asset not preloaded: "${asset}"`);
    return tex;
  }

  private startTween(target: Container, to: number, onDone?: () => void): void {
    // Replace any in-flight tween on the same target so toggles don't stack.
    this.tweens = this.tweens.filter((t) => t.target !== target);
    this.tweens.push({ target, from: target.alpha, to, elapsed: 0, onDone });
    this.setAnimating(true);
  }

  private readonly tick = (ticker: Ticker): void => {
    if (this.tweens.length === 0) return;
    const remaining: Tween[] = [];
    for (const tw of this.tweens) {
      tw.elapsed += ticker.deltaMS;
      const t = Math.min(1, tw.elapsed / FADE_MS);
      tw.target.alpha = tw.from + (tw.to - tw.from) * t;
      if (t >= 1) {
        tw.target.alpha = tw.to; // snap to final — no float drift in screenshots
        tw.onDone?.();
      } else {
        remaining.push(tw);
      }
    }
    this.tweens = remaining;
    if (this.tweens.length === 0) this.setAnimating(false);
  };

  private discard(layer: Container, sprite: Sprite | null): void {
    if (!sprite) return;
    layer.removeChild(sprite);
    sprite.destroy(); // keep the shared cached texture; only free the sprite
  }

  private setAnimating(active: boolean): void {
    if (active === this.animating) return;
    this.animating = active;
    this.handlers.onAnimating?.(active);
  }
}
