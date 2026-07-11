import path from "node:path";
import { z } from "zod";
import {
  createAssetProviders,
  type AssetGenerationRequest,
  type AssetProvider,
  type AssetProviderConfiguration,
} from "@ludelier/assets";
import {
  AssetNodeStore,
  generateAndStoreAsset,
  preflightAssetGeneration,
  type AssetNodeInventoryRecord,
} from "@ludelier/assets-node";
import { fail, ok, type EditLog, type Result } from "@ludelier/world";

/** Public and private filesystem roots are explicit host configuration, never Story data. */
export interface AssetStoreRoots {
  readonly publicRoot: string;
  readonly provenanceRoot: string;
}

/** Dependencies are injectable so CLI/MCP tests never need environment or network access. */
export interface AssetHostDependencies {
  readonly store: AssetNodeStore;
  readonly providers: readonly AssetProvider[];
  /** Persist the current log after a successful registration. It may be synchronous or awaited. */
  readonly persist: (log: EditLog) => void | Promise<void>;
}

interface EditLogTransactionTurn {
  readonly wait: Promise<void>;
  release(): void;
}

const editLogTransactionTails = new WeakMap<EditLog, Promise<void>>();

/** Request shared verbatim by the CLI and the explicitly authorized MCP tool. */
export interface GenerateAssetInput {
  readonly log: EditLog;
  readonly runId: string;
  readonly id: string;
  readonly destination: string;
  readonly request: AssetGenerationRequest;
  readonly force?: boolean;
}

/** Deliberately small success payload: no prompt, sidecar, provider response, or local path. */
export interface GeneratedAssetSummary {
  readonly id: string;
  readonly src: string;
  readonly kind: "image" | "audio";
  readonly byteSize: number;
  readonly contentHash: string;
  readonly requestHash: string;
}

export interface GeneratedAssetData {
  readonly status: "stored" | "cache-hit";
  /** True means the request dispatched a provider and therefore may have incurred a charge. */
  readonly mayHaveCharged: boolean;
  readonly asset: GeneratedAssetSummary;
}

export type AssetInventoryStatus =
  | "valid"
  | "orphaned-media"
  | "orphaned-sidecar"
  | "missing"
  | "corrupt"
  | "unsafe"
  | "unreadable";

/** Public inventory only: source URL plus stable status and hashes/sizes, never paths or sidecars. */
export interface AssetInventoryEntry {
  readonly src: string;
  readonly status: AssetInventoryStatus;
  readonly extension?: string;
  readonly byteSize?: number;
  readonly requestHash?: string;
  readonly contentHash?: string;
}

export interface AssetHost {
  readonly hasGenerationProvider: boolean;
  generate(input: GenerateAssetInput): Promise<Result<GeneratedAssetData>>;
  list(storyId: string): Promise<Result<readonly AssetInventoryEntry[]>>;
}

/** Validated at the host edge before a provider can be reached. */
export const assetGenerationInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/, "id must be slug-like ([A-Za-z0-9_.-]+)"),
    destination: z.string().min(1),
    request: z.unknown(),
    force: z.boolean().optional().default(false),
  })
  .strict();

/** Keep defaults controlled and deterministic while allowing every host caller to override them. */
export function defaultAssetStoreRoots(cwd = process.cwd()): AssetStoreRoots {
  return {
    publicRoot: path.resolve(cwd, "packages", "runtime-web", "public", "assets"),
    provenanceRoot: path.resolve(cwd, ".ludelier", "asset-provenance"),
  };
}

/** Environment inspection is intentionally key-presence-only; keys never leave this function. */
export function hasConfiguredAssetProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY);
}

export async function withAssetHostEditLogTransaction<T>(
  log: EditLog,
  operation: () => Promise<T>,
): Promise<T> {
  const turn = queueEditLogTransaction(log);
  await turn.wait;
  try {
    return await operation();
  } finally {
    turn.release();
  }
}

function queueEditLogTransaction(log: EditLog): EditLogTransactionTurn {
  const prior = editLogTransactionTails.get(log) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = prior.then(() => current);
  editLogTransactionTails.set(log, tail);
  let released = false;

  return {
    wait: prior,
    release: () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (editLogTransactionTails.get(log) === tail) editLogTransactionTails.delete(log);
    },
  };
}

/**
 * The one asset composition seam for human CLI and MCP. Node owns all file/cache/provenance work;
 * this host owns Story registration and its rollback when final metadata persistence fails.
 */
