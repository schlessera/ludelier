import { AssetError } from "./error";
import { sanitizeEndpointIdentity } from "./endpoint";
import type { CanonicalValue, PostProcessingRecipe, ResolvedAssetGenerationRequest } from "./types";

/** Bump only when the request cache identity shape intentionally changes. */
export const ASSET_REQUEST_HASH_VERSION = 1 as const;
/** Bump only when the isolated prompt-hash payload intentionally changes. */
export const ASSET_PROMPT_HASH_VERSION = 1 as const;

/**
 * Stable JSON serialisation for JSON-compatible data. It sorts object keys and rejects values that
 * JSON would silently erase or coerce, such as undefined, non-finite numbers, and class instances.
 */
export function stableStringify(value: CanonicalValue): string {
  return serializeCanonicalValue(value);
}

/** Builds the complete, versioned cache payload without omitting prompt or effective parameters. */
export function canonicalRequestPayload(
  request: ResolvedAssetGenerationRequest,
  postProcessing: PostProcessingRecipe,
): CanonicalValue {
  const target = {
    providerId: request.target.providerId,
    modelId: request.target.modelId,
    kind: request.target.kind,
    endpoint: sanitizeEndpointIdentity(request.target.endpoint),
  };
  const recipe = canonicalRecipe(postProcessing);

  if (request.kind === "image") {
    return {
      version: ASSET_REQUEST_HASH_VERSION,
      target,
      request: {
        kind: request.kind,
        prompt: request.prompt,
        role: request.role,
        outputFormat: request.outputFormat,
        parameters: {
          background: request.parameters.background,
          ...(request.parameters.size === undefined
            ? {}
            : {
                size: {
                  width: request.parameters.size.width,
                  height: request.parameters.size.height,
                },
              }),
          ...(request.parameters.seed === undefined ? {} : { seed: request.parameters.seed }),
          ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
        },
      },
      postProcessing: recipe,
    };
  }

  return {
    version: ASSET_REQUEST_HASH_VERSION,
    target,
    request: {
      kind: request.kind,
      prompt: request.prompt,
      role: request.role,
      outputFormat: request.outputFormat,
      parameters: {
        ...(request.parameters.voice === undefined ? {} : { voice: request.parameters.voice }),
        ...(request.parameters.speed === undefined ? {} : { speed: request.parameters.speed }),
      },
    },
    postProcessing: recipe,
  };
}

/** Hashes the versioned request cache payload with browser-standard Web Crypto SHA-256. */
export function hashAssetRequest(
  request: ResolvedAssetGenerationRequest,
  postProcessing: PostProcessingRecipe,
): Promise<string> {
  return hashCanonicalValue(canonicalRequestPayload(request, postProcessing));
}

/** Hashes the exact prompt in its own versioned payload for redacted provenance sidecars. */
export function hashAssetPrompt(prompt: string): Promise<string> {
  return hashCanonicalValue({ version: ASSET_PROMPT_HASH_VERSION, prompt });
}

/** Hashes final content bytes. Hosts use this before accepting a persisted asset cache hit. */
export function hashAssetContent(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

/** Hashes any canonical JSON-compatible value through Web Crypto SHA-256. */
export function hashCanonicalValue(value: CanonicalValue): Promise<string> {
  return sha256(stableStringify(value));
}

/** A browser/headless-safe SHA-256 helper. No Node crypto fallback is intentionally provided. */
export async function sha256(value: string | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new AssetError("crypto-unavailable");

  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await subtle.digest("SHA-256", toDigestBuffer(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toDigestBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  // Web Crypto excludes SharedArrayBuffer-backed views; copy only for that unsupported backing store.
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return copied.buffer;
}

function canonicalRecipe(recipe: PostProcessingRecipe): CanonicalValue {
  return {
    recipe: recipe.recipe,
    version: recipe.version,
    ...(recipe.parameters === undefined ? {} : { parameters: recipe.parameters }),
  };
}

function serializeCanonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AssetError("invalid-request");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonicalValue(item)).join(",")}]`;
  }
  if (!isPlainRecord(value)) throw new AssetError("invalid-request");

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonicalValue(value[key])}`).join(",")}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
