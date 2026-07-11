// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditLog, createWorld } from "@ludelier/world";
import { EditorSession } from "@ludelier/editor-core";
import type { AssetProvider } from "@ludelier/assets";
import type { Story } from "@ludelier/schema";
import { AssetPanel, createGenerateAssetTool } from "../src/assets/AssetPanel";
import {
  createBrowserAssetHost,
  createDevAssetPersistence,
  type AssetGenerationHost,
  type AssetGenerationInput,
  type AssetHostOutcome,
} from "../src/assets/model";
import { parseBrowserAssetPersistPayload, parseBrowserAssetPreflightPayload } from "../src/assets/ingress";

const story: Story = {
  meta: { id: "test-story", title: "Test", start: "start" },
  characters: [],
  assets: [],
  nodes: [{ id: "start", body: [{ op: "end" }] }],
};

const input: AssetGenerationInput = {
  storyId: "test-story",
  provider: "openai",
  model: "image-model",
  kind: "image",
  role: "background",
  prompt: "private prompt that must not escape",
  assetId: "generated_asset",
  destination: "generated/generated_asset.png",
  apiKey: "private-key",
  approved: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function provider(
  generate: AssetProvider["generate"] = async () => {
    throw new Error("unexpected provider invocation");
  },
): AssetProvider {
  return {
    id: "openai",
    capabilities: { kinds: ["image"] },
    targets: [
      {
        providerId: "openai",
        modelId: "image-model",
        kind: "image",
        endpoint: "https://api.openai.com/v1/images/generations",
        capabilities: {
          outputFormats: ["png"],
          backgrounds: ["opaque"],
          sizes: [{ width: 1024, height: 1024 }],
        },
        defaultParameters: { background: "opaque", size: { width: 1024, height: 1024 } },
      },
    ],
    generate,
  };
}

function persistedHost(
  generate: (input: AssetGenerationInput) => Promise<AssetHostOutcome>,
): AssetGenerationHost {
  return { mode: "dev", ready: true, generate, release: vi.fn(), dispose: vi.fn() };
}

describe("browser asset host", () => {
  it("does not construct a provider until approval and an in-memory key both pass", async () => {
    const createProviders = vi.fn(async () => [provider()]);
    const host = createBrowserAssetHost({ createProviders, createObjectUrl: () => "blob:preview" });

    const unapproved = await host.generate({ ...input, approved: false });
    const keyless = await host.generate({ ...input, apiKey: "" });

    expect(unapproved).toMatchObject({ success: false, error: { code: "approval-required" } });
    expect(keyless).toMatchObject({ success: false, error: { code: "key-required" } });
    expect(createProviders).not.toHaveBeenCalled();
  });

  it("returns a redacted static preview and only downloads after the explicit user action", async () => {
    const generate = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      extension: "png",
      createdAt: "2026-07-10T00:00:00.000Z",
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const host = createBrowserAssetHost({
      createProviders: async () => [provider(generate)],
      createObjectUrl: () => "blob:preview",
      revokeObjectUrl: vi.fn(),
    });

    const outcome = await host.generate(input);

    expect(outcome).toMatchObject({
      success: true,
      mode: "preview",
      previewUrl: "blob:preview",
      assetId: "generated_asset",
    });
    expect(JSON.stringify(outcome)).not.toContain(input.prompt);
    expect(JSON.stringify(outcome)).not.toContain(input.apiKey);
    expect(click).not.toHaveBeenCalled();
    if (outcome.success && outcome.mode === "preview") outcome.download();
    expect(click).toHaveBeenCalledOnce();
  });

  it("returns a verified cache hit without dispatching the provider or retaining private draft data", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider must not run for a cache hit");
    });
    const preflight = vi.fn(async () => ({
      status: "cache-hit" as const,
      asset: {
        assetId: input.assetId,
        publicUrl: `/assets/${input.storyId}/${input.destination}`,
        kind: input.kind,
        mimeType: "image/png",
        extension: "png",
        byteSize: 3,
      },
    }));
    const host = createBrowserAssetHost({
      persistence: { preflight, persist: vi.fn() },
      createProviders: async () => [provider(generate)],
    });

    const outcome = await host.generate(input);

    expect(outcome).toMatchObject({
      success: true,
      mode: "persisted",
      previewUrl: `/assets/${input.storyId}/${input.destination}`,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(preflight.mock.calls[0]?.[0])).not.toContain(input.prompt);
    expect(JSON.stringify(preflight.mock.calls[0]?.[0])).not.toContain(input.apiKey);
    expect(JSON.stringify(outcome)).not.toContain(input.prompt);
    expect(JSON.stringify(outcome)).not.toContain(input.apiKey);
  });

  it("does not dispatch a provider when preflight rejects an occupied destination", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider must not run for a destination conflict");
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "destination-conflict", mayHaveCharged: false } }), {
          status: 409,
        }),
    ) as unknown as typeof fetch;
    const host = createBrowserAssetHost({
      persistence: createDevAssetPersistence(fetchImpl),
      createProviders: async () => [provider(generate)],
    });

    const outcome = await host.generate(input);

    expect(outcome).toMatchObject({
      success: false,
      error: { code: "destination-conflict", mayHaveCharged: false },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves safe usage and billing on persistence while treating a post-response failure as chargeable", async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ status: "ready", receipt: "a".repeat(32) }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: { code: "write-failed", mayHaveCharged: false } }), {
        status: 422,
      });
    }) as unknown as typeof fetch;
    const generate = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      extension: "png",
      createdAt: "2026-07-10T00:00:00.000Z",
      usage: { inputUnits: 12, outputUnits: 3 },
      billing: {
        chargeStatus: "charged" as const,
        cost: { kind: "reported" as const, amount: 0.04, currency: "USD" },
      },
    }));
    const host = createBrowserAssetHost({
      persistence: createDevAssetPersistence(fetchImpl),
      createProviders: async () => [provider(generate)],
      createObjectUrl: () => "blob:preview",
      revokeObjectUrl: vi.fn(),
    });

    const outcome = await host.generate(input);
    const persistenceBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;

    expect(outcome).toMatchObject({
      success: false,
      error: { code: "write-failed", mayHaveCharged: true },
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(persistenceBody).toMatchObject({
      receipt: "a".repeat(32),
      metadata: {
        usage: { inputUnits: 12, outputUnits: 3 },
        billing: { chargeStatus: "charged", cost: { kind: "reported", amount: 0.04, currency: "USD" } },
      },
    });
    expect(JSON.stringify(persistenceBody)).not.toContain(input.prompt);
    expect(JSON.stringify(persistenceBody)).not.toContain(input.apiKey);
  });

  it("rejects unsupported OpenRouter audio before provider construction or discovery", async () => {
    const createProviders = vi.fn(async () => [provider()]);
    const host = createBrowserAssetHost({ createProviders });

    const outcome = await host.generate({
      ...input,
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts",
      kind: "audio",
      role: "music",
      destination: "generated/generated_asset.mp3",
    });

    expect(outcome).toMatchObject({ success: false, error: { code: "unsupported-capability" } });
    expect(createProviders).not.toHaveBeenCalled();
  });

  it("does not mutate Story state when generation aborts or fails", async () => {
    const world = createWorld();
    const log = new EditLog(world, story);
    const host = persistedHost(async () => ({
      success: false,
      error: { code: "request-aborted", message: "Asset request was aborted.", mayHaveCharged: true },
    }));
    const tool = createGenerateAssetTool(host, () => input);

    const result = await tool.handler({
      call: { id: "call", name: "generate-asset", arguments: {} },
      story: log.currentStory(),
      world,
      log,
      runId: "asset-run",
    });

    expect(result.success).toBe(false);
    expect(log.currentStory().assets).toEqual([]);
  });

  it("rejects an agent's duplicate Story asset id before the host can spend a provider call", async () => {
    const occupied: Story = {
      ...story,
      assets: [{ id: "generated_asset", src: "/images/already-there.png", kind: "image" }],
    };
    const world = createWorld();
    const log = new EditLog(world, occupied);
    const generate = vi.fn(async (): Promise<AssetHostOutcome> => {
      throw new Error("host must not run for duplicate Story assets");
    });
    const tool = createGenerateAssetTool(persistedHost(generate), () => input);

    const result = await tool.handler({
      call: { id: "call", name: "generate-asset", arguments: {} },
      story: log.currentStory(),
      world,
      log,
      runId: "asset-run",
    });

    expect(result.success).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(log.currentStory().assets).toEqual(occupied.assets);
  });

  it("uses the identical host route for the human and authorized agent paths", async () => {
    const generated = vi.fn(
      async (): Promise<AssetHostOutcome> => ({
        success: true,
        mode: "persisted",
        previewUrl: "blob:preview",
        asset: {
          assetId: "generated_asset",
          publicUrl: "/assets/test-story/generated/generated_asset.png",
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          byteSize: 3,
        },
      }),
    );
    const host = persistedHost(generated);
    const human = await host.generate(input);
    expect(human).toMatchObject({ success: true, mode: "persisted" });

    const world = createWorld();
    const log = new EditLog(world, story);
    const tool = createGenerateAssetTool(host, () => input);
    const agent = await tool.handler({
      call: { id: "call", name: "generate-asset", arguments: {} },
      story: log.currentStory(),
      world,
      log,
      runId: "asset-run",
    });

    expect(agent.success).toBe(true);
    expect(generated).toHaveBeenCalledTimes(2);
    expect(log.currentStory().assets).toEqual([
      {
        id: "generated_asset",
        src: "/assets/test-story/generated/generated_asset.png",
        kind: "image",
        generated: true,
      },
    ]);
  });
});

