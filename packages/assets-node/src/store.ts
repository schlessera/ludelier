import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  hashAssetContent,
  isVerifiedAssetCacheHit,
  parseAssetProvenanceSidecar,
  stableStringify,
} from "@ludelier/assets";
import type {
  AssetProvenanceSidecar,
  PostProcessingRecipe,
  ProvenanceParseResult,
  RedactedAssetRequest,
  ResolvedAudioGenerationRequest,
  ResolvedImageGenerationRequest,
} from "@ludelier/assets";
import { extensionForOutputFormat, mimeTypeForOutputFormat } from "./process";

/** Roots controlled by the Node host. Provenance is required to be outside the public root. */
export interface AssetNodeStoreOptions {
  readonly publicRoot: string;
  readonly provenanceRoot: string;
}

/** A filesystem-safe identity plus a path relative to one Story's public asset directory. */
export interface AssetNodeDestination {
  readonly storyId: string;
  readonly assetId: string;
  readonly relativePath: string;
}

/** Controlled final paths. These are host-internal and never become Story metadata. */
export interface AssetNodeFilePaths {
  readonly destination: AssetNodeDestination;
  readonly mediaPath: string;
  readonly provenancePath: string;
  readonly mediaDirectory: string;
  readonly provenanceDirectory: string;
  readonly publicUrl: string;
}

/** Redacted persisted asset data a caller may register atomically in its own Story transaction. */
export interface AssetNodePersistedAsset {
  readonly storyId: string;
  readonly assetId: string;
  readonly relativePath: string;
  readonly publicUrl: string;
  readonly mimeType: string;
  readonly extension: string;
  readonly byteSize: number;
  readonly requestHash: string;
  readonly contentHash: string;
  readonly provenance: AssetProvenanceSidecar;
}

export type AssetNodeCacheMissReason =
  | "not-found"
  | "incomplete"
  | "unsafe-entry"
  | "invalid-sidecar"
  | "request-mismatch"
  | "metadata-mismatch"
  | "content-mismatch"
  | "unreadable";

export type AssetNodeCacheLookup =
  | { readonly status: "hit"; readonly asset: AssetNodePersistedAsset }
  | {
      readonly status: "miss";
      readonly reason: AssetNodeCacheMissReason;
      /** A miss with occupied=true must not be overwritten; surface it as a destination conflict. */
      readonly occupied: boolean;
    };

/**
 * Cache verification needs target identity and effective request fields, but never a plaintext
 * prompt. Full resolved requests remain structurally compatible with this narrow shape.
 */
export type AssetNodeCacheRequest =
  | (Pick<ResolvedImageGenerationRequest, "kind" | "role" | "outputFormat" | "parameters"> & {
      readonly target: Pick<
        ResolvedImageGenerationRequest["target"],
        "providerId" | "modelId" | "kind" | "endpoint"
      >;
    })
  | (Pick<ResolvedAudioGenerationRequest, "kind" | "role" | "outputFormat" | "parameters"> & {
      readonly target: Pick<
        ResolvedAudioGenerationRequest["target"],
        "providerId" | "modelId" | "kind" | "endpoint"
      >;
    });

export type AssetNodeInventoryStatus =
  | "valid"
  | "orphaned-media"
  | "orphaned-provenance"
  | "invalid"
  | "unsafe"
  | "unreadable";

/**
 * A redacted view of one asset identity discovered under the store's controlled roots.
 * It deliberately exposes neither filesystem paths nor provenance payloads.
 */
export interface AssetNodeInventoryRecord {
  readonly storyId: string;
  readonly relativePath: string;
  readonly publicUrl: string;
  readonly status: AssetNodeInventoryStatus;
  readonly extension?: string;
  readonly byteSize?: number;
  readonly requestHash?: string;
  readonly contentHash?: string;
}

export class AssetNodePathError extends Error {
  constructor() {
    super("Asset destination is invalid.");
    this.name = "AssetNodePathError";
  }
}

export class AssetNodeWriteError extends Error {
  constructor() {
    super("Asset files could not be written.");
    this.name = "AssetNodeWriteError";
  }
}

/**
 * A private reservation could not be acquired. The lock pathname and owner are intentionally never
 * exposed: an existing, malformed, or abandoned lock requires a cooperative retry or recovery.
 */
export class AssetNodeReservationError extends Error {
  constructor() {
    super("Asset destination is busy or requires recovery.");
    this.name = "AssetNodeReservationError";
  }
}

/** Holds force-replacement backups until the Story transaction either commits or rolls back. */
export interface AssetNodeReplacement {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * The package's only filesystem boundary. Controlled roots must not be writable by untrusted
 * same-UID processes: Node 20 lacks portable openat/renameat2-style confinement against a path
 * swap between validation and operation.
 */
export class AssetNodeStore {
  readonly #publicRoot: string;
  readonly #provenanceRoot: string;

