import { test, expect, type Page } from "@playwright/test";

interface TestHandle {
  pending: { kind: string; text?: string; who?: string };
  vars: Record<string, unknown>;
  done: boolean;
  hash: string;
  transcript: { who: string; text: string }[];
}

const ready = (page: Page) => page.waitForFunction(() => document.documentElement.dataset.ready === "1");
const handle = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ludelier: TestHandle }).__ludelier);
const advance = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ludelier: { advance(): void } }).__ludelier.advance());
const choose = (page: Page, i: number) =>
  page.evaluate(
    (idx) => (window as unknown as { __ludelier: { choose(i: number): void } }).__ludelier.choose(idx),
    i,
  );

test("plays the café story to the good ending", async ({ page }) => {
  await page.goto("/?new");
  await ready(page);

  let h = await handle(page);
  expect(h.pending.kind).toBe("say");
  expect(h.pending.text).toContain("A quiet café");

  await advance(page); // dismiss opening line -> first choice
  h = await handle(page);
  expect(h.pending.kind).toBe("choice");

  await choose(page, 0); // Sit down -> "Mind if I join you?"
  await advance(page); // -> trust+1, roll, second choice
  h = await handle(page);
  expect(h.pending.kind).toBe("choice");
  expect(h.vars.trust).toBe(1);

  await choose(page, 0); // Stay and talk (enabled: trust >= 1)
  await advance(page); // dismiss ending line -> end
  h = await handle(page);
  expect(h.done).toBe(true);
  expect(h.transcript.map((t) => t.text)).toContain("You talk for hours. The coffee goes cold, happily.");
});

test("renders the opening frame", async ({ page }) => {
  await page.goto("/?new");
  await ready(page);
  // Wait for the opening crossfade (bg + sprite fade-in) to settle to a stable frame.
  await page.waitForFunction(() => !document.documentElement.dataset.anim);
  // Give Pixi one extra frame to flush text glyphs before snapshotting.
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot("opening.png", { maxDiffPixelRatio: 0.03 });
});

test("advances and chooses via the keyboard", async ({ page }) => {
  await page.goto("/?new");
  await ready(page);

  // Enter dismisses the opening `say` (same reducer guard path as a click-advance).
  expect((await handle(page)).pending.kind).toBe("say");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await handle(page)).pending.kind).toBe("choice");

  // Digit 1 picks the first choice option -> "Mind if I join you?" (mc speaking).
  await page.keyboard.press("1");
  await expect.poll(async () => (await handle(page)).pending).toMatchObject({ kind: "say", who: "mc" });

  // Space also advances -> trust+1, roll, second choice.
  await page.keyboard.press(" ");
  await expect.poll(async () => (await handle(page)).pending.kind).toBe("choice");
  expect((await handle(page)).vars.trust).toBe(1);

  // The hidden live region mirrors the pending step for screen readers.
  await expect(page.locator('[aria-live="polite"]')).toContainText("Stay and talk");
});

test("advances and chooses via real canvas clicks", async ({ page }) => {
  await page.goto("/?new");
  await ready(page);

  const stage = page.locator('canvas[data-testid="stage"]');
  const box = await stage.boundingBox();
  if (!box) throw new Error("canvas not found");
  // Map internal 1280x720 scene coords to the (possibly scaled) displayed canvas.
  const clickAt = (ix: number, iy: number) =>
    stage.click({ position: { x: (ix / 1280) * box.width, y: (iy / 720) * box.height } });

  // A `say` is dismissed by clicking anywhere (full-screen hit layer).
  expect((await handle(page)).pending.kind).toBe("say");
  await clickAt(640, 360);
  await expect.poll(async () => (await handle(page)).pending.kind).toBe("choice");

  // First choice button is centered; for 2 options its center is ~(640, 320).
  await clickAt(640, 320);
  await expect.poll(async () => (await handle(page)).pending).toMatchObject({ kind: "say", who: "mc" });
});