export function createAssetHost(deps: AssetHostDependencies): AssetHost {
  return {
    hasGenerationProvider: deps.providers.some((provider) => provider.targets.length > 0),
    async generate(input): Promise<Result<GeneratedAssetData>> {
      const parsed = assetGenerationInputSchema.safeParse({
        id: input.id,
        destination: input.destination,
        request: input.request,
        force: input.force,
      });
      if (!parsed.success) {
        return fail(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join(".") || "asset",
            message: issue.message,
          })),
        );
      }

      return withAssetHostEditLogTransaction(input.log, async () => {
        const story = input.log.currentStory();
        if (story.assets.some((asset) => asset.id === parsed.data.id)) {
          return fail([{ path: "id", message: `asset id "${parsed.data.id}" is already registered` }]);
        }
        // Force is deliberately narrow: assets-node accepts it only for a byte-verified matching
        // cache pair, while this host has already rejected duplicate Story metadata above.

        const destination = {
          storyId: story.meta.id,
          assetId: parsed.data.id,
          relativePath: parsed.data.destination,
        };
        const publicUrl = `/assets/${story.meta.id}/${parsed.data.destination}`;
        if (
          parsed.data.force &&
          story.assets.some((asset) => asset.id !== parsed.data.id && asset.src === publicUrl)
        ) {
          return fail([
            {
              path: "destination",
              message: "force cannot replace a controlled URL referenced by another Story asset",
            },
          ]);
        }
        const preflight = await preflightAssetGeneration({
          store: deps.store,
          providers: deps.providers,
          request: parsed.data.request as AssetGenerationRequest,
          destination,
          force: parsed.data.force,
        });
        if (preflight.status === "failed") {
          return fail([
            {
              path: preflight.failure.code === "force-requires-cache-hit" ? "force" : "asset",
              message: `asset ${preflight.failure.phase} failed (${preflight.failure.code})`,
            },
          ]);
        }

        // Cache hits register verified orphan bytes without a provider; an accepted force preflight
        // instead regenerates and atomically replaces that exact verified pair.
        const recordCount = input.log.recordsView().length;
        const generated = await generateAndStoreAsset({
          store: deps.store,
          providers: deps.providers,
          request: parsed.data.request as AssetGenerationRequest,
          destination,
          force: parsed.data.force,
          persist: async (asset) => {
            const registered = input.log.apply(
              "register-asset",
              {
                id: parsed.data.id,
                src: asset.publicUrl,
                kind: asset.provenance.target.kind,
                generated: true,
              },
              { runId: input.runId },
            );
            if (!registered.success) throw new Error();
            try {
              await deps.persist(input.log);
            } catch {
              // Only undo the record this invocation appended; never revert earlier edits sharing a
              // session runId. The media + sidecar remain discoverable through listInventory().
              if (input.log.recordsView().length === recordCount + 1) input.log.undo();
              throw new Error();
            }
          },
        });

        if (generated.status === "failed") {
          return fail([
            { path: "asset", message: `asset ${generated.failure.phase} failed (${generated.failure.code})` },
          ]);
        }
        if (generated.status === "orphaned") {
          return fail([
            {
              path: "asset",
              message: "asset bytes were retained as an orphan because Story metadata could not be persisted",
            },
          ]);
        }

        return ok({
          status: generated.status,
          mayHaveCharged: generated.mayHaveCharged,
          asset: {
            id: parsed.data.id,
            src: generated.asset.publicUrl,
            kind: generated.asset.provenance.target.kind,
            byteSize: generated.asset.byteSize,
            contentHash: generated.asset.contentHash,
            requestHash: generated.asset.requestHash,
          },
        });
      });
    },

    async list(storyId): Promise<Result<readonly AssetInventoryEntry[]>> {
      try {
        const records = await deps.store.listInventory();
        return ok(records.filter((record) => record.storyId === storyId).map(toInventoryEntry));
      } catch {
        return fail([{ path: "asset", message: "asset inventory could not be read" }]);
      }
    },
  };
}

/** Build BYOK providers only when their keys are configured; direct tests inject providers instead. */
export async function createAssetHostFromEnvironment(options: {
  readonly roots: AssetStoreRoots;
  readonly persist: AssetHostDependencies["persist"];
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}): Promise<AssetHost> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("asset generation requires fetch support");

  const configurations: AssetProviderConfiguration[] = [];
  if (env.OPENAI_API_KEY) {
    configurations.push({ type: "openai", options: { apiKey: env.OPENAI_API_KEY, fetchImpl } });
  }
  if (env.OPENROUTER_API_KEY) {
    configurations.push({ type: "openrouter", options: { apiKey: env.OPENROUTER_API_KEY, fetchImpl } });
  }

  return createAssetHost({
    store: new AssetNodeStore(options.roots),
    providers: await createAssetProviders(configurations),
    persist: options.persist,
  });
}

/** Build a listing-only host without reading keys or constructing providers. */
export function createAssetInventoryHost(roots: AssetStoreRoots): AssetHost {
  return createAssetHost({ store: new AssetNodeStore(roots), providers: [], persist: () => undefined });
}

function toInventoryEntry(record: AssetNodeInventoryRecord): AssetInventoryEntry {
  return {
    src: record.publicUrl,
    status: inventoryStatus(record.status),
    ...(record.extension === undefined ? {} : { extension: record.extension }),
    ...(record.byteSize === undefined ? {} : { byteSize: record.byteSize }),
    ...(record.requestHash === undefined ? {} : { requestHash: record.requestHash }),
    ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
  };
}

function inventoryStatus(status: AssetNodeInventoryRecord["status"]): AssetInventoryStatus {
  switch (status) {
    case "valid":
    case "orphaned-media":
    case "unsafe":
    case "unreadable":
      return status;
    case "orphaned-provenance":
      return "orphaned-sidecar";
    case "invalid":
      return "corrupt";
  }
}
