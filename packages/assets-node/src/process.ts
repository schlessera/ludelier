import sharp from "sharp";
import { assetOutputMediaForFormat, selectAssetPostProcessingRecipe } from "@ludelier/assets";
import type {
  AssetGenerationResult,
  AssetMediaKind,
  PostProcessingRecipe,
  ResolvedAudioGenerationRequest,
  ResolvedImageGenerationRequest,
} from "@ludelier/assets";

export interface ProcessedAsset {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly extension: string;
}

/**
 * The media processor consumes only effective output-affecting request fields. Full resolved
 * requests remain structurally compatible, while prompt-free ingress can use this narrow shape.
 */
export type AssetNodeProcessingRequest =
  | Pick<ResolvedImageGenerationRequest, "kind" | "role" | "outputFormat" | "parameters">
  | Pick<ResolvedAudioGenerationRequest, "kind" | "role" | "outputFormat" | "parameters">;

export class AssetNodeProcessError extends Error {
  readonly code: "invalid-output" | "processing-failed";

  constructor(code: "invalid-output" | "processing-failed") {
    super(code === "invalid-output" ? "Asset output is invalid." : "Asset processing failed.");
    this.name = "AssetNodeProcessError";
    this.code = code;
  }
}

/**
 * Returns the complete recipe, including every output-affecting parameter. Pass this exact value
 * to `hashAssetRequest` (or use the preflight result) so cache identity tracks host processing.
 */
export function postProcessingRecipe(request: AssetNodeProcessingRequest): PostProcessingRecipe {
  try {
    return selectAssetPostProcessingRecipe(request);
  } catch {
    throw new AssetNodeProcessError("invalid-output");
  }
}

/** Canonical MIME type for the portable output formats accepted by this Node host. */
export function mimeTypeForOutputFormat(format: string): string | undefined {
  return assetOutputMediaForFormat(format)?.mimeType;
}

/** Canonical extension for the portable output formats accepted by this Node host. */
export function extensionForOutputFormat(format: string): string | undefined {
  return assetOutputMediaForFormat(format)?.extension;
}

/**
 * Validates a provider's declared source media before it reaches Sharp, then emits final media in
 * the resolved request's declared format. Audio is byte-preserving but still strictly validated.
 */
export async function processGeneratedAsset(
  request: AssetNodeProcessingRequest,
  result: AssetGenerationResult,
): Promise<ProcessedAsset> {
  assertProviderResult(request.kind, result);

  if (request.kind === "audio") {
    const expected = assetOutputMediaForFormat(request.outputFormat);
    if (
      expected === undefined ||
      expected.kind !== "audio" ||
      result.mimeType !== expected.mimeType ||
      result.extension !== expected.extension ||
      !hasExpectedAudioPayload(request.outputFormat, result)
    ) {
      throw new AssetNodeProcessError("invalid-output");
    }
    return { bytes: result.bytes, mimeType: expected.mimeType, extension: expected.extension };
  }

  const expected = assetOutputMediaForFormat(request.outputFormat);
  const sharpFormat = imageSharpFormats[request.outputFormat];
  if (expected === undefined || expected.kind !== "image" || sharpFormat === undefined) {
    throw new AssetNodeProcessError("invalid-output");
  }

  try {
    const image = sharp(result.bytes, { animated: false, failOn: "error" }).rotate();
    const pipeline =
      request.role === "background"
        ? image.resize(requiredStageSize(request).width, requiredStageSize(request).height, {
            fit: "cover",
            position: "centre",
          })
        : image.ensureAlpha().trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const bytes = await pipeline.toFormat(sharpFormat).toBuffer();
    const metadata = await sharp(bytes, { animated: false, failOn: "error" }).metadata();

    if (metadata.format !== sharpFormat || bytes.byteLength === 0) {
      throw new AssetNodeProcessError("invalid-output");
    }

    return { bytes, mimeType: expected.mimeType, extension: expected.extension };
  } catch (error) {
    if (error instanceof AssetNodeProcessError) throw error;
    throw new AssetNodeProcessError("processing-failed");
  }
}

function requiredStageSize(request: Extract<AssetNodeProcessingRequest, { kind: "image" }>): {
  readonly width: number;
  readonly height: number;
} {
  const size = request.parameters.size;
  if (size === undefined) throw new AssetNodeProcessError("invalid-output");
  return size;
}

