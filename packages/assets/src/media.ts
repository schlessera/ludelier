import type { AssetMediaKind, AssetOutputFormat } from "./types";

/**
 * Canonical media identity for every portable output format. Provider adapters and hosts must use
 * this mapping rather than maintaining format-specific MIME or filename extension tables.
 */
export interface AssetOutputMedia {
  readonly kind: AssetMediaKind;
  readonly mimeType: string;
  readonly extension: AssetOutputFormat;
}

const outputMedia = {
  png: { kind: "image", mimeType: "image/png", extension: "png" },
  jpeg: { kind: "image", mimeType: "image/jpeg", extension: "jpeg" },
  webp: { kind: "image", mimeType: "image/webp", extension: "webp" },
  mp3: { kind: "audio", mimeType: "audio/mpeg", extension: "mp3" },
  wav: { kind: "audio", mimeType: "audio/wav", extension: "wav" },
  // OpenAI TTS returns Opus in an Ogg container, not bare RFC 7587 `audio/opus` frames.
  opus: { kind: "audio", mimeType: "audio/ogg", extension: "opus" },
  aac: { kind: "audio", mimeType: "audio/aac", extension: "aac" },
  flac: { kind: "audio", mimeType: "audio/flac", extension: "flac" },
  // OpenAI's raw 24 kHz, 16-bit LE stream is adapter-validated as `audio/pcm`.
  pcm: { kind: "audio", mimeType: "audio/pcm", extension: "pcm" },
} as const satisfies Record<AssetOutputFormat, AssetOutputMedia>;

/** Portable output-format media source of truth. */
export const ASSET_OUTPUT_MEDIA: Readonly<Record<AssetOutputFormat, AssetOutputMedia>> =
  Object.freeze(outputMedia);

/** Returns canonical portable media metadata for a declared output format. */
export function assetOutputMediaForFormat(format: string): AssetOutputMedia | undefined {
  return Object.hasOwn(ASSET_OUTPUT_MEDIA, format)
    ? ASSET_OUTPUT_MEDIA[format as AssetOutputFormat]
    : undefined;
}
