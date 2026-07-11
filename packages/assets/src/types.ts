/** Identifies a configured asset provider. Provider ids are host-defined strings. */
export type AssetProviderId = string;

/** Identifies a provider model target. */
export type AssetModelId = string;

export type AssetMediaKind = "image" | "audio";

export type ImageAssetRole = "background" | "sprite";
export type AudioAssetRole = "music" | "sfx" | "voice";
export type AssetRole = ImageAssetRole | AudioAssetRole;

export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type AudioOutputFormat = "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
export type AssetOutputFormat = ImageOutputFormat | AudioOutputFormat;

export type ImageBackground = "opaque" | "transparent";

/** A pixel dimension requested from or advertised by an image model. */
export interface ImageSize {
  width: number;
  height: number;
}

/** Provider-wide modalities are deliberately coarse; target capabilities decide compatibility. */
export interface AssetProviderCapabilities {
  readonly kinds: readonly AssetMediaKind[];
}

/** Model-level capability profile for an image target. */
export interface ImageTargetCapabilities {
  readonly outputFormats: readonly ImageOutputFormat[];
  readonly backgrounds: readonly ImageBackground[];
  /** Omit only when callers must not request a size for this target. */
  readonly sizes?: readonly ImageSize[];
  readonly supportsSeed?: boolean;
  readonly qualities?: readonly string[];
}

/** Model-level capability profile for an audio target. */
export interface AudioTargetCapabilities {
  readonly outputFormats: readonly AudioOutputFormat[];
  /** Voices explicitly offered by this target. */
  readonly voices?: readonly string[];
  /** Inclusive speed range. Omit when this target does not support a speed override. */
  readonly speed?: { readonly min: number; readonly max: number };
}

export interface ImageDefaultParameters {
  readonly background?: ImageBackground;
  readonly size?: ImageSize;
  readonly quality?: string;
}

export interface AudioDefaultParameters {
  readonly voice?: string;
  readonly speed?: number;
}

/** A single image model target. Capability is intentionally attached here, not to the provider. */
export interface ImageModelTarget {
  readonly providerId: AssetProviderId;
  readonly modelId: AssetModelId;
  readonly kind: "image";
  /** Non-secret endpoint/base-url identity used in request cache identity. */
  readonly endpoint: string;
  readonly capabilities: ImageTargetCapabilities;
  readonly defaultParameters?: ImageDefaultParameters;
  /** Deprecated targets are never automatic defaults, but may be explicitly selected. */
  readonly deprecated?: boolean;
}

/** A single audio model target. Capability is intentionally attached here, not to the provider. */
export interface AudioModelTarget {
  readonly providerId: AssetProviderId;
  readonly modelId: AssetModelId;
  readonly kind: "audio";
  /** Non-secret endpoint/base-url identity used in request cache identity. */
  readonly endpoint: string;
  readonly capabilities: AudioTargetCapabilities;
  readonly defaultParameters?: AudioDefaultParameters;
  /** Deprecated targets are never automatic defaults, but may be explicitly selected. */
  readonly deprecated?: boolean;
}

export type AssetModelTarget = ImageModelTarget | AudioModelTarget;

export interface ImageGenerationRequest {
  readonly kind: "image";
  /** Preserved byte-for-byte in request hashing; never normalize or trim it. */
  readonly prompt: string;
  readonly role: ImageAssetRole;
  readonly outputFormat: ImageOutputFormat;
  /** Restricts resolution to this provider when supplied. */
  readonly providerId?: AssetProviderId;
  /** Restricts resolution to this model when supplied. */
  readonly modelId?: AssetModelId;
  readonly background?: ImageBackground;
  readonly size?: ImageSize;
  readonly seed?: number;
  readonly quality?: string;
}

export interface AudioGenerationRequest {
  readonly kind: "audio";
  /** TTS text or generation prompt, preserved exactly in request hashing. */
  readonly prompt: string;
  readonly role: AudioAssetRole;
  readonly outputFormat: AudioOutputFormat;
  /** Restricts resolution to this provider when supplied. */
  readonly providerId?: AssetProviderId;
  /** Restricts resolution to this model when supplied. */
  readonly modelId?: AssetModelId;
  readonly voice?: string;
  readonly speed?: number;
}