function assertProviderResult(kind: AssetMediaKind, result: AssetGenerationResult): void {
  if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength === 0) {
    throw new AssetNodeProcessError("invalid-output");
  }
  if (
    typeof result.createdAt !== "string" ||
    result.createdAt.length === 0 ||
    !Number.isFinite(Date.parse(result.createdAt))
  ) {
    throw new AssetNodeProcessError("invalid-output");
  }

  const declared = assetOutputMediaForFormat(result.extension);
  if (declared === undefined || declared.kind !== kind || result.mimeType !== declared.mimeType) {
    throw new AssetNodeProcessError("invalid-output");
  }
}

const imageSharpFormats: Readonly<Record<"png" | "jpeg" | "webp", "png" | "jpeg" | "webp">> = {
  png: "png",
  jpeg: "jpeg",
  webp: "webp",
};

/**
 * Signature-bearing audio is checked before it can be staged. Raw PCM is deliberately unframed
 * and therefore has no byte signature; it is accepted only when its provider adapter first
 * compared the received Content-Type with the canonical `audio/pcm` identity.
 */
function hasExpectedAudioPayload(format: string, result: AssetGenerationResult): boolean {
  switch (format) {
    case "mp3":
      return hasCompleteMp3Payload(result.bytes);
    case "wav":
      return hasCompleteWavPayload(result.bytes);
    case "opus":
      return hasCompleteOggOpusPayload(result.bytes);
    case "flac":
      return hasCompleteFlacPayload(result.bytes);
    case "aac":
      return hasCompleteAacPayload(result.bytes);
    case "pcm":
      return result.contentTypeValidated === true;
    default:
      return false;
  }
}

const mpeg1Layer1Bitrates = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] as const;
const mpeg1Layer2Bitrates = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384] as const;
const mpeg1Layer3Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;
const mpeg2Layer1Bitrates = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] as const;
const mpeg2Layer23Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const;

function hasCompleteMp3Payload(bytes: Uint8Array): boolean {
  let offset = 0;
  if (hasBytePrefix(bytes, [0x49, 0x44, 0x33])) {
    if (bytes.byteLength < 10) return false;
    const version = bytes[3];
    const flags = bytes[5];
    const tagSize = parseSynchsafeInteger(bytes, 6);
    if (version === undefined || version < 2 || version > 4 || flags === undefined || tagSize === undefined) {
      return false;
    }
    offset = 10 + tagSize + (version === 4 && (flags & 0x10) !== 0 ? 10 : 0);
  }
  return hasCompleteMp3Frame(bytes, offset);
}

function parseSynchsafeInteger(bytes: Uint8Array, offset: number): number | undefined {
  if (bytes.byteLength - offset < 4) return undefined;
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    (first & 0x80) !== 0 ||
    (second & 0x80) !== 0 ||
    (third & 0x80) !== 0 ||
    (fourth & 0x80) !== 0
  ) {
    return undefined;
  }
  return (first << 21) | (second << 14) | (third << 7) | fourth;
}

function hasCompleteMp3Frame(bytes: Uint8Array, offset: number): boolean {
  if (bytes.byteLength - offset < 4) return false;
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  if (first !== 0xff || second === undefined || third === undefined || (second & 0xe0) !== 0xe0) {
    return false;
  }
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return false;
  }
  const sampleRates =
    version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const sampleRate = sampleRates[sampleRateIndex];
  const bitrate = mp3Bitrate(version, layer, bitrateIndex);
  if (sampleRate === undefined || bitrate === undefined) return false;
  const padding = (third >> 1) & 0x01;
  const frameLength =
    layer === 3
      ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
      : layer === 1 && version !== 3
        ? Math.floor((72 * bitrate * 1000) / sampleRate) + padding
        : Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
  return frameLength > 0 && bytes.byteLength - offset >= frameLength;
}

function mp3Bitrate(version: number, layer: number, index: number): number | undefined {
  if (version === 3) {
    if (layer === 3) return mpeg1Layer1Bitrates[index];
    if (layer === 2) return mpeg1Layer2Bitrates[index];
    return mpeg1Layer3Bitrates[index];
  }
  return layer === 3 ? mpeg2Layer1Bitrates[index] : mpeg2Layer23Bitrates[index];
}