describe("asset inspector", () => {
  it("keeps its key out of localStorage and disables paid generation by default", () => {
    localStorage.clear();
    const host = persistedHost(async () => ({
      success: false,
      error: { code: "provider-failure", message: "Asset provider request failed.", mayHaveCharged: true },
    }));
    const toolChange = vi.fn();
    render(
      <AssetPanel
        session={{} as never}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={toolChange}
      />,
    );

    const button = screen.getByRole("button", { name: "Generate & save" });
    expect(toolChange).toHaveBeenLastCalledWith(undefined);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "never-persist-this" } });
    expect(Object.values(localStorage)).not.toContain("never-persist-this");
  });

  it("registers only a successful persisted human result and exposes the authorized agent tool", async () => {
    const session = new EditorSession(story);
    const generate = vi.fn(
      async (): Promise<AssetHostOutcome> => ({
        success: true,
        mode: "persisted",
        previewUrl: "blob:preview",
        asset: {
          assetId: "generated_asset",
          publicUrl: "/assets/test-story/generated/generated_asset.png",
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          byteSize: 3,
        },
      }),
    );
    const host = persistedHost(generate);
    const toolChange = vi.fn();
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={toolChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "private human prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "private-human-key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));

    await waitFor(() =>
      expect(toolChange.mock.calls.at(-1)?.[0]).toMatchObject({ definition: { name: "generate-asset" } }),
    );
    fireEvent.submit(screen.getByRole("button", { name: "Generate & save" }).closest("form")!);

    expect(await screen.findByText(/Saved/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Preview of generated_asset" }).getAttribute("src")).toBe(
      "blob:preview",
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(session.snapshot().story.assets).toEqual([
      {
        id: "generated_asset",
        src: "/assets/test-story/generated/generated_asset.png",
        kind: "image",
        generated: true,
      },
    ]);
  });

  it("rejects a duplicate Story asset id before human generation can reach the host", async () => {
    const occupied: Story = {
      ...story,
      assets: [{ id: "generated_asset", src: "/images/already-there.png", kind: "image" }],
    };
    const session = new EditorSession(occupied);
    const generate = vi.fn(async (): Promise<AssetHostOutcome> => {
      throw new Error("host must not run for duplicate Story assets");
    });
    render(
      <AssetPanel
        session={session}
        story={session.snapshot().story}
        hostEventVersion={0}
        host={persistedHost(generate)}
        onAgentToolChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "a prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "a key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));
    fireEvent.submit(screen.getByRole("button", { name: "Generate & save" }).closest("form")!);

    expect(await screen.findByText("A Story asset already uses this id.")).toBeTruthy();
    expect(generate).not.toHaveBeenCalled();
  });

  it("disables and rejects human asset submission while the session is busy", () => {
    const session = new EditorSession(story);
    vi.spyOn(session, "busy", "get").mockReturnValue(true);
    const generate = vi.fn(async (): Promise<AssetHostOutcome> => {
      throw new Error("host must not run while the session is busy");
    });
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={persistedHost(generate)}
        onAgentToolChange={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("Asset prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Enable paid asset generation") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Generate & save" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.submit(screen.getByRole("button", { name: "Generate & save" }).closest("form")!);
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps a successful preview's kind and destination after later form edits", async () => {
    const session = new EditorSession(story);
    const host: AssetGenerationHost = {
      mode: "static",
      ready: false,
      generate: vi.fn(
        async (): Promise<AssetHostOutcome> => ({
          success: true,
          mode: "preview",
          previewUrl: "blob:immutable-preview",
          mimeType: "image/png",
          extension: "png",
          assetId: "generated_asset",
          download: vi.fn(),
        }),
      ),
      release: vi.fn(),
      dispose: vi.fn(),
    };
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "a prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "a key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));
    fireEvent.submit(screen.getByRole("button", { name: "Generate preview" }).closest("form")!);
    expect(await screen.findByRole("img", { name: "Preview of generated_asset" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Asset kind"), { target: { value: "audio" } });
    fireEvent.change(screen.getByLabelText("Asset destination"), { target: { value: "later/changed.mp3" } });

    expect(screen.getByRole("img", { name: "Preview of generated_asset" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Preview ready. Download both files and place the media at /assets/test-story/generated/generated_asset.png.",
    );
  });

  it("leaves the Story untouched when the human cancels an in-flight generation", async () => {
    const session = new EditorSession(story);
    const generate = vi.fn(
      (_input: AssetGenerationInput, signal?: AbortSignal) =>
        new Promise<AssetHostOutcome>((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve({
                success: false,
                error: {
                  code: "request-aborted",
                  message: "Asset request was aborted.",
                  mayHaveCharged: true,
                },
              }),
            { once: true },
          );
        }),
    );
    const host = persistedHost(generate);
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "private abort prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "private-abort-key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));
    fireEvent.submit(screen.getByRole("button", { name: "Generate & save" }).closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Abort generation" }));

    expect(await screen.findByText(/Asset request was aborted/)).toBeTruthy();
    expect(session.snapshot().story.assets).toEqual([]);
  });

  it("leaves the Story untouched when human generation returns a redacted error", async () => {
    const session = new EditorSession(story);
    const host = persistedHost(async () => ({
      success: false,
      error: { code: "provider-failure", message: "Asset provider request failed.", mayHaveCharged: true },
    }));
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "private error prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "private-error-key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));
    fireEvent.submit(screen.getByRole("button", { name: "Generate & save" }).closest("form")!);

    expect(await screen.findByText(/Asset provider request failed/)).toBeTruthy();
    expect(session.snapshot().story.assets).toEqual([]);
  });

  it("keeps static results preview-only until the user clicks a download action", async () => {
    const session = new EditorSession(story);
    const download = vi.fn();
    const host: AssetGenerationHost = {
      mode: "static",
      ready: false,
      generate: vi.fn(
        async (): Promise<AssetHostOutcome> => ({
          success: true,
          mode: "preview",
          previewUrl: "blob:static-preview",
          mimeType: "image/png",
          extension: "png",
          assetId: "generated_asset",
          download,
        }),
      ),
      release: vi.fn(),
      dispose: vi.fn(),
    };
    const toolChange = vi.fn();
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={toolChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "private static prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "private-static-key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));
    fireEvent.submit(screen.getByRole("button", { name: "Generate preview" }).closest("form")!);

    expect(await screen.findByText(/Preview ready/)).toBeTruthy();
    expect(screen.getByText(/Static builds can preview and download only/)).toBeTruthy();
    expect(download).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toolChange.mock.calls.at(-1)?.[0]).toMatchObject({ definition: { name: "generate-asset" } }),
    );
    expect(session.snapshot().story.assets).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Download preview" }));
    expect(download).toHaveBeenCalledOnce();
  });

  it("lets an authorized agent retain a static preview for human download without exposing secrets or Story writes", async () => {
    const session = new EditorSession(story);
    const download = vi.fn();
    const host: AssetGenerationHost = {
      mode: "static",
      ready: false,
      generate: vi.fn(
        async (): Promise<AssetHostOutcome> => ({
          success: true,
          mode: "preview",
          previewUrl: "blob:agent-static-preview",
          mimeType: "image/png",
          extension: "png",
          assetId: "generated_asset",
          download,
        }),
      ),
      release: vi.fn(),
      dispose: vi.fn(),
    };
    const toolChange = vi.fn();
    render(
      <AssetPanel
        session={session}
        story={story}
        hostEventVersion={0}
        host={host}
        onAgentToolChange={toolChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Asset prompt"), { target: { value: "private static prompt" } });
    fireEvent.change(screen.getByLabelText("Asset API key"), { target: { value: "private-static-key" } });
    fireEvent.click(screen.getByLabelText("Enable paid asset generation"));
    await waitFor(() =>
      expect(toolChange.mock.calls.at(-1)?.[0]).toMatchObject({ definition: { name: "generate-asset" } }),
    );
    const tool = toolChange.mock.calls.at(-1)?.[0];
    if (tool === undefined) throw new Error("Expected static generate-asset tool");

    const world = createWorld();
    const log = new EditLog(world, story);
    const result = await tool.handler({
      call: { id: "static-preview", name: "generate-asset", arguments: {} },
      story: log.currentStory(),
      world,
      log,
      runId: "static-preview-run",
    });

    expect(result).toMatchObject({
      success: true,
      data: { assetId: "generated_asset", kind: "image", mode: "preview" },
    });
    expect(JSON.stringify(result)).not.toContain("private static prompt");
    expect(JSON.stringify(result)).not.toContain("private-static-key");
    expect(screen.getByRole("img", { name: "Preview of generated_asset" }).getAttribute("src")).toBe(
      "blob:agent-static-preview",
    );
    expect(screen.getByRole("button", { name: "Download preview" })).toBeTruthy();
    expect(download).not.toHaveBeenCalled();
    expect(host.release).not.toHaveBeenCalled();
    expect(log.currentStory().assets).toEqual([]);
  });
});

