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
  await page.getByRole("tab", { name: "Edit" }).click(); // edit forms now live in the inspector's Edit tab
  const task = page.locator("details.edit-task").filter({ has: page.getByText("set-meta", { exact: true }) });
  await task.locator("summary").click();
  const title = task.getByLabel("title");
  await expect(title).toHaveValue("Café Encounter"); // prefilled from the live story meta
  await title.fill("Café Encounter (e2e)");
  await task.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("story-title")).toHaveText("Café Encounter (e2e)");
});

test("inspector tabs expose linked panels and keyboard navigation", async ({ page }) => {
  await openEditor(page);
  const assets = page.getByRole("tab", { name: "Assets" });
  await expect(assets).toHaveAttribute("id", "inspector-tab-assets");
  await expect(assets).toHaveAttribute("aria-controls", "inspector-panel-assets");

  await assets.click();
  const panel = page.locator("#inspector-panel-assets");
  await expect(panel).toHaveAttribute("aria-labelledby", "inspector-tab-assets");
  await expect(panel).toBeVisible();
  await assets.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
});

test("the play preview canvas mounts and is drawing", async ({ page }) => {
  await openEditor(page);
  // The preview is now on-demand: open the overlay from the story-map's Play CTA.
  await page.getByRole("button", { name: "Play from start" }).click();
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

test("asset inspector is visible but cannot generate or persist a BYOK key by default", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Assets" }).click();

  const panel = page.getByTestId("asset-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Generate & save" })).toBeDisabled();

  const key = "e2e-asset-key-not-persisted";
  await panel.getByLabel("Asset API key").fill(key);
  await expect(panel.getByRole("button", { name: "Generate & save" })).toBeDisabled();
  expect(
    await page.evaluate(
      (secret) => Object.keys(localStorage).some((name) => localStorage.getItem(name)?.includes(secret)),
      key,
    ),
  ).toBe(false);
});

test("authorized human generation previews, registers Story metadata, and sends no secret to dev persistence", async ({
  page,
}) => {
  const prompt = "private e2e asset prompt";
  const key = "private-e2e-asset-key";
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/7wAAAABJRU5ErkJggg==";
  await page.route("**/__ludelier/assets/preflight", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain(prompt);
    expect(JSON.stringify(payload)).not.toContain(key);
    expect(payload.target).toEqual({
      providerId: "openai",
      modelId: "gpt-image-2",
      kind: "image",
      endpoint: "https://api.openai.com/v1/images/generations",
    });
    await route.fulfill({ json: { status: "ready", receipt: "h".repeat(32) } });
  });
  await page.route("https://api.openai.com/v1/images/generations", (route) =>
    route.fulfill({ json: { data: [{ b64_json: pngBase64 }] } }),
  );
  await page.route("**/__ludelier/assets/persist", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain(prompt);
    expect(JSON.stringify(payload)).not.toContain(key);
    expect(payload.receipt).toBe("h".repeat(32));
    await route.fulfill({
      json: {
        asset: {
          assetId: "generated_asset",
          publicUrl: "/assets/cafe/generated/generated_asset.png",
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          byteSize: 3,
        },
      },
    });
  });

  await openEditor(page);
  await page.getByRole("tab", { name: "Assets" }).click();
  const panel = page.getByTestId("asset-panel");
  await panel.getByLabel("Asset prompt").fill(prompt);
  await panel.getByLabel("Asset API key").fill(key);
  await panel.getByLabel("Enable paid asset generation").check();
  await panel.getByRole("button", { name: "Generate & save" }).click();

  await expect(panel.getByRole("img", { name: "Preview of generated_asset" })).toBeVisible();
  await expect(panel.getByRole("status")).toContainText("Saved /assets/cafe/generated/generated_asset.png");
  await expect(panel.getByRole("list", { name: "Story assets" })).toContainText("generated_asset");
  expect(await page.evaluate((secret) => JSON.stringify(localStorage).includes(secret), key)).toBe(false);
});