function hasCompleteWavPayload(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 12 ||
    !hasBytePrefix(bytes, [0x52, 0x49, 0x46, 0x46]) ||
    !hasBytePrefix(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return false;
  }
  const declaredSize = readUint32LE(bytes, 4);
  if (declaredSize === undefined) return false;
  const containerEnd = 8 + declaredSize;
  if (containerEnd > bytes.byteLength || containerEnd < 12) return false;

  let offset = 12;
  let hasFormat = false;
  let hasData = false;
  while (offset < containerEnd) {
    if (containerEnd - offset < 8) return false;
    const chunkSize = readUint32LE(bytes, offset + 4);
    if (chunkSize === undefined) return false;
    const chunkEnd = offset + 8 + chunkSize;
    if (chunkEnd > containerEnd) return false;
    if (hasBytePrefix(bytes, [0x66, 0x6d, 0x74, 0x20], offset)) hasFormat ||= chunkSize >= 16;
    if (hasBytePrefix(bytes, [0x64, 0x61, 0x74, 0x61], offset)) hasData = true;
    offset = chunkEnd + (chunkSize & 1);
  }
  return offset === containerEnd && hasFormat && hasData;
}

function readUint32LE(bytes: Uint8Array, offset: number): number | undefined {
  if (bytes.byteLength - offset < 4) return undefined;
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined)
    return undefined;
  return first + second * 0x100 + third * 0x1_0000 + fourth * 0x1_000000;
}

function hasCompleteOggOpusPayload(bytes: Uint8Array): boolean {
  let offset = 0;
  let hasOpusHead = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 27 || !hasBytePrefix(bytes, [0x4f, 0x67, 0x67, 0x53], offset))
      return false;
    if (bytes[offset + 4] !== 0) return false;
    const segmentCount = bytes[offset + 26];
    if (segmentCount === undefined || bytes.byteLength - offset < 27 + segmentCount) return false;
    let payloadSize = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      const segment = bytes[offset + 27 + index];
      if (segment === undefined) return false;
      payloadSize += segment;
    }
    const payloadOffset = offset + 27 + segmentCount;
    const pageEnd = payloadOffset + payloadSize;
    if (pageEnd > bytes.byteLength) return false;
    if (
      !hasOpusHead &&
      hasBytePrefix(bytes, [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], payloadOffset)
    ) {
      hasOpusHead = payloadSize >= 19;
    }
    offset = pageEnd;
  }
  return hasOpusHead;
}

function hasCompleteFlacPayload(bytes: Uint8Array): boolean {
  if (!hasBytePrefix(bytes, [0x66, 0x4c, 0x61, 0x43])) return false;
  let offset = 4;
  let firstBlock = true;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 4) return false;
    const header = bytes[offset];
    const firstLengthByte = bytes[offset + 1];
    const secondLengthByte = bytes[offset + 2];
    const thirdLengthByte = bytes[offset + 3];
    if (
      header === undefined ||
      firstLengthByte === undefined ||
      secondLengthByte === undefined ||
      thirdLengthByte === undefined
    ) {
      return false;
    }
    const length = (firstLengthByte << 16) | (secondLengthByte << 8) | thirdLengthByte;
    if (offset + 4 + length > bytes.byteLength) return false;
    if (firstBlock && ((header & 0x7f) !== 0 || length !== 34)) return false;
    firstBlock = false;
    offset += 4 + length;
    if ((header & 0x80) !== 0) return true;
  }
  return false;
}

function hasCompleteAacPayload(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 7) return false;
  const first = bytes[0];
  const second = bytes[1];
  const third = bytes[2];
  const fourth = bytes[3];
  const fifth = bytes[4];
  const sixth = bytes[5];
  if (
    first !== 0xff ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined ||
    sixth === undefined ||
    (second & 0xf6) !== 0xf0 ||
    ((third >> 2) & 0x0f) === 0x0f
  ) {
    return false;
  }
  const headerLength = (second & 0x01) === 0 ? 9 : 7;
  const frameLength = ((fourth & 0x03) << 11) | (fifth << 3) | ((sixth >> 5) & 0x07);
  return frameLength >= headerLength && bytes.byteLength >= frameLength;
}

function hasBytePrefix(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (offset < 0 || bytes.byteLength - offset < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}
