import { describe, expect, it } from "vitest";
import type { Statement } from "@ludelier/schema";
import { renderStatement } from "../src/storymap/script";

describe("renderStatement", () => {
  it("renders a say line with speaker and quoted text", () => {
    expect(renderStatement({ op: "say", who: "anna", text: "Morning!" })).toBe('anna: "Morning!"');
  });

  it("renders staging statements readably", () => {
    expect(renderStatement({ op: "scene", bg: "cafe_day" })).toBe("scene · bg cafe_day");
    expect(renderStatement({ op: "scene" })).toBe("scene · bg (none)");
    expect(renderStatement({ op: "show", sprite: "anna", asset: "anna_smile", at: "left" })).toBe(
      "show anna = anna_smile @ left",
    );
    expect(renderStatement({ op: "hide", sprite: "anna" })).toBe("hide anna");
  });

  it("renders state statements readably", () => {
    expect(renderStatement({ op: "set", var: "gold", value: 5 })).toBe("set gold = 5");
    expect(renderStatement({ op: "add", var: "gold", amount: 3 })).toBe("gold += 3");
    expect(renderStatement({ op: "add", var: "gold", amount: -2 })).toBe("gold -= 2");
    expect(renderStatement({ op: "roll", var: "luck", min: 1, max: 6 })).toBe("roll luck = 1..6");
  });

  it("renders flow statements with targets and conditions", () => {
    expect(renderStatement({ op: "jump", goto: "end" })).toBe("jump → end");
    expect(renderStatement({ op: "branch", cond: { var: "mood", cmp: "lt", value: 0 }, goto: "sulk" })).toBe(
      "branch if mood < 0 → sulk",
    );
    expect(renderStatement({ op: "end" })).toBe("end");
  });

  it("renders a choice across multiple lines, one per option, with conditions", () => {
    const choice: Statement = {
      op: "choice",
      prompt: "What now?",
      options: [
        { label: "Pay now", goto: "checkout" },
        { label: "Run a tab", goto: "tab", if: { var: "gold", cmp: "gt", value: 5 } },
      ],
    };
    const out = renderStatement(choice);
    expect(out).toBe('choice "What now?"\n  → "Pay now" → checkout\n  → "Run a tab" → tab (if gold > 5)');
  });

  it("is deterministic", () => {
    const s: Statement = { op: "say", who: "n", text: "x" };
    expect(renderStatement(s)).toBe(renderStatement(s));
  });
});
