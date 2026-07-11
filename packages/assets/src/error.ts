import type { AssetMediaKind, AssetModelId, AssetProviderId } from "./types";

export type AssetErrorCode =
  | "invalid-request"
  | "unknown-provider"
  | "unknown-model"
  | "unsupported-capability"
  | "no-compatible-target"
  | "crypto-unavailable"
  | "authentication-failed"
  | "authorization-failed"
  | "rate-limited"
  | "content-rejected"
  | "request-aborted"
  | "network-failure"
  | "invalid-provider-response"
  | "provider-failure";

/** Safe identifiers that can be returned to a host or shown in a transcript. */
export interface AssetErrorContext {
  readonly providerId?: AssetProviderId;
  readonly modelId?: AssetModelId;
  readonly kind?: AssetMediaKind;
  readonly capability?: "background" | "output-format" | "quality" | "seed" | "size" | "speed" | "voice";
}

export interface RedactedAssetError {
  readonly code: AssetErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** True means a request could have reached a provider and must not be replayed automatically. */
  readonly mayHaveCharged: boolean;
  readonly context?: AssetErrorContext;
}

export interface AssetErrorOptions {
  readonly retryable?: boolean;
  readonly mayHaveCharged?: boolean;
  readonly context?: AssetErrorContext;
}

interface ErrorPreset {
  readonly message: string;
  readonly retryable: boolean;
  readonly mayHaveCharged: boolean;
}

const errorPresets: Record<AssetErrorCode, ErrorPreset> = {
  "invalid-request": {
    message: "Asset request is invalid.",
    retryable: false,
    mayHaveCharged: false,
  },
  "unknown-provider": {
    message: "Requested asset provider is not configured.",
    retryable: false,
    mayHaveCharged: false,
  },
  "unknown-model": {
    message: "Requested asset model is not configured.",
    retryable: false,
    mayHaveCharged: false,
  },
  "unsupported-capability": {
    message: "Requested asset capability is not supported by the selected target.",
    retryable: false,
    mayHaveCharged: false,
  },
  "no-compatible-target": {
    message: "No compatible asset target is configured.",
    retryable: false,
    mayHaveCharged: false,
  },
  "crypto-unavailable": {
    message: "Web Crypto SHA-256 is unavailable in this host.",
    retryable: false,
    mayHaveCharged: false,
  },
  "authentication-failed": {
    message: "Asset provider authentication failed.",
    retryable: false,
    mayHaveCharged: false,
  },
  "authorization-failed": {
    message: "Asset provider authorization failed.",
    retryable: false,
    mayHaveCharged: false,
  },
  "rate-limited": {
    message: "Asset provider rate limit reached.",
    retryable: true,
    mayHaveCharged: false,
  },
  "content-rejected": {
    message: "Asset request was rejected by the provider.",
    retryable: false,
    mayHaveCharged: false,
  },
  "request-aborted": {
    message: "Asset request was aborted.",
    retryable: false,
    mayHaveCharged: true,
  },
  "network-failure": {
    message: "Asset provider request failed on the network.",
    retryable: false,
    mayHaveCharged: true,
  },
  "invalid-provider-response": {
    message: "Asset provider returned an invalid response.",
    retryable: false,
    mayHaveCharged: true,
  },
  "provider-failure": {
    message: "Asset provider request failed.",
    retryable: false,
    mayHaveCharged: true,
  },
};

/**
 * A typed error that deliberately stores only safe context. Do not attach `cause` or a provider
 * response: adapters classify raw failures at their boundary and keep raw diagnostics private.
 */
export class AssetError extends Error {
  readonly code: AssetErrorCode;
  readonly retryable: boolean;
  readonly mayHaveCharged: boolean;
  readonly context?: AssetErrorContext;

  constructor(code: AssetErrorCode, options: AssetErrorOptions = {}) {
    const preset = errorPresets[code];
    super(preset.message);
    this.name = "AssetError";
    this.code = code;
    this.retryable = options.retryable ?? preset.retryable;
    this.mayHaveCharged = options.mayHaveCharged ?? preset.mayHaveCharged;
    this.context = options.context ? { ...options.context } : undefined;
  }

  toJSON(): RedactedAssetError {
    return this.context
      ? {
          code: this.code,
          message: this.message,
          retryable: this.retryable,
          mayHaveCharged: this.mayHaveCharged,
          context: this.context,
        }
      : {
          code: this.code,
          message: this.message,
          retryable: this.retryable,
          mayHaveCharged: this.mayHaveCharged,
        };
  }
}

/**
 * Converts arbitrary provider/host failures into transcript-safe data. Unknown error messages,
 * raw response bodies, request headers, and credentials are intentionally discarded.
 */
export function classifyAssetError(error: unknown): RedactedAssetError {
  if (error instanceof AssetError) return error.toJSON();

  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return new AssetError("request-aborted").toJSON();
  }

  return new AssetError("provider-failure").toJSON();
}
