import { test, expect, type Page } from "@playwright/test";

interface TestHandle {
  pending: { kind: string; text?: string; who?: string };
  vars: Record<string, unknown>;
  done: boolean;
  hash: string;
  transcript: { who: string; text: string }[];
}

const ready = (page: Page) =>
  page.waitForFunction(() => document.documentElement.dataset.ready === "1");
const handle = (page: Page) => page.evaluate(() => (window as unknown as { __ludelier: TestHandle }).__ludelier);
const advance = (page: Page) => page.evaluate(() => (window as unknown as { __ludelier: { advance(): void } }).__ludelier.advance());
const choose = (page: Page, i: number) =>
  page.evaluate((idx) => (window as unknown as { __ludelier: { choose(i: number): void } }).__ludelier.choose(idx), i);

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
  expect(h.transcript.map((t) => t.text)).toContain(
    "You talk for hours. The coffee goes cold, happily.",
  );
});

test("renders the opening frame", async ({ page }) => {
  await page.goto("/?new");
  await ready(page);
  // Give Pixi one extra frame to flush text glyphs before snapshotting.
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot("opening.png", { maxDiffPixelRatio: 0.03 });
});
