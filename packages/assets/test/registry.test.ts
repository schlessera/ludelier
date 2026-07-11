import { describe, expect, it } from "vitest";
import { AssetError, createAssetProviderRegistry, createAssetProviders } from "../src/index";
import type { AssetProvider } from "../src/index";

function fakeImageProvider(id: string, modelId: string): AssetProvider {
  return {
    id,
    capabilities: { kinds: ["image"] },
    targets: [
      {
        providerId: id,
        modelId,
        kind: "image",
        endpoint: `https://${id}.example/v1/images`,
        capabilities: { outputFormats: ["png"], backgrounds: ["opaque"] },
      },
    ],
    async generate() {
      return {
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
        extension: "png",
        createdAt: "2026-07-10T00:00:00.000Z",
      };
    },
  };
}

describe("asset provider registry", () => {
  it("keeps configured provider order as automatic resolver preference", () => {
    const first = fakeImageProvider("first", "first-image");
    const second = fakeImageProvider("second", "second-image");
    const registry = createAssetProviderRegistry([second, first]);

    expect(registry.providers.map((provider) => provider.id)).toEqual(["second", "first"]);
    expect(
      registry.resolve({
        kind: "image",
        prompt: "A scene",
        role: "background",
        outputFormat: "png",
      }).target,
    ).toMatchObject({ providerId: "second", modelId: "second-image" });
  });

  it("builds explicit configured providers without reading environment and generates via resolver", async () => {
    const calls: string[] = [];
    const providers = await createAssetProviders([
      {
        type: "openai",
        options: {
          apiKey: "explicit-key",
          fetchImpl: (async (input) => {
            calls.push(String(input));
            return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }));
          }) as typeof fetch,
          now: () => new Date("2026-07-10T00:00:00.000Z"),
        },
      },
    ]);
    const registry = createAssetProviderRegistry(providers);

    const result = await registry.generate({
      kind: "image",
      prompt: "A scene",
      role: "background",
      outputFormat: "png",
    });
    expect(calls).toEqual(["https://api.openai.com/v1/images/generations"]);
    expect(result.bytes).toEqual(new Uint8Array([0]));
  });

  it("rejects duplicate provider identities rather than silently changing resolution order", async () => {
    await expect(
      createAssetProviders([
        {
          type: "openai",
          options: { apiKey: "key-one", fetchImpl: (async () => new Response()) as typeof fetch },
        },
        {
          type: "openai",
          options: { apiKey: "key-two", fetchImpl: (async () => new Response()) as typeof fetch },
        },
      ]),
    ).rejects.toBeInstanceOf(AssetError);

    expect(() =>
      createAssetProviderRegistry([fakeImageProvider("same", "one"), fakeImageProvider("same", "two")]),
    ).toThrowError(AssetError);
  });
});