describe("development asset ingress", () => {
  const safePreflight = {
    destination: {
      storyId: "test-story",
      assetId: "generated_asset",
      relativePath: "generated/generated_asset.png",
    },
    target: {
      providerId: "openai",
      modelId: "gpt-image-2",
      kind: "image",
      endpoint: "https://api.openai.com/v1/images/generations",
    },
    request: {
      kind: "image",
      role: "background",
      outputFormat: "png",
      parameters: { background: "opaque", size: { width: 1024, height: 1024 } },
    },
    requestHash: "a".repeat(64),
    promptHash: "b".repeat(64),
  };
  const safePersist = {
    receipt: "receipt_token_for_test_1234567890",
    metadata: {
      mimeType: "image/png",
      extension: "png",
      createdAt: "2026-07-10T00:00:00.000Z",
      usage: { inputUnits: 12, outputUnits: 3 },
      billing: { chargeStatus: "charged", cost: { kind: "reported", amount: 0.04, currency: "USD" } },
    },
    bytesBase64: "AQID",
  };

  it("accepts only prompt-free preflight data and rejects traversal, roots, secrets, and unknown request fields", () => {
    expect(parseBrowserAssetPreflightPayload(safePreflight)).toBeDefined();
    expect(
      parseBrowserAssetPreflightPayload({
        ...safePreflight,
        destination: { ...safePreflight.destination, relativePath: "../outside.png" },
      }),
    ).toBeUndefined();
    expect(
      parseBrowserAssetPreflightPayload({ ...safePreflight, publicRoot: "/tmp/public" }),
    ).toBeUndefined();
    expect(
      parseBrowserAssetPreflightPayload({ ...safePreflight, provenanceRoot: "/tmp/private" }),
    ).toBeUndefined();
    expect(
      parseBrowserAssetPreflightPayload({ ...safePreflight, prompt: "plaintext prompt" }),
    ).toBeUndefined();
    expect(parseBrowserAssetPreflightPayload({ ...safePreflight, apiKey: "private-key" })).toBeUndefined();
    expect(
      parseBrowserAssetPreflightPayload({
        ...safePreflight,
        request: { ...safePreflight.request, prompt: "plaintext prompt" },
      }),
    ).toBeUndefined();
    expect(
      parseBrowserAssetPreflightPayload({
        ...safePreflight,
        target: { ...safePreflight.target, endpoint: "https://example.test/asset" },
      }),
    ).toBeUndefined();
  });

  it("requires a one-use receipt for byte persistence while preserving safe usage and billing metadata", () => {
    expect(parseBrowserAssetPersistPayload(safePersist)).toMatchObject({
      receipt: safePersist.receipt,
      metadata: {
        usage: { inputUnits: 12, outputUnits: 3 },
        billing: { chargeStatus: "charged", cost: { kind: "reported", amount: 0.04, currency: "USD" } },
      },
    });
    expect(parseBrowserAssetPersistPayload({ ...safePersist, prompt: "plaintext prompt" })).toBeUndefined();
    expect(parseBrowserAssetPersistPayload({ ...safePersist, apiKey: "private-key" })).toBeUndefined();
    expect(
      parseBrowserAssetPersistPayload({ ...safePersist, destination: safePreflight.destination }),
    ).toBeUndefined();
    expect(
      parseBrowserAssetPersistPayload({
        ...safePersist,
        metadata: { ...safePersist.metadata, contentTypeValidated: true },
      }),
    ).toBeUndefined();
    expect(parseBrowserAssetPersistPayload({ ...safePersist, receipt: "not-a-receipt" })).toBeUndefined();
  });
});