export type AssetGenerationRequest = ImageGenerationRequest | AudioGenerationRequest;

/** The selected target without deprecated/default selection policy fields. */
export interface ResolvedImageTarget {
  readonly providerId: AssetProviderId;
  readonly modelId: AssetModelId;
  readonly kind: "image";
  readonly endpoint: string;
  readonly capabilities: ImageTargetCapabilities;
}

/** The selected target without deprecated/default selection policy fields. */
export interface ResolvedAudioTarget {
  readonly providerId: AssetProviderId;
  readonly modelId: AssetModelId;
  readonly kind: "audio";
  readonly endpoint: string;
  readonly capabilities: AudioTargetCapabilities;
}

export type ResolvedAssetTarget = ResolvedImageTarget | ResolvedAudioTarget;

export interface ResolvedImageGenerationRequest {
  readonly target: ResolvedImageTarget;
  readonly kind: "image";
  readonly prompt: string;
  readonly role: ImageAssetRole;
  readonly outputFormat: ImageOutputFormat;
  /** All target defaults are materialized here before a provider can make a request. */
  readonly parameters: {
    readonly background: ImageBackground;
    readonly size?: ImageSize;
    readonly seed?: number;
    readonly quality?: string;
  };
}

export interface ResolvedAudioGenerationRequest {
  readonly target: ResolvedAudioTarget;
  readonly kind: "audio";
  readonly prompt: string;
  readonly role: AudioAssetRole;
  readonly outputFormat: AudioOutputFormat;
  /** All target defaults are materialized here before a provider can make a request. */
  readonly parameters: {
    readonly voice?: string;
    readonly speed?: number;
  };
}

export type ResolvedAssetGenerationRequest = ResolvedImageGenerationRequest | ResolvedAudioGenerationRequest;

/** Cost data is explicitly labelled so reported and estimated amounts cannot be confused. */
export type AssetCost =
  | { readonly kind: "unavailable" }
  | { readonly kind: "reported"; readonly amount: number; readonly currency: string }
  | {
      readonly kind: "estimated";
      readonly amount: number;
      readonly currency: string;
      readonly basis: string;
    };

export interface AssetUsage {
  readonly inputUnits?: number;
  readonly outputUnits?: number;
}

/** Billing data is optional because providers may not disclose it per generation. */
export interface AssetBilling {
  readonly chargeStatus: "not-charged" | "charged" | "unknown";
  readonly cost?: AssetCost;
}

/** Metadata returned by a provider without any raw response body or credentials. */
export interface AssetGenerationMetadata {
  readonly mimeType: string;
  /** Extension without a leading dot, for example `webp`. */
  readonly extension: string;
  /** ISO-8601 creation time supplied or assigned by the host. */
  readonly createdAt: string;
  /**
   * Set only by an adapter that compared a received provider Content-Type against the canonical
   * media identity. It is required for unframed raw PCM, which has no byte signature.
   */
  readonly contentTypeValidated?: true;
  readonly usage?: AssetUsage;
  readonly billing?: AssetBilling;
}

/** A successfully generated media payload plus safe metadata. */
export interface AssetGenerationResult extends AssetGenerationMetadata {
  readonly bytes: Uint8Array;
}

/** JSON-compatible values permitted in canonical post-processing parameters. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** A named, versioned host recipe that affects final content and cache identity. */
export interface PostProcessingRecipe {
  readonly recipe: string;
  readonly version: number;
  readonly parameters?: CanonicalValue;
}

export interface AssetGenerationOptions {
  readonly signal?: AbortSignal;
}

/**
 * Portable provider seam. Implementations receive a locally validated resolved request;
 * they may use injected fetch, but this core neither stores keys nor performs HTTP itself.
 */
export interface AssetProvider {
  readonly id: AssetProviderId;
  readonly capabilities: AssetProviderCapabilities;
  readonly targets: readonly AssetModelTarget[];
  generate(
    request: ResolvedAssetGenerationRequest,
    options?: AssetGenerationOptions,
  ): Promise<AssetGenerationResult>;
}
