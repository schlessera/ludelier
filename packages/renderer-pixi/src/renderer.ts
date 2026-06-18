import { Application, Container, Graphics, Text } from "pixi.js";
import type { GameState, Pending } from "@ludelier/engine";

export interface RendererHandlers {
  onAdvance: () => void;
  onChoose: (index: number) => void;
}

const W = 1280;
const H = 720;
const PAD = 48;

/**
 * Display-only PixiJS v8 renderer for a visual-novel GameState. Immediate-mode:
 * `render(state)` clears and redraws the scene from `state.pending`. All game
 * logic lives in @ludelier/engine; this layer only draws and forwards input.
 */
export class PixiRenderer {
  readonly app: Application;
  private readonly handlers: RendererHandlers;
  private scene!: Container;

  constructor(handlers: RendererHandlers) {
    this.app = new Application();
    this.handlers = handlers;
  }

  async mount(parent: HTMLElement): Promise<void> {
    await this.app.init({ width: W, height: H, background: "#0e1117", antialias: true });
    this.app.canvas.setAttribute("data-testid", "stage");
    parent.appendChild(this.app.canvas);
    this.scene = new Container();
    this.app.stage.addChild(this.scene);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }

  render(state: GameState): void {
    this.scene.removeChildren();
    this.scene.addChild(new Graphics().rect(0, 0, W, H).fill("#0e1117"));

    const p: Pending = state.pending;
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
    this.scene.addChild(layer);
  }

  private addDialog(who: string, text: string): void {
    const boxH = 220;
    const y = H - boxH - PAD;
    this.scene.addChild(
      new Graphics().roundRect(PAD, y, W - PAD * 2, boxH, 16).fill({ color: 0x161b26, alpha: 0.96 }),
    );

    if (who) {
      const name = new Text({
        text: who,
        style: { fill: "#6ab0ff", fontSize: 26, fontWeight: "700", fontFamily: "system-ui, sans-serif" },
      });
      name.position.set(PAD + 28, y + 22);
      this.scene.addChild(name);
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
    this.scene.addChild(body);
  }

  private addHint(text: string): void {
    const hint = new Text({ text, style: { fill: "#5b6577", fontSize: 18, fontFamily: "system-ui, sans-serif" } });
    hint.position.set(W - PAD - 28 - hint.width, H - PAD - 36);
    this.scene.addChild(hint);
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
      this.scene.addChild(container);
      y += btnH + gap;
    });
  }
}
