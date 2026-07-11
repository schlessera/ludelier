import {
  buildAssetProvenanceSidecar,
  classifyAssetError,
  hashAssetContent,
  hashAssetPrompt,
  hashAssetRequest,
  resolveAssetTarget,
} from "@ludelier/assets";
import type {
  AssetErrorCode,
  AssetGenerationRequest,
  AssetGenerationResult,
  AssetProvider,
  PostProcessingRecipe,
  RedactedAssetError,
  ResolvedAssetGenerationRequest,
} from "@ludelier/assets";
import { AssetNodeProcessError, processGeneratedAsset, postProcessingRecipe } from "./process";
import type { ProcessedAsset } from "./process";
import {
  AssetNodePathError,
  AssetNodeReservationError,
  type AssetNodeReplacement,
  type AssetNodeStore,
  AssetNodeWriteError,
} from "./store";
import type {
  AssetNodeCacheLookup,
  AssetNodeCacheMissReason,
  AssetNodeDestination,
  AssetNodeFilePaths,
  AssetNodePersistedAsset,
} from "./store";

export * from "./process";
export * from "./store";
export * from "./browser-ingress";

export type AssetNodeFailureCode =
  | AssetErrorCode
  | "invalid-path"
  | "destination-conflict"
  | "force-requires-cache-hit"
  | "invalid-output"
  | "processing-failed"
  | "write-failed"
  | "persistence-failed";

/** Safe failure data. Provider messages, source URLs, headers, and raw responses never escape. */
export interface AssetNodeFailure {
  readonly phase: "preflight" | "provider" | "processing" | "write" | "persistence";
  readonly code: AssetNodeFailureCode;
  readonly retryable: boolean;
  readonly mayHaveCharged: boolean;
}

/** A redacted reference to bytes that were written but could not be registered by the caller. */
export interface AssetNodeOrphan {
  readonly reason: "persistence-failed";
  readonly asset: AssetNodePersistedAsset;
}

export interface AssetNodeGenerationInput {
  readonly store: AssetNodeStore;
  readonly providers: readonly AssetProvider[];
  readonly request: AssetGenerationRequest;
  readonly destination: AssetNodeDestination;
  readonly signal?: AbortSignal;
  /**
   * Regenerates only an exact verified cache pair under the destination reservation. It never
   * permits replacing missing, malformed, unsafe, or conflicting paths.
   */
  readonly force?: boolean;
  /**
   * Optional caller-owned persistence, for example an atomic Story registration. This adapter does
   * not write Story metadata. A rejection exposes the already-written media as an inspectable orphan.
   */
  readonly persist?: (asset: AssetNodePersistedAsset) => Promise<void>;
}

/**
 * Advisory no-spend inspection. A `"ready"` result exposes only the safe request hash: it is
 * not a capability to dispatch a provider or access file paths. `generateAndStoreAsset()` always
 * re-resolves and rechecks the destination inside its authoritative reservation.
 */
export type AssetNodePreflightResult =
  | { readonly status: "cache-hit"; readonly asset: AssetNodePersistedAsset }
  | {
      readonly status: "ready";
      readonly requestHash: string;
      readonly force?: "verified-cache-hit";
      readonly mayHaveCharged?: true;
    }
  | {
      readonly status: "failed";
      readonly failure: AssetNodeFailure;
      readonly cache?: AssetNodeCacheMissReason;
    };

export type AssetNodeGenerationResult =
  | {
      readonly status: "stored";
      readonly asset: AssetNodePersistedAsset;
      readonly cache: AssetNodeCacheMissReason | "force-cache-hit";
      readonly mayHaveCharged: true;
    }
  | { readonly status: "cache-hit"; readonly asset: AssetNodePersistedAsset; readonly mayHaveCharged: false }
  | {
      readonly status: "orphaned";
      readonly orphan: AssetNodeOrphan;
      readonly cache: "hit" | AssetNodeCacheMissReason | "force-cache-hit";
      readonly mayHaveCharged: boolean;
    }
  | {
      readonly status: "failed";
      readonly failure: AssetNodeFailure;
      readonly cache?: AssetNodeCacheMissReason;
    };

/**
 * Performs every validation and cache check that can happen before a provider receives a request.
 * A cache corruption or mismatch is represented as a recoverable miss, but occupied files are never
 * overwritten: callers receive a destination conflict instead of generating another chargeable asset.
 */