test("human asset persistence blocks a competing chat lock and leaves no unregistered asset", async ({
  page,
}) => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/7wAAAABJRU5ErkJggg==";
  let markAssetDispatched!: () => void;
  let releaseAsset!: () => void;
  const assetDispatched = new Promise<void>((resolve) => {
    markAssetDispatched = resolve;
  });
  const assetResponse = new Promise<void>((resolve) => {
    releaseAsset = resolve;
  });
  let markChatDispatched!: () => void;
  let releaseChat!: () => void;
  const chatDispatched = new Promise<void>((resolve) => {
    markChatDispatched = resolve;
  });
  const chatResponse = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  let chatRequests = 0;

  await page.route("**/__ludelier/assets/preflight", (route) =>
    route.fulfill({ json: { status: "ready", receipt: "r".repeat(32) } }),
  );
  await page.route("https://api.openai.com/v1/images/generations", async (route) => {
    markAssetDispatched();
    await assetResponse;
    await route.fulfill({ json: { data: [{ b64_json: pngBase64 }] } });
  });
  await page.route("**/__ludelier/assets/persist", (route) =>
    route.fulfill({
      json: {
        asset: {
          assetId: "generated_asset",
          publicUrl: "/assets/cafe/generated/generated_asset.png",
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          byteSize: 3,
        },
      },
    }),
  );
  await page.route("https://openrouter.ai/api/v1/chat/completions", async (route) => {
    chatRequests += 1;
    markChatDispatched();
    await chatResponse;
    await route.fulfill({
      json: { model: "openai/gpt-5-mini", choices: [{ message: { content: "done" } }] },
    });
  });

  await openEditor(page);
  await page.getByRole("tab", { name: "Assets" }).click();
  const panel = page.getByTestId("asset-panel");
  await panel.getByLabel("Asset prompt").fill("human transaction prompt");
  await panel.getByLabel("Asset API key").fill("human-asset-key");
  await panel.getByLabel("Enable paid asset generation").check();
  await page.getByPlaceholder("OpenRouter API key (BYOK)").fill("chat-key");
  await panel.getByRole("button", { name: "Generate & save" }).click();
  await assetDispatched;

  await expect(page.getByRole("button", { name: "New" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open…" })).toBeDisabled();
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("button", { name: "Import log…" })).toBeDisabled();
  await page.getByRole("tab", { name: "Assets" }).click();

  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await page
    .locator(".panel.chat form")
    .evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(page.locator(".panel.chat .err")).toContainText(
    "Wait for the current asset generation to finish.",
  );
  expect(chatRequests).toBe(0);

  releaseAsset();
  await expect(panel.getByRole("status")).toContainText("Saved /assets/cafe/generated/generated_asset.png");
  await expect(panel.getByRole("list", { name: "Story assets" })).toContainText("generated_asset");

  await expect(send).toBeEnabled();
  await send.click();
  await chatDispatched;
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
  releaseChat();
  await expect(send).toBeVisible();
});

test("a stale asynchronous Open cannot replace a newer session", async ({ page }) => {
  const delayedStory = JSON.stringify({
    meta: { id: "late", title: "Late replacement", start: "start" },
    characters: [],
    assets: [],
    nodes: [{ id: "start", body: [{ op: "end" }] }],
  });
  await openEditor(page);
  await page.evaluate((text) => {
    File.prototype.text = () => {
      const gate = Promise.withResolvers<string>();
      window.addEventListener("release-pending-story-open", () => gate.resolve(text), { once: true });
      return gate.promise;
    };
  }, delayedStory);

  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: "late.story.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await page.getByRole("button", { name: "New" }).click();
  const title = page.getByTestId("story-title");
  await expect(title).toHaveText("Untitled story");

  await page.evaluate(() => window.dispatchEvent(new Event("release-pending-story-open")));
  await expect(title).toHaveText("Untitled story");
});

test("provider errors leave browser generation unregistered and redacted", async ({ page }) => {
  const prompt = "private failed e2e asset prompt";
  const key = "private-failed-e2e-key";
  await page.route("**/__ludelier/assets/preflight", async (route) => {
    const payload = JSON.stringify(route.request().postDataJSON());
    expect(payload).not.toContain(prompt);
    expect(payload).not.toContain(key);
    await route.fulfill({ json: { status: "ready", receipt: "e".repeat(32) } });
  });
  await page.route("https://api.openai.com/v1/images/generations", (route) =>
    route.fulfill({ status: 401, json: { error: { message: "must not leak this response" } } }),
  );

  await openEditor(page);
  await page.getByRole("tab", { name: "Assets" }).click();
  const panel = page.getByTestId("asset-panel");
  await panel.getByLabel("Asset prompt").fill(prompt);
  await panel.getByLabel("Asset API key").fill(key);
  await panel.getByLabel("Enable paid asset generation").check();
  await panel.getByRole("button", { name: "Generate & save" }).click();

  await expect(panel.getByRole("status")).toContainText("Asset provider authentication failed.");
  await expect(panel.getByRole("list", { name: "Story assets" })).not.toContainText("generated_asset");
  await expect(panel.getByRole("status")).not.toContainText("must not leak this response");
});

test("authorized agent generation uses the same redacted browser host route", async ({ page }) => {
  const assetKey = "private-agent-asset-key";
  const chatKey = "private-agent-chat-key";
  const prompt = "private agent-owned asset draft";
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/7wAAAABJRU5ErkJggg==";
  let completion = 0;
  await page.route("https://openrouter.ai/api/v1/chat/completions", async (route) => {
    const request = route.request().postDataJSON() as { tools?: { function?: { name?: string } }[] };
    if (completion === 0) {
      expect(request.tools?.some((tool) => tool.function?.name === "generate-asset")).toBe(true);
      completion += 1;
      await route.fulfill({
        json: {
          model: "openai/gpt-5-mini",
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "asset-call",
                    type: "function",
                    function: { name: "generate-asset", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      });
      return;
    }
    completion += 1;
    await route.fulfill({
      json: { model: "openai/gpt-5-mini", choices: [{ message: { content: "done" } }] },
    });
  });
  await page.route("https://api.openai.com/v1/images/generations", (route) =>
    route.fulfill({ json: { data: [{ b64_json: pngBase64 }] } }),
  );
  await page.route("**/__ludelier/assets/preflight", async (route) => {
    const payload = JSON.stringify(route.request().postDataJSON());
    expect(payload).not.toContain(prompt);
    expect(payload).not.toContain(assetKey);
    await route.fulfill({ json: { status: "ready", receipt: "a".repeat(32) } });
  });
  await page.route("**/__ludelier/assets/persist", async (route) => {
    const payload = JSON.stringify(route.request().postDataJSON());
    expect(payload).not.toContain(prompt);
    expect(payload).not.toContain(assetKey);
    expect(route.request().postDataJSON().receipt).toBe("a".repeat(32));
    await route.fulfill({
      json: {
        asset: {
          assetId: "generated_asset",
          publicUrl: "/assets/cafe/generated/generated_asset.png",
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          byteSize: 3,
        },
      },
    });
  });

  await openEditor(page);
  await page.getByRole("tab", { name: "Assets" }).click();
  const panel = page.getByTestId("asset-panel");
  await panel.getByLabel("Asset prompt").fill(prompt);
  await panel.getByLabel("Asset API key").fill(assetKey);
  await panel.getByLabel("Enable paid asset generation").check();
  // The capability remains available to the current session while Assets is inactive; the human
  // form is hidden and session-busy guarded, but the already-authorized agent may use its tool.
  await page.getByRole("tab", { name: "Node" }).click();
  await page.getByPlaceholder("OpenRouter API key (BYOK)").fill(chatKey);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("tab", { name: "Assets" }).click();

  await expect(panel.getByRole("list", { name: "Story assets" })).toContainText("generated_asset");
  await expect(panel.getByText(/Agent asset activity finished/)).toBeVisible();
  expect(completion).toBe(2);
});