  constructor(options: AssetNodeStoreOptions) {
    if (!path.isAbsolute(options.publicRoot) || !path.isAbsolute(options.provenanceRoot)) {
      throw new AssetNodePathError();
    }
    this.#publicRoot = path.resolve(options.publicRoot);
    this.#provenanceRoot = path.resolve(options.provenanceRoot);
    if (rootsOverlap(this.#publicRoot, this.#provenanceRoot)) throw new AssetNodePathError();
  }

  /**
   * Lists assets from the controlled public and provenance roots without following symlinks.
   * Records are sorted by filesystem-safe identity and include only redacted metadata.
   */
  async listInventory(): Promise<readonly AssetNodeInventoryRecord[]> {
    const [mediaEntries, provenanceEntries] = await Promise.all([
      collectInventoryEntries(this.#publicRoot, "media"),
      collectInventoryEntries(this.#provenanceRoot, "provenance"),
    ]);
    const keys = new Set([...mediaEntries.keys(), ...provenanceEntries.keys()]);
    const inventory = await Promise.all(
      [...keys].map((key) => inventoryRecord(mediaEntries.get(key), provenanceEntries.get(key))),
    );
    return inventory.sort(compareInventoryRecords);
  }

  /**
   * Resolves a destination only after creating and canonicalising its controlled directories.
   * The output URL is deliberately always root-relative under `/assets`.
   */
  async prepareDestination(
    destination: AssetNodeDestination,
    extension: string,
  ): Promise<AssetNodeFilePaths> {
    validateDestination(destination, extension);

    const mediaPath = path.resolve(this.#publicRoot, destination.storyId, destination.relativePath);
    const provenancePath = path.resolve(
      this.#provenanceRoot,
      destination.storyId,
      `${destination.relativePath}.json`,
    );
    if (!isBelow(this.#publicRoot, mediaPath) || !isBelow(this.#provenanceRoot, provenancePath)) {
      throw new AssetNodePathError();
    }
    const relativeDirectories = destination.relativePath.split("/").slice(0, -1);
    const [publicDirectory, provenanceDirectory] = await Promise.all([
      canonicalChildDirectory(this.#publicRoot, [destination.storyId, ...relativeDirectories]),
      canonicalChildDirectory(this.#provenanceRoot, [destination.storyId, ...relativeDirectories]),
    ]);
    if (rootsOverlap(publicDirectory.root, provenanceDirectory.root)) throw new AssetNodePathError();

    return {
      destination: { ...destination },
      mediaPath: path.join(publicDirectory.directory, path.basename(mediaPath)),
      provenancePath: path.join(provenanceDirectory.directory, path.basename(provenancePath)),
      mediaDirectory: publicDirectory.directory,
      provenanceDirectory: provenanceDirectory.directory,
      publicUrl: `/assets/${destination.storyId}/${destination.relativePath}`,
    };
  }

  /**
   * Accepts a cache entry only when two regular controlled files and parsed redacted provenance
   * agree with the request, expected final metadata, recipe, and freshly re-hashed media bytes.
   */
  async lookupCache(
    paths: AssetNodeFilePaths,
    request: AssetNodeCacheRequest,
    requestHash: string,
    postProcessing: PostProcessingRecipe,
  ): Promise<AssetNodeCacheLookup> {
    await this.#assertControlledPaths(paths);
    const [media, provenance] = await Promise.all([
      readControlledFile(paths.mediaPath),
      readControlledFile(paths.provenancePath),
    ]);

    if (media.status === "missing" && provenance.status === "missing") {
      return { status: "miss", reason: "not-found", occupied: false };
    }
    if (media.status === "unsafe" || provenance.status === "unsafe") {
      return { status: "miss", reason: "unsafe-entry", occupied: true };
    }
    if (media.status === "unreadable" || provenance.status === "unreadable") {
      return { status: "miss", reason: "unreadable", occupied: true };
    }
    if (media.status === "missing" || provenance.status === "missing") {
      return { status: "miss", reason: "incomplete", occupied: true };
    }

    if (media.status !== "present" || provenance.status !== "present") {
      return { status: "miss", reason: "unreadable", occupied: true };
    }

    let parsed: ProvenanceParseResult;
    try {
      parsed = parseAssetProvenanceSidecar(JSON.parse(new TextDecoder().decode(provenance.bytes)));
    } catch {
      return { status: "miss", reason: "invalid-sidecar", occupied: true };
    }
    if (!parsed.success) return { status: "miss", reason: "invalid-sidecar", occupied: true };

    const verifiedContentHash = await hashAssetContent(media.bytes);
    if (!isVerifiedAssetCacheHit(parsed.data, requestHash, verifiedContentHash)) {
      return {
        status: "miss",
        reason: parsed.data.requestHash === requestHash ? "content-mismatch" : "request-mismatch",
        occupied: true,
      };
    }
    if (!hasCompatibleMetadata(parsed.data, request, postProcessing, media.bytes.byteLength)) {
      return { status: "miss", reason: "metadata-mismatch", occupied: true };
    }

    return { status: "hit", asset: persistedAsset(paths, parsed.data) };
  }

  /**
   * Runs an authoritative operation under an opaque per-destination reservation. The lock lives
   * only below the private provenance root and is released only after the supplied operation settles.
   */
  async withDestinationReservation<T>(paths: AssetNodeFilePaths, operation: () => Promise<T>): Promise<T> {
    const reservation = await this.#acquireDestinationReservation(paths);
    try {
      return await operation();
    } finally {
      await reservation.release();
    }
  }

  /**
   * Stages media and private provenance beside their final files. Publication is a same-directory
   * hard link, which fails on an occupied final instead of replacing it. A partial pair is retained
   * as an inspectable orphan; cleanup never removes a final pathname.
   */
  async stageAndCommit(
    paths: AssetNodeFilePaths,
    bytes: Uint8Array,
    provenance: AssetProvenanceSidecar,
  ): Promise<void> {
    const mediaTemporary = path.join(
      paths.mediaDirectory,
      `.${path.basename(paths.mediaPath)}.${randomUUID()}.tmp`,
    );
    const provenanceTemporary = path.join(
      paths.provenanceDirectory,
      `.${path.basename(paths.provenancePath)}.${randomUUID()}.tmp`,
    );
    let mediaTemporaryIdentity: FileIdentity | undefined;
    let provenanceTemporaryIdentity: FileIdentity | undefined;

    try {
      await this.#assertControlledPaths(paths);
      const writes = await Promise.allSettled([
        writeFile(mediaTemporary, bytes, { flag: "wx" }),
        writeFile(provenanceTemporary, JSON.stringify(provenance), { encoding: "utf8", flag: "wx" }),
      ]);
      [mediaTemporaryIdentity, provenanceTemporaryIdentity] = await Promise.all([
        possibleOwnedRegularFileIdentity(mediaTemporary),
        possibleOwnedRegularFileIdentity(provenanceTemporary),
      ]);
      if (writes.some((write) => write.status === "rejected")) throw new AssetNodeWriteError();

      await this.#assertControlledPaths(paths);
      await linkOwnedTemporary(provenanceTemporary, paths.provenancePath, provenanceTemporaryIdentity);
      await this.#assertControlledPaths(paths);
      await linkOwnedTemporary(mediaTemporary, paths.mediaPath, mediaTemporaryIdentity);
    } catch (error) {
      if (error instanceof AssetNodeWriteError || error instanceof AssetNodePathError) throw error;
      throw new AssetNodeWriteError();
    } finally {
      await Promise.all([
        cleanupOwnedTemporary(mediaTemporary, mediaTemporaryIdentity),
        cleanupOwnedTemporary(provenanceTemporary, provenanceTemporaryIdentity),
      ]);
    }
  }

  /**
   * Replaces only the exact byte-verified pair identified by a current cache lookup. New files are
   * staged first; hard-link backups make each atomic rename reversible without exposing an absent
   * final pathname if the second half of the pair cannot publish.
   */
  async replaceVerifiedCache(
    paths: AssetNodeFilePaths,
    expected: AssetNodePersistedAsset,
    bytes: Uint8Array,
    provenance: AssetProvenanceSidecar,
  ): Promise<AssetNodeReplacement> {
    const mediaTemporary = path.join(
      paths.mediaDirectory,
      `.${path.basename(paths.mediaPath)}.${randomUUID()}.tmp`,
    );
    const provenanceTemporary = path.join(
      paths.provenanceDirectory,
      `.${path.basename(paths.provenancePath)}.${randomUUID()}.tmp`,
    );
    let mediaTemporaryIdentity: FileIdentity | undefined;
    let provenanceTemporaryIdentity: FileIdentity | undefined;
    let mediaBackup: OwnedBackup | undefined;
    let provenanceBackup: OwnedBackup | undefined;
    let mediaPublished = false;
    let provenancePublished = false;
    let handoff = false;

    try {
      const existing = await this.#verifiedCachePair(paths, expected);
      const writes = await Promise.allSettled([
        writeFile(mediaTemporary, bytes, { flag: "wx" }),
        writeFile(provenanceTemporary, JSON.stringify(provenance), { encoding: "utf8", flag: "wx" }),
      ]);
      [mediaTemporaryIdentity, provenanceTemporaryIdentity] = await Promise.all([
        possibleOwnedRegularFileIdentity(mediaTemporary),
        possibleOwnedRegularFileIdentity(provenanceTemporary),
      ]);
      if (writes.some((write) => write.status === "rejected")) throw new AssetNodeWriteError();
      [mediaBackup, provenanceBackup] = await Promise.all([
        backupVerifiedFile(paths.mediaPath, existing.media),
        backupVerifiedFile(paths.provenancePath, existing.provenance),
      ]);

      await replaceVerifiedFile(
        provenanceTemporary,
        provenanceTemporaryIdentity,
        paths.provenancePath,
        existing.provenance,
      );
      provenancePublished = true;
      await replaceVerifiedFile(mediaTemporary, mediaTemporaryIdentity, paths.mediaPath, existing.media);
      mediaPublished = true;

      handoff = true;
      let settled = false;
      return {
        commit: async () => {
          if (settled) return;
          settled = true;
          await Promise.all([
            cleanupOwnedTemporary(mediaBackup?.path ?? "", mediaBackup?.identity),
            cleanupOwnedTemporary(provenanceBackup?.path ?? "", provenanceBackup?.identity),
          ]);
        },
        rollback: async () => {
          if (settled) return;
          settled = true;
          const [mediaRestored, provenanceRestored] = await Promise.all([
            restoreVerifiedBackup(paths.mediaPath, mediaTemporaryIdentity, mediaBackup),
            restoreVerifiedBackup(paths.provenancePath, provenanceTemporaryIdentity, provenanceBackup),
          ]);
          await Promise.all([
            cleanupOwnedTemporary(mediaBackup?.path ?? "", mediaBackup?.identity),
            cleanupOwnedTemporary(provenanceBackup?.path ?? "", provenanceBackup?.identity),
          ]);
          if (!mediaRestored || !provenanceRestored) throw new AssetNodeWriteError();
        },
      };
    } catch (error) {
      if (mediaPublished) await restoreVerifiedBackup(paths.mediaPath, mediaTemporaryIdentity, mediaBackup);
      if (provenancePublished) {
        await restoreVerifiedBackup(paths.provenancePath, provenanceTemporaryIdentity, provenanceBackup);
      }
      if (error instanceof AssetNodeWriteError || error instanceof AssetNodePathError) throw error;
      throw new AssetNodeWriteError();
    } finally {
      await Promise.all([
        cleanupOwnedTemporary(mediaTemporary, mediaTemporaryIdentity),
        cleanupOwnedTemporary(provenanceTemporary, provenanceTemporaryIdentity),
        ...(handoff
          ? []
          : [
              cleanupOwnedTemporary(mediaBackup?.path ?? "", mediaBackup?.identity),
              cleanupOwnedTemporary(provenanceBackup?.path ?? "", provenanceBackup?.identity),
            ]),
      ]);
    }
  }

  async #verifiedCachePair(
    paths: AssetNodeFilePaths,
    expected: AssetNodePersistedAsset,
  ): Promise<VerifiedCachePair> {
    await this.#assertControlledPaths(paths);
    const [initialMedia, initialProvenance] = await Promise.all([
      ownedRegularFileIdentity(paths.mediaPath),
      ownedRegularFileIdentity(paths.provenancePath),
    ]);
    const [media, sidecar] = await Promise.all([
      readControlledFile(paths.mediaPath),
      readControlledFile(paths.provenancePath),
    ]);
    const [currentMedia, currentProvenance] = await Promise.all([
      ownedRegularFileIdentity(paths.mediaPath),
      ownedRegularFileIdentity(paths.provenancePath),
    ]);
    if (
      !sameFileIdentity(initialMedia, currentMedia) ||
      !sameFileIdentity(initialProvenance, currentProvenance) ||
      media.status !== "present" ||
      sidecar.status !== "present"
    ) {
      throw new AssetNodeWriteError();
    }
    let provenance: ProvenanceParseResult;
    try {
      provenance = parseAssetProvenanceSidecar(JSON.parse(new TextDecoder().decode(sidecar.bytes)));
    } catch {
      throw new AssetNodeWriteError();
    }
    const contentHash = await hashAssetContent(media.bytes);
    if (
      !provenance.success ||
      !isVerifiedAssetCacheHit(provenance.data, expected.requestHash, contentHash) ||
      JSON.stringify(provenance.data) !== JSON.stringify(expected.provenance)
    ) {
      throw new AssetNodeWriteError();
    }
    return { media: currentMedia, provenance: currentProvenance };
  }

  async #acquireDestinationReservation(paths: AssetNodeFilePaths): Promise<DestinationReservationLease> {
    await this.#assertControlledPaths(paths);
    const lockDirectory = await canonicalChildDirectory(this.#provenanceRoot, [".locks"]);
    const lockName = `${opaqueDestinationKey(paths.destination)}.lock`;
    const lockPath = path.join(lockDirectory.directory, lockName);
    const recoveryPath = path.join(lockDirectory.directory, `${lockName}.recovery`);
    const localTurn = queueLocalReservation(lockPath);

    try {
      await localTurn.wait;
      await this.#assertControlledPaths(paths);
      await assertCanonicalDirectory(lockDirectory.root, lockDirectory.directory);

      let lockHandle = await createReservationLock(lockPath, recoveryPath);
      if (lockHandle === undefined) {
        if (!(await recoverStaleReservation(lockPath, recoveryPath))) throw new AssetNodeReservationError();
        lockHandle = await createReservationLock(lockPath, recoveryPath);
        if (lockHandle === undefined) throw new AssetNodeReservationError();
      }
      return {
        release: async () => {
          let opened: FileIdentity | undefined;
          try {
            opened = await lockHandle.stat();
          } finally {
            await lockHandle.close().catch(() => undefined);
          }
          try {
            const current = await lstat(lockPath).catch(() => undefined);
            if (opened !== undefined && current !== undefined && sameFileIdentity(opened, current)) {
              await rm(lockPath, { force: false }).catch(() => undefined);
            }
          } finally {
            localTurn.release();
          }
        },
      };
    } catch (error) {
      localTurn.release();
      throw error;
    }
  }

  async #assertControlledPaths(paths: AssetNodeFilePaths): Promise<void> {
    const extension = path.posix.extname(paths.destination.relativePath).slice(1);
    validateDestination(paths.destination, extension);
    const [mediaRoot, provenanceRoot] = await Promise.all([
      canonicalRootDirectory(this.#publicRoot),
      canonicalRootDirectory(this.#provenanceRoot),
    ]);
    const expectedMediaPath = path.join(mediaRoot, paths.destination.storyId, paths.destination.relativePath);
    const expectedProvenancePath = path.join(
      provenanceRoot,
      paths.destination.storyId,
      `${paths.destination.relativePath}.json`,
    );
    if (
      paths.mediaPath !== expectedMediaPath ||
      paths.provenancePath !== expectedProvenancePath ||
      paths.mediaDirectory !== path.dirname(expectedMediaPath) ||
      paths.provenanceDirectory !== path.dirname(expectedProvenancePath) ||
      paths.publicUrl !== `/assets/${paths.destination.storyId}/${paths.destination.relativePath}`
    ) {
      throw new AssetNodePathError();
    }
    await Promise.all([
      assertCanonicalDirectory(mediaRoot, paths.mediaDirectory),
      assertCanonicalDirectory(provenanceRoot, paths.provenanceDirectory),
    ]);
  }
}

type InventoryFileKind = "media" | "provenance";
type InventoryEntryStatus = "regular" | "unsafe" | "unreadable";

interface InventoryEntry {
  readonly storyId: string;
  readonly relativePath: string;
  readonly filePath: string;
  readonly status: InventoryEntryStatus;
}

async function collectInventoryEntries(
  root: string,
  kind: InventoryFileKind,
): Promise<Map<string, InventoryEntry>> {
  const entries = new Map<string, InventoryEntry>();
  await visitDirectory(root, []);
  return entries;

  async function visitDirectory(directory: string, segments: readonly string[]): Promise<void> {
    let directoryEntry: Stats;
    try {
      directoryEntry = await lstat(directory);
    } catch {
      return;
    }
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) return;

    let names: readonly string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }

    for (const name of names) {
      if (name === ".locks" || name.endsWith(".tmp")) continue;
      if (!safeSegment(name) || (segments.length === 0 && !safeId(name))) continue;

      const candidateSegments = [...segments, name];
      const candidatePath = path.join(directory, name);
      let candidate: Stats;
      try {
        candidate = await lstat(candidatePath);
      } catch {
        addEntry(candidateSegments, candidatePath, "unreadable");
        continue;
      }
      if (candidate.isDirectory() && !candidate.isSymbolicLink()) {
        await visitDirectory(candidatePath, candidateSegments);
        continue;
      }
      addEntry(
        candidateSegments,
        candidatePath,
        candidate.isFile() && !candidate.isSymbolicLink() ? "regular" : "unsafe",
      );
    }
  }

  function addEntry(segments: readonly string[], filePath: string, status: InventoryEntryStatus): void {
    const identity = inventoryIdentity(kind, segments);
    if (identity === undefined) return;
    entries.set(inventoryKey(identity.storyId, identity.relativePath), {
      ...identity,
      filePath,
      status,
    });
  }
}

function inventoryIdentity(
  kind: InventoryFileKind,
  segments: readonly string[],
): Pick<InventoryEntry, "storyId" | "relativePath"> | undefined {
  if (segments.length < 2) return undefined;
  const [storyId, ...relativeSegments] = segments;
  if (storyId === undefined) return undefined;
  const relativePath = relativeSegments.join("/");
  if (kind === "media") return { storyId, relativePath };

  if (!relativePath.endsWith(".json")) return undefined;
  const mediaRelativePath = relativePath.slice(0, -".json".length);
  if (mediaRelativePath.length === 0) return undefined;
  return { storyId, relativePath: mediaRelativePath };
}

function inventoryKey(storyId: string, relativePath: string): string {
  return `${storyId}\u0000${relativePath}`;
}

async function inventoryRecord(
  media: InventoryEntry | undefined,
  provenance: InventoryEntry | undefined,
): Promise<AssetNodeInventoryRecord> {
  const identity = media ?? provenance;
  if (identity === undefined) throw new AssetNodePathError();
  const record = {
    storyId: identity.storyId,
    relativePath: identity.relativePath,
    publicUrl: `/assets/${identity.storyId}/${identity.relativePath}`,
  };

  const [mediaFile, provenanceFile] = await Promise.all([
    readInventoryEntry(media),
    readInventoryEntry(provenance),
  ]);
  if (mediaFile.status === "unsafe" || provenanceFile.status === "unsafe") {
    return { ...record, status: "unsafe" };
  }
  if (mediaFile.status === "unreadable" || provenanceFile.status === "unreadable") {
    return { ...record, status: "unreadable" };
  }

  const parsed =
    provenanceFile.status === "present" ? parseInventoryProvenance(provenanceFile.bytes) : undefined;
  if (provenanceFile.status === "present" && parsed === undefined) {
    return { ...record, status: "invalid" };
  }
  if (mediaFile.status === "missing") {
    if (parsed === undefined) return { ...record, status: "orphaned-provenance" };
    return {
      ...record,
      status: "orphaned-provenance",
      extension: parsed.extension,
      byteSize: parsed.byteSize,
      requestHash: parsed.requestHash,
      contentHash: parsed.contentHash,
    };
  }
  if (provenanceFile.status === "missing" && mediaFile.status === "present") {
    return {
      ...record,
      status: "orphaned-media",
      extension: inventoryExtension(record.relativePath),
      byteSize: mediaFile.bytes.byteLength,
    };
  }
  if (mediaFile.status !== "present" || provenanceFile.status !== "present" || parsed === undefined) {
    return { ...record, status: "unreadable" };
  }

  let contentHash: string;
  try {
    contentHash = await hashAssetContent(mediaFile.bytes);
  } catch {
    return { ...record, status: "unreadable" };
  }
  if (parsed.contentHash !== contentHash || parsed.byteSize !== mediaFile.bytes.byteLength) {
    return { ...record, status: "invalid" };
  }
  return {
    ...record,
    status: "valid",
    extension: parsed.extension,
    byteSize: mediaFile.bytes.byteLength,
    requestHash: parsed.requestHash,
    contentHash,
  };
}

async function readInventoryEntry(entry: InventoryEntry | undefined): Promise<ControlledRead> {
  if (entry === undefined) return { status: "missing" };
  if (entry.status === "unsafe") return { status: "unsafe" };
  if (entry.status === "unreadable") return { status: "unreadable" };
  return readControlledFile(entry.filePath);
}

function parseInventoryProvenance(bytes: Uint8Array): AssetProvenanceSidecar | undefined {
  try {
    const parsed = parseAssetProvenanceSidecar(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function inventoryExtension(relativePath: string): string | undefined {
  const extension = path.posix.extname(relativePath).slice(1);
  return safeExtension(extension) ? extension : undefined;
}

function compareInventoryRecords(left: AssetNodeInventoryRecord, right: AssetNodeInventoryRecord): number {
  if (left.storyId < right.storyId) return -1;
  if (left.storyId > right.storyId) return 1;
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  return 0;
}

function validateDestination(destination: AssetNodeDestination, extension: string): void {
  if (!safeId(destination.storyId) || !safeId(destination.assetId) || !safeExtension(extension)) {
    throw new AssetNodePathError();
  }
  if (typeof destination.relativePath !== "string" || destination.relativePath.length === 0) {
    throw new AssetNodePathError();
  }
  if (
    destination.relativePath.includes("\\") ||
    destination.relativePath.includes("\u0000") ||
    path.posix.isAbsolute(destination.relativePath) ||
    path.win32.isAbsolute(destination.relativePath) ||
    path.posix.normalize(destination.relativePath) !== destination.relativePath
  ) {
    throw new AssetNodePathError();
  }

  const segments = destination.relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".." || !safeSegment(segment),
    ) ||
    path.posix.extname(destination.relativePath) !== `.${extension}`
  ) {
    throw new AssetNodePathError();
  }
}

function safeId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function safeExtension(value: string): boolean {
  return /^[a-z0-9]+$/.test(value);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function rootsOverlap(left: string, right: string): boolean {
  return left === right || isBelow(left, right) || isBelow(right, left);
}
interface CanonicalDirectory {
  readonly root: string;
  readonly directory: string;
}

interface DestinationReservationLease {
  release(): Promise<void>;
}

interface LocalReservationTurn {
  readonly wait: Promise<void>;
  release(): void;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface VerifiedCachePair {
  readonly media: FileIdentity;
  readonly provenance: FileIdentity;
}

interface OwnedBackup {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface ReservationLockMetadata {
  readonly version: 1;
  readonly host: string;
  readonly pid: number;
  readonly processStartTicks?: string;
}

type ProcessStartLookup =
  | { readonly status: "present"; readonly value: string }
  | { readonly status: "missing" | "unavailable" };

const MALFORMED_LOCK_RECOVERY_AGE_MILLISECONDS = 60_000;

const localReservationTails = new Map<string, Promise<void>>();

async function canonicalRootDirectory(root: string): Promise<string> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new AssetNodePathError();
  return realpath(root);
}

async function canonicalChildDirectory(
  root: string,
  segments: readonly string[],
): Promise<CanonicalDirectory> {
  await mkdir(root, { recursive: true });
  const canonicalRoot = await canonicalRootDirectory(root);
  let directory = canonicalRoot;
  for (const segment of segments) {
    const candidate = path.join(directory, segment);
    await mkdir(candidate, { recursive: true });
    await assertCanonicalDirectory(canonicalRoot, candidate);
    directory = candidate;
  }
  return { root: canonicalRoot, directory };
}

async function assertCanonicalDirectory(root: string, directory: string): Promise<void> {
  if (directory !== root && !isBelow(root, directory)) throw new AssetNodePathError();
  const verifiedRoot = await canonicalRootDirectory(root);
  if (verifiedRoot !== root) throw new AssetNodePathError();

  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(current)) !== current) {
      throw new AssetNodePathError();
    }
  }
}

function queueLocalReservation(lockPath: string): LocalReservationTurn {
  const prior = localReservationTails.get(lockPath) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = prior.then(() => current);
  localReservationTails.set(lockPath, tail);
  let released = false;

  return {
    wait: prior,
    release: () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (localReservationTails.get(lockPath) === tail) localReservationTails.delete(lockPath);
    },
  };
}

function opaqueDestinationKey(destination: AssetNodeDestination): string {
  return createHash("sha256")
    .update(destination.storyId)
    .update("\u0000")
    .update(destination.relativePath)
    .digest("hex");
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function ownedRegularFileIdentity(filePath: string): Promise<FileIdentity> {
  const entry = await lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new AssetNodeWriteError();
  return { dev: entry.dev, ino: entry.ino };
}

async function possibleOwnedRegularFileIdentity(filePath: string): Promise<FileIdentity | undefined> {
  try {
    return await ownedRegularFileIdentity(filePath);
  } catch {
    return undefined;
  }
}

async function linkOwnedTemporary(
  temporaryPath: string,
  finalPath: string,
  identity: FileIdentity | undefined,
): Promise<void> {
  if (identity === undefined || !sameFileIdentity(identity, await ownedRegularFileIdentity(temporaryPath))) {
    throw new AssetNodeWriteError();
  }
  try {
    await link(temporaryPath, finalPath);
  } catch {
    throw new AssetNodeWriteError();
  }
  if (!sameFileIdentity(identity, await ownedRegularFileIdentity(finalPath))) throw new AssetNodeWriteError();
}

async function cleanupOwnedTemporary(
  temporaryPath: string,
  identity: FileIdentity | undefined,
): Promise<void> {
  if (identity === undefined) return;
  try {
    if (sameFileIdentity(identity, await ownedRegularFileIdentity(temporaryPath))) {
      await rm(temporaryPath, { force: false });
    }
  } catch {
    // A competing or unreadable temporary is left for recovery; never delete an unverified pathname.
  }
}

async function backupVerifiedFile(finalPath: string, expected: FileIdentity): Promise<OwnedBackup> {
  if (!sameFileIdentity(expected, await ownedRegularFileIdentity(finalPath))) throw new AssetNodeWriteError();
  const backupPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${randomUUID()}.force-backup`,
  );
  let identity: FileIdentity | undefined;
  try {
    await link(finalPath, backupPath);
    identity = await ownedRegularFileIdentity(backupPath);
    if (
      !sameFileIdentity(expected, identity) ||
      !sameFileIdentity(expected, await ownedRegularFileIdentity(finalPath))
    ) {
      throw new AssetNodeWriteError();
    }
    return { path: backupPath, identity };
  } catch (error) {
    await cleanupOwnedTemporary(backupPath, identity);
    if (error instanceof AssetNodeWriteError) throw error;
    throw new AssetNodeWriteError();
  }
}

async function replaceVerifiedFile(
  temporaryPath: string,
  temporaryIdentity: FileIdentity | undefined,
  finalPath: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  if (
    temporaryIdentity === undefined ||
    !sameFileIdentity(temporaryIdentity, await ownedRegularFileIdentity(temporaryPath)) ||
    !sameFileIdentity(expectedIdentity, await ownedRegularFileIdentity(finalPath))
  ) {
    throw new AssetNodeWriteError();
  }
  try {
    await rename(temporaryPath, finalPath);
  } catch {
    throw new AssetNodeWriteError();
  }
  if (!sameFileIdentity(temporaryIdentity, await ownedRegularFileIdentity(finalPath))) {
    throw new AssetNodeWriteError();
  }
}

async function restoreVerifiedBackup(
  finalPath: string,
  replacementIdentity: FileIdentity | undefined,
  backup: OwnedBackup | undefined,
): Promise<boolean> {
  if (replacementIdentity === undefined || backup === undefined) return false;
  try {
    if (
      !sameFileIdentity(replacementIdentity, await ownedRegularFileIdentity(finalPath)) ||
      !sameFileIdentity(backup.identity, await ownedRegularFileIdentity(backup.path))
    ) {
      return false;
    }
    await rename(backup.path, finalPath);
    return sameFileIdentity(backup.identity, await ownedRegularFileIdentity(finalPath));
  } catch {
    return false;
  }
}

async function createReservationLock(
  lockPath: string,
  recoveryPath: string,
): Promise<FileHandle | undefined> {
  try {
    await lstat(recoveryPath);
    return undefined;
  } catch (error) {
    if (!isMissing(error)) throw new AssetNodeReservationError();
  }
  return publishReservationLock(lockPath);
}

/**
 * Writes and fsyncs metadata in a unique private temporary, then hard-links it into the final
 * pathname. Observers therefore see either no lock or a fully formed immutable metadata file.
 */
async function publishReservationLock(lockPath: string): Promise<FileHandle | undefined> {
  const temporaryPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${randomUUID()}.lock-publish.tmp`,
  );
  let temporaryHandle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  let published = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx");
    await temporaryHandle.writeFile(JSON.stringify(await reservationLockMetadata()), "utf8");
    await temporaryHandle.sync();
    identity = await temporaryHandle.stat();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await link(temporaryPath, lockPath);
    } catch (error) {
      if (isAlreadyExists(error)) return undefined;
      throw error;
    }
    published = true;
    const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (identity === undefined || !sameFileIdentity(identity, await handle.stat())) {
        throw new AssetNodeReservationError();
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (published) await cleanupOwnedTemporary(lockPath, identity);
    if (error instanceof AssetNodeReservationError) throw error;
    throw new AssetNodeReservationError();
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await cleanupOwnedTemporary(temporaryPath, identity);
  }
}

async function reservationLockMetadata(): Promise<ReservationLockMetadata> {
  const processStart = await readProcessStartTicks(process.pid);
  return {
    version: 1,
    host: hostname(),
    pid: process.pid,
    ...(processStart.status === "present" ? { processStartTicks: processStart.value } : {}),
  };
}

async function recoverStaleReservation(lockPath: string, recoveryPath: string): Promise<boolean> {
  let recoveryHandle = await publishReservationLock(recoveryPath);
  if (recoveryHandle === undefined) {
    if (!(await removeProvenStaleReservationLock(recoveryPath))) return false;
    recoveryHandle = await publishReservationLock(recoveryPath);
    if (recoveryHandle === undefined) return false;
  }
  let recoveryIdentity: FileIdentity | undefined;
  try {
    recoveryIdentity = await recoveryHandle.stat();
    return removeProvenStaleReservationLock(lockPath);
  } catch {
    return false;
  } finally {
    await recoveryHandle.close().catch(() => undefined);
    await cleanupOwnedTemporary(recoveryPath, recoveryIdentity);
  }
}

async function removeProvenStaleReservationLock(lockPath: string): Promise<boolean> {
  const initial = await lstat(lockPath).catch(() => undefined);
  if (initial === undefined) return true;
  if (!initial.isFile() || initial.isSymbolicLink()) return false;
  const identity: FileIdentity = { dev: initial.dev, ino: initial.ino };
  const raw = await readFile(lockPath, "utf8").catch(() => undefined);
  const current = await lstat(lockPath).catch(() => undefined);
  if (raw === undefined || current === undefined || !current.isFile() || current.isSymbolicLink())
    return false;
  if (!sameFileIdentity(identity, current) || !(await isStaleReservationLock(raw, current))) return false;
  const final = await lstat(lockPath).catch(() => undefined);
  if (final === undefined) return true;
  if (!final.isFile() || final.isSymbolicLink() || !sameFileIdentity(identity, final)) return false;
  try {
    await rm(lockPath, { force: false });
    return true;
  } catch {
    return false;
  }
}

async function isStaleReservationLock(value: string, entry: Stats): Promise<boolean> {
  const metadata = parseReservationLockMetadata(value);
  if (metadata === undefined) {
    return Date.now() - entry.mtimeMs >= MALFORMED_LOCK_RECOVERY_AGE_MILLISECONDS;
  }
  if (metadata.host !== hostname()) return false;
  const processStart = await readProcessStartTicks(metadata.pid);
  if (metadata.processStartTicks === undefined) return !hasLiveProcess(metadata.pid);
  if (processStart.status === "missing") return true;
  if (processStart.status !== "present") return !hasLiveProcess(metadata.pid);
  return processStart.value !== metadata.processStartTicks;
}

function hasLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function parseReservationLockMetadata(value: string): ReservationLockMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const allowed = ["version", "host", "pid", "processStartTicks"];
  const host = record.host;
  const pid = record.pid;
  const processStartTicks = record.processStartTicks;
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    record.version !== 1 ||
    typeof host !== "string" ||
    host.length === 0 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    (processStartTicks !== undefined &&
      (typeof processStartTicks !== "string" || !/^[0-9]+$/.test(processStartTicks)))
  ) {
    return undefined;
  }
  return {
    version: 1,
    host,
    pid,
    ...(processStartTicks === undefined ? {} : { processStartTicks }),
  };
}

async function readProcessStartTicks(pid: number): Promise<ProcessStartLookup> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "unavailable" };
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return { status: "unavailable" };
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[0-9]+$/.test(startTicks)) return { status: "unavailable" };
  return { status: "present", value: startTicks };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isBelow(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

type ControlledRead =
  | { readonly status: "present"; readonly bytes: Uint8Array }
  | { readonly status: "missing" | "unsafe" | "unreadable" };

async function readControlledFile(filePath: string): Promise<ControlledRead> {
  let entry: Stats;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "unreadable" };
  }
  if (!entry.isFile() || entry.isSymbolicLink()) return { status: "unsafe" };

  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    return { status: "unsafe" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(entry, opened)) return { status: "unsafe" };
    return { status: "present", bytes: await handle.readFile() };
  } catch {
    return { status: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hasCompatibleMetadata(
  provenance: AssetProvenanceSidecar,
  request: AssetNodeCacheRequest,
  postProcessing: PostProcessingRecipe,
  byteSize: number,
): boolean {
  const mimeType = mimeTypeForOutputFormat(request.outputFormat);
  const extension = extensionForOutputFormat(request.outputFormat);
  const redactedRequest = redactCacheRequest(request);
  return (
    mimeType !== undefined &&
    extension !== undefined &&
    provenance.target.providerId === request.target.providerId &&
    provenance.target.modelId === request.target.modelId &&
    provenance.target.kind === request.target.kind &&
    provenance.target.endpoint === request.target.endpoint &&
    sameRedactedRequest(provenance.request, redactedRequest) &&
    provenance.mimeType === mimeType &&
    provenance.extension === extension &&
    provenance.byteSize === byteSize &&
    provenance.postProcessing.recipe === postProcessing.recipe &&
    provenance.postProcessing.version === postProcessing.version &&
    ((provenance.postProcessing.parameters === undefined && postProcessing.parameters === undefined) ||
      (provenance.postProcessing.parameters !== undefined &&
        postProcessing.parameters !== undefined &&
        stableStringify(provenance.postProcessing.parameters) === stableStringify(postProcessing.parameters)))
  );
}

function redactCacheRequest(request: AssetNodeCacheRequest): RedactedAssetRequest {
  if (request.kind === "image") {
    return {
      kind: "image",
      role: request.role,
      outputFormat: request.outputFormat,
      parameters: {
        background: request.parameters.background,
        ...(request.parameters.size === undefined ? {} : { size: { ...request.parameters.size } }),
        ...(request.parameters.seed === undefined ? {} : { seed: request.parameters.seed }),
        ...(request.parameters.quality === undefined ? {} : { quality: request.parameters.quality }),
      },
    };
  }
  return {
    kind: "audio",
    role: request.role,
    outputFormat: request.outputFormat,
    parameters: {
      ...(request.parameters.voice === undefined ? {} : { voice: request.parameters.voice }),
      ...(request.parameters.speed === undefined ? {} : { speed: request.parameters.speed }),
    },
  };
}

function sameRedactedRequest(left: RedactedAssetRequest, right: RedactedAssetRequest): boolean {
  if (left.kind !== right.kind || left.role !== right.role || left.outputFormat !== right.outputFormat) {
    return false;
  }
  if (left.kind === "image" && right.kind === "image") {
    return (
      left.parameters.background === right.parameters.background &&
      left.parameters.size?.width === right.parameters.size?.width &&
      left.parameters.size?.height === right.parameters.size?.height &&
      left.parameters.seed === right.parameters.seed &&
      left.parameters.quality === right.parameters.quality
    );
  }
  if (left.kind === "audio" && right.kind === "audio") {
    return (
      left.parameters.voice === right.parameters.voice && left.parameters.speed === right.parameters.speed
    );
  }
  return false;
}

function persistedAsset(
  paths: AssetNodeFilePaths,
  provenance: AssetProvenanceSidecar,
): AssetNodePersistedAsset {
  return {
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
}