export async function preflightAssetGeneration(
  input: Omit<AssetNodeGenerationInput, "signal" | "persist">,
): Promise<AssetNodePreflightResult> {
  let request: ResolvedAssetGenerationRequest;
  let postProcessing: PostProcessingRecipe;
  let paths: AssetNodeFilePaths;
  let requestHash: string;

  try {
    request = resolveAssetTarget(input.providers, input.request);
    postProcessing = postProcessingRecipe(request);
    paths = await input.store.prepareDestination(input.destination, request.outputFormat);
    requestHash = await hashAssetRequest(request, postProcessing);
  } catch (error) {
    return { status: "failed", failure: preflightFailure(error) };
  }

  let cache: AssetNodeCacheLookup;
  try {
    cache = await input.store.lookupCache(paths, request, requestHash, postProcessing);
  } catch {
    return {
      status: "failed",
      failure: { phase: "preflight", code: "write-failed", retryable: true, mayHaveCharged: false },
    };
  }
  if (cache.status === "hit") {
    if (!input.force) return { status: "cache-hit", asset: cache.asset };
    const provider = input.providers.find((candidate) => candidate.id === request.target.providerId);
    if (provider === undefined) {
      return {
        status: "failed",
        failure: { phase: "preflight", code: "invalid-request", retryable: false, mayHaveCharged: false },
      };
    }
    return { status: "ready", requestHash, force: "verified-cache-hit", mayHaveCharged: true };
  }
  if (cache.occupied) {
    return {
      status: "failed",
      failure: { phase: "preflight", code: "destination-conflict", retryable: false, mayHaveCharged: false },
      cache: cache.reason,
    };
  }
  if (input.force) {
    return {
      status: "failed",
      failure: {
        phase: "preflight",
        code: "force-requires-cache-hit",
        retryable: false,
        mayHaveCharged: false,
      },
      cache: cache.reason,
    };
  }

  const provider = input.providers.find((candidate) => candidate.id === request.target.providerId);
  if (provider === undefined) {
    return {
      status: "failed",
      failure: { phase: "preflight", code: "invalid-request", retryable: false, mayHaveCharged: false },
      cache: cache.reason,
    };
  }

  return { status: "ready", requestHash };
}

/**
 * Callers may run the advisory preflight for UI feedback, but this function rechecks cache state
 * inside an authoritative reservation before any provider dispatch. It never mutates Story metadata.
 */
export async function generateAndStoreAsset(
  input: AssetNodeGenerationInput,
): Promise<AssetNodeGenerationResult> {
  let request: ResolvedAssetGenerationRequest;
  let postProcessing: PostProcessingRecipe;
  let paths: AssetNodeFilePaths;
  let requestHash: string;
  try {
    request = resolveAssetTarget(input.providers, input.request);
    postProcessing = postProcessingRecipe(request);
    paths = await input.store.prepareDestination(input.destination, request.outputFormat);
    requestHash = await hashAssetRequest(request, postProcessing);
  } catch (error) {
    return { status: "failed", failure: preflightFailure(error) };
  }

  try {
    return await input.store.withDestinationReservation(paths, async () => {
      let cache: AssetNodeCacheLookup;
      try {
        cache = await input.store.lookupCache(paths, request, requestHash, postProcessing);
      } catch {
        return {
          status: "failed",
          failure: { phase: "preflight", code: "write-failed", retryable: true, mayHaveCharged: false },
        };
      }
      let forcedCache: AssetNodePersistedAsset | undefined;
      let cacheOutcome: AssetNodeCacheMissReason | "force-cache-hit";
      if (cache.status === "hit") {
        if (!input.force) return persistOrReportOrphan(cache.asset, "hit", input.persist, undefined);
        forcedCache = cache.asset;
        cacheOutcome = "force-cache-hit";
      } else {
        if (cache.occupied) {
          return {
            status: "failed",
            failure: {
              phase: "preflight",
              code: "destination-conflict",
              retryable: false,
              mayHaveCharged: false,
            },
            cache: cache.reason,
          };
        }
        if (input.force) {
          return {
            status: "failed",
            failure: {
              phase: "preflight",
              code: "force-requires-cache-hit",
              retryable: false,
              mayHaveCharged: false,
            },
            cache: cache.reason,
          };
        }
        cacheOutcome = cache.reason;
      }

      const provider = input.providers.find((candidate) => candidate.id === request.target.providerId);
      if (provider === undefined) {
        return {
          status: "failed",
          failure: { phase: "preflight", code: "invalid-request", retryable: false, mayHaveCharged: false },
          cache: cacheOutcome === "force-cache-hit" ? undefined : cacheOutcome,
        };
      }

      let generated: AssetGenerationResult;
      try {
        generated = await provider.generate(request, { signal: input.signal });
      } catch (error) {
        return {
          status: "failed",
          failure: providerFailure(error),
          cache: cacheOutcome === "force-cache-hit" ? undefined : cacheOutcome,
        };
      }

      let processed: ProcessedAsset;
      try {
        processed = await processGeneratedAsset(request, generated);
      } catch (error) {
        return {
          status: "failed",
          failure: processingFailure(error),
          cache: cacheOutcome === "force-cache-hit" ? undefined : cacheOutcome,
        };
      }

      let asset: AssetNodePersistedAsset;
      let replacement: AssetNodeReplacement | undefined;
      try {
        const [promptHash, contentHash] = await Promise.all([
          hashAssetPrompt(request.prompt),
          hashAssetContent(processed.bytes),
        ]);
        const provenance = buildAssetProvenanceSidecar({
          requestHash,
          promptHash,
          contentHash,
          request,
          metadata: {
            ...generated,
            mimeType: processed.mimeType,
            extension: processed.extension,
          },
          byteSize: processed.bytes.byteLength,
          postProcessing,
        });
        if (forcedCache === undefined) {
          await input.store.stageAndCommit(paths, processed.bytes, provenance);
        } else {
          replacement = await input.store.replaceVerifiedCache(
            paths,
            forcedCache,
            processed.bytes,
            provenance,
          );
        }
        asset = {
          storyId: paths.destination.storyId,
          assetId: paths.destination.assetId,
          relativePath: paths.destination.relativePath,
          publicUrl: paths.publicUrl,
          mimeType: provenance.mimeType,
          extension: provenance.extension,
          byteSize: provenance.byteSize,
          requestHash: provenance.requestHash,
          contentHash: provenance.contentHash,
          provenance,
        };
      } catch (error) {
        return {
          status: "failed",
          failure:
            error instanceof AssetNodeWriteError || error instanceof AssetNodePathError
              ? { phase: "write", code: "write-failed", retryable: true, mayHaveCharged: true }
              : processingFailure(error),
          cache: cacheOutcome === "force-cache-hit" ? undefined : cacheOutcome,
        };
      }

      return persistOrReportOrphan(asset, cacheOutcome, input.persist, replacement);
    });
  } catch (error) {
    if (error instanceof AssetNodeReservationError) {
      return {
        status: "failed",
        failure: { phase: "preflight", code: "write-failed", retryable: true, mayHaveCharged: false },
      };
    }
    return { status: "failed", failure: preflightFailure(error) };
  }
}

