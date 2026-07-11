import { Buffer } from "node:buffer";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import { assetProvenanceFsDeny, editorAssetPersistence } from "../vite.config";

const preflightPayload = {
  destination: {
    storyId: "vite-test-story",
    assetId: "generated_asset",
    relativePath: "generated/generated_asset.mp3",
  },
  target: {
    providerId: "openai",
    modelId: "gpt-4o-mini-tts",
    kind: "audio",
    endpoint: "https://api.openai.com/v1/audio/speech",
  },
  request: {
    kind: "audio",
    role: "music",
    outputFormat: "mp3",
    parameters: {},
  },
  requestHash: "a".repeat(64),
  promptHash: "b".repeat(64),
};

interface RunningIngress {
  readonly baseUrl: string;
}

let root: string | undefined;
let viteServer: ViteDevServer | undefined;
let httpServer: HttpServer | undefined;

afterEach(async () => {
  if (httpServer !== undefined) {
    await new Promise<void>((resolve, reject) => {
      httpServer?.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
  httpServer = undefined;
  await viteServer?.close();
  viteServer = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function startIngress(now: () => number = Date.now): Promise<RunningIngress> {
  root = await mkdtemp(path.join(tmpdir(), "ludelier-editor-ingress-"));
  const publicRoot = path.join(root, "assets");
  const provenanceRoot = path.join(root, ".asset-provenance");
  await Promise.all([mkdir(publicRoot, { recursive: true }), mkdir(provenanceRoot, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(provenanceRoot, "private.txt"), "private provenance must never be served"),
    writeFile(path.join(root, ".env"), "private environment must never be served"),
    writeFile(path.join(root, ".env.local"), "private local environment must never be served"),
    writeFile(path.join(root, "certificate.pem"), "private certificate must never be served"),
  ]);

  viteServer = await createViteServer({
    configFile: false,
    root: path.resolve("packages/editor-web"),
    appType: "custom",
    logLevel: "silent",
    plugins: [editorAssetPersistence({ publicRoot, provenanceRoot, receiptTtlMs: 500, now })],
    server: {
      middlewareMode: true,
      fs: {
        allow: [root],
        deny: assetProvenanceFsDeny,
      },
    },
  });
  httpServer = createHttpServer(viteServer.middlewares);
  await new Promise<void>((resolve, reject) => {
    const activeServer = httpServer;
    if (activeServer === undefined) {
      reject(new Error("Vite ingress did not create an HTTP server"));
      return;
    }
    activeServer.once("error", reject);
    activeServer.listen(0, "127.0.0.1", () => {
      activeServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Vite ingress did not expose a TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function postJson(baseUrl: string, endpoint: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function receiptFrom(body: string): string {
  const match = /"receipt":"([A-Za-z0-9_-]{24,128})"/.exec(body);
  if (match?.[1] === undefined) throw new Error("Expected an opaque receipt");
  return match[1];
}

describe("editor Vite asset ingress", () => {
  it("denies provenance and Vite's default sensitive files through real /@fs/ requests", async () => {
    const ingress = await startIngress();
    if (root === undefined) throw new Error("Temporary root was not created");
    const privateFiles = [
      [path.join(root, ".asset-provenance", "private.txt"), "private provenance must never be served"],
      [path.join(root, ".env"), "private environment must never be served"],
      [path.join(root, ".env.local"), "private local environment must never be served"],
      [path.join(root, "certificate.pem"), "private certificate must never be served"],
    ] as const;

    for (const [file, secret] of privateFiles) {
      const response = await fetch(`${ingress.baseUrl}/@fs/${file.replaceAll("\\", "/")}`);
      const body = await response.text();
      expect(response.status).not.toBe(200);
      expect(body).not.toContain(secret);
    }
  });

  it("keeps an expiring one-use server receipt across parallel preflight, persistence, and verified cache paths", async () => {
    let clock = 0;
    const ingress = await startIngress(() => clock);
    const audioBytes = Buffer.alloc(417);
    audioBytes.set([0xff, 0xfb, 0x90, 0x00]);
    const mediaBase64 = audioBytes.toString("base64");

    const pcm = await postJson(ingress.baseUrl, "/__ludelier/assets/preflight", {
      ...preflightPayload,
      destination: {
        ...preflightPayload.destination,
        assetId: "raw_pcm",
        relativePath: "generated/raw_pcm.pcm",
      },
      request: { ...preflightPayload.request, outputFormat: "pcm" },
    });
    expect(pcm.status).toBe(400);

    const ready = await postJson(ingress.baseUrl, "/__ludelier/assets/preflight", preflightPayload);
    const readyBody = await ready.text();
    const receipt = receiptFrom(readyBody);
    expect(ready.status).toBe(200);
    expect(readyBody).not.toContain("private prompt");
    expect(readyBody).not.toContain("private-key");

    const parallel = await postJson(ingress.baseUrl, "/__ludelier/assets/preflight", {
      ...preflightPayload,
      destination: { ...preflightPayload.destination, assetId: "same_destination_other_id" },
    });
    expect(parallel.status).toBe(409);
    expect(await parallel.text()).toContain("reservation-busy");

    const missingReceipt = await postJson(ingress.baseUrl, "/__ludelier/assets/persist", {
      metadata: { mimeType: "audio/mpeg", extension: "mp3", createdAt: "2026-07-10T00:00:00.000Z" },
      bytesBase64: mediaBase64,
    });
    expect(missingReceipt.status).toBe(400);

    const stored = await postJson(ingress.baseUrl, "/__ludelier/assets/persist", {
      receipt,
      metadata: {
        mimeType: "audio/mpeg",
        extension: "mp3",
        createdAt: "2026-07-10T00:00:00.000Z",
        usage: { inputUnits: 12, outputUnits: 3 },
        billing: { chargeStatus: "charged", cost: { kind: "reported", amount: 0.04, currency: "USD" } },
      },
      bytesBase64: mediaBase64,
    });
    const storedBody = await stored.text();
    expect(stored.status, storedBody).toBe(200);
    expect(storedBody).not.toContain("private");

    const replay = await postJson(ingress.baseUrl, "/__ludelier/assets/persist", {
      receipt,
      metadata: { mimeType: "audio/mpeg", extension: "mp3", createdAt: "2026-07-10T00:00:00.000Z" },
      bytesBase64: mediaBase64,
    });
    expect(replay.status).toBe(410);

    const cacheHit = await postJson(ingress.baseUrl, "/__ludelier/assets/preflight", preflightPayload);
    expect(cacheHit.status).toBe(200);
    expect(await cacheHit.text()).toContain('"status":"cache-hit"');

    const expiringPayload = {
      ...preflightPayload,
      destination: {
        ...preflightPayload.destination,
        assetId: "expiring_asset",
        relativePath: "generated/expiring_asset.mp3",
      },
    };
    const expiring = await postJson(ingress.baseUrl, "/__ludelier/assets/preflight", expiringPayload);
    const expiringReceipt = receiptFrom(await expiring.text());
    clock += 501;
    const expired = await postJson(ingress.baseUrl, "/__ludelier/assets/persist", {
      receipt: expiringReceipt,
      metadata: { mimeType: "audio/mpeg", extension: "mp3", createdAt: "2026-07-10T00:00:00.000Z" },
      bytesBase64: mediaBase64,
    });
    expect(expired.status).toBe(410);
  });
});
