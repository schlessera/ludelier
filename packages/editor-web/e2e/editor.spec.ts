import { test, expect, type Page } from "@playwright/test";

// The bundled example story (examples/cafe.story.json) ships with 8 nodes.
const CAFE_NODES = 8;

/** Load the editor and wait for the shell's readiness flag (set in App.tsx after first render). */
async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
}

test("loads the café story with a valid badge and its title in the toolbar", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId("validity-badge")).toHaveText("valid");
  await expect(page.getByTestId("story-title")).toHaveText("Café Encounter");
});

test("story map renders every node, with a start badge", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator(".map-node")).toHaveCount(CAFE_NODES);
  const start = page.getByTestId("map-node-start");
  await expect(start).toBeVisible();
  await expect(start.locator(".tag")).toHaveText("start");
  await expect(page.getByTestId("map-node-ending_good")).toBeVisible();
});

test("clicking a map node opens the script lens with its statements", async ({ page }) => {
  await openEditor(page);
  await page.getByTestId("map-node-start").click();
  const lens = page.getByTestId("script-lens");
  await expect(lens.locator("h3")).toContainText("start");
  await expect(lens.locator("h3")).toContainText("5 stmt");
  await expect(lens.locator(".stmt")).toHaveCount(5);
  await expect(lens.locator(".stmt .line").first()).toHaveText("scene · bg bg_cafe");
});

test("toolbar create-node adds a flagged node to the map and undo removes it", async ({ page }) => {
  await openEditor(page);
  const input = page.getByTestId("new-node-id");
  await input.fill("e2e-scratch");
  await input.press("Enter");
  const added = page.getByTestId("map-node-e2e-scratch");
  // A fresh empty node is disconnected: not reachable from start, and can't reach an end.
  await expect(added.locator(".tag.bad")).toHaveText(["unreachable", "dead end"]);
  await expect(page.locator(".map-node")).toHaveCount(CAFE_NODES + 1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(added).toHaveCount(0);
  await expect(page.locator(".map-node")).toHaveCount(CAFE_NODES);
});

test("a manifest-driven set-meta form edit updates the toolbar title", async ({ page }) => {
  await openEditor(page);
  await page.locator("details.edit-tasks > summary").click();
  const task = page.locator("details.edit-task").filter({ has: page.getByText("set-meta", { exact: true }) });
  await task.locator("summary").click();
  const title = task.getByLabel("title");
  await expect(title).toHaveValue("Café Encounter"); // prefilled from the live story meta
  await title.fill("Café Encounter (e2e)");
  await task.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("story-title")).toHaveText("Café Encounter (e2e)");
});

test("the play preview canvas mounts and is drawing", async ({ page }) => {
  await openEditor(page);
  const stage = page.locator('canvas[data-testid="stage"]');
  // Pixi init + asset preload happen after first render — give the cold path headroom.
  await expect(stage).toBeVisible({ timeout: 15_000 });
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
  // A live drawing buffer, and no init/replay error overlay.
  expect(await stage.evaluate((el: HTMLCanvasElement) => el.width * el.height)).toBeGreaterThan(0);
  await expect(page.locator(".stage-error")).toHaveCount(0);
});