function preflightFailure(error: unknown): AssetNodeFailure {
  if (error instanceof AssetNodePathError) {
    return { phase: "preflight", code: "invalid-path", retryable: false, mayHaveCharged: false };
  }
  if (error instanceof AssetNodeProcessError) {
    return { phase: "preflight", code: error.code, retryable: false, mayHaveCharged: false };
  }
  return failureFromRedacted("preflight", classifyAssetError(error));
}

function providerFailure(error: unknown): AssetNodeFailure {
  return failureFromRedacted("provider", classifyAssetError(error));
}

function processingFailure(error: unknown): AssetNodeFailure {
  if (error instanceof AssetNodeProcessError) {
    return { phase: "processing", code: error.code, retryable: false, mayHaveCharged: true };
  }
  return { phase: "processing", code: "processing-failed", retryable: false, mayHaveCharged: true };
}

function failureFromRedacted(phase: AssetNodeFailure["phase"], error: RedactedAssetError): AssetNodeFailure {
  return {
    phase,
    code: error.code,
    retryable: error.retryable,
    mayHaveCharged: phase === "preflight" ? false : error.mayHaveCharged,
  };
}

async function persistOrReportOrphan(
  asset: AssetNodePersistedAsset,
  cache: "hit" | AssetNodeCacheMissReason | "force-cache-hit",
  persist: AssetNodeGenerationInput["persist"],
  replacement: AssetNodeReplacement | undefined,
): Promise<AssetNodeGenerationResult> {
  if (persist === undefined) {
    await replacement?.commit();
    return cache === "hit"
      ? { status: "cache-hit", asset, mayHaveCharged: false }
      : { status: "stored", asset, cache, mayHaveCharged: true };
  }

  try {
    await persist(asset);
    await replacement?.commit();
    return cache === "hit"
      ? { status: "cache-hit", asset, mayHaveCharged: false }
      : { status: "stored", asset, cache, mayHaveCharged: true };
  } catch {
    if (replacement !== undefined) {
      try {
        await replacement.rollback();
      } catch {
        return {
          status: "failed",
          failure: { phase: "write", code: "write-failed", retryable: true, mayHaveCharged: true },
        };
      }
      return {
        status: "failed",
        failure: { phase: "persistence", code: "persistence-failed", retryable: false, mayHaveCharged: true },
      };
    }
    return {
      status: "orphaned",
      orphan: { reason: "persistence-failed", asset },
      cache,
      mayHaveCharged: cache !== "hit",
    };
  }
}
