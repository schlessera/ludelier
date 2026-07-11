import type { AudioEvent, AudioState, DesiredAudio } from "@ludelier/engine";

/** The browser-visible portion of an audio asset. Generation provenance stays out of this adapter. */
export interface AudioSource {
  src: string;
  generated: boolean;
}

/** The subset of Howler options used by the presentation adapter. */
export interface HowlOptions {
  src: string[];
  loop: boolean;
  volume: number;
  mute: boolean;
  onplay?: () => void;
  onend?: () => void;
  onloaderror?: (soundId: number, error: unknown) => void;
  onplayerror?: (soundId: number, error: unknown) => void;
}

/** A Howler-compatible instance. Kept narrow so tests and hosts can inject their own factory. */
export interface HowlLike {
  play(): unknown;
  stop(): unknown;
  unload(): unknown;
  volume(volume: number): unknown;
  mute(muted: boolean): unknown;
}

export type HowlFactory = (options: HowlOptions) => HowlLike;

export interface AudioPlayerOptions {
  createHowl: HowlFactory;
  resolveSource(asset: string): AudioSource | undefined;
  /** Browser hosts start inactive and must call activate() from a trusted user gesture. */
  active?: boolean;
  muted?: boolean;
  volume?: number;
  /** Called whenever a voice cue starts, so hosts can expose asset-level disclosure. */
  onVoiceStart?(asset: string, source: AudioSource): void;
  /** Called when an active voice ends naturally or is stopped/replaced, so hosts can clear disclosure. */
  onVoiceEnd?(asset: string, source: AudioSource): void;
  /** Called only when a generated asset is actually started on the voice channel. */
  onGeneratedVoice?(asset: string): void;
  /** Audio is optional presentation; failures are reported but never escape into simulation. */
  onError?(error: unknown): void;
}

type PersistentChannel = "music" | "voice";

interface ActiveSound {
  asset: string;
  loop: boolean;
  source: AudioSource;
  /** Persistent channels retain the exact reducer request that started them. */
  desired?: DesiredAudio;
  howl: HowlLike;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Browser presentation adapter for the engine's logical audio output.
 *
 * `reconcile()` consumes each event sequence at most once. `initialize()` establishes a
 * restored/rebuilt baseline: before activation, it queues only looping music and suppresses
 * historical SFX/voice; after activation it reconciles changed desired music/voice without
 * replaying the old event batch.
 */
export class AudioPlayer {
  private readonly createHowl: HowlFactory;
  private readonly resolveSource: AudioPlayerOptions["resolveSource"];
  private readonly onGeneratedVoice?: AudioPlayerOptions["onGeneratedVoice"];
  private readonly onVoiceStart?: AudioPlayerOptions["onVoiceStart"];
  private readonly onVoiceEnd?: AudioPlayerOptions["onVoiceEnd"];
  private readonly onError?: AudioPlayerOptions["onError"];
  private music: ActiveSound | null = null;
  private voice: ActiveSound | null = null;
  private readonly sfx = new Set<ActiveSound>();
  /** Next engine event sequence not yet consumed. */
  private nextEventSeq = 0;
  private queuedMusic: DesiredAudio | null = null;
  private suppressedMusic: DesiredAudio | null = null;
  private suppressedVoice: DesiredAudio | null = null;
  private active: boolean;
  private muted: boolean;
  private volume: number;
  private disposed = false;

  constructor(options: AudioPlayerOptions) {
    this.createHowl = options.createHowl;
    this.resolveSource = options.resolveSource;
    this.onGeneratedVoice = options.onGeneratedVoice;
    this.onVoiceStart = options.onVoiceStart;
    this.onVoiceEnd = options.onVoiceEnd;
    this.onError = options.onError;
    this.active = options.active ?? false;
    this.muted = options.muted ?? true;
    this.volume = clampVolume(options.volume ?? 0.8);
  }

  /**
   * Establish a restored GameState or replacement Simulation baseline. An inactive host queues
   * only its current looping music; its historical SFX/voice will never be unmuted later.
   */
  initialize(audio: AudioState): void {
    if (this.disposed) return;
    this.stopSfx();
    this.nextEventSeq = audio.nextEventSeq;
    if (!this.active) {
      this.queuedMusic = audio.music?.loop ? audio.music : null;
      this.suppressedMusic = audio.music?.loop ? null : audio.music;
      this.suppressedVoice = audio.voice;
      return;
    }
    this.reconcileDesired(audio);
  }

  /** Consume newly-emitted reducer events, then ensure persistent channels match the state. */
  reconcile(audio: AudioState): void {
    if (this.disposed) return;

    // A rebuilt Simulation may reset its counter. Treat all events in that replacement state as
    // historical until the host explicitly drives a later reducer update.
    if (audio.nextEventSeq < this.nextEventSeq) {
      this.initialize(audio);
      return;
    }

    if (!this.active) {
      this.nextEventSeq = Math.max(this.nextEventSeq, audio.nextEventSeq);
      this.queuedMusic = audio.music?.loop ? audio.music : null;
      this.suppressedMusic = audio.music?.loop ? null : audio.music;
      this.suppressedVoice = audio.voice;
      return;
    }

    for (const event of audio.events) {
      if (event.seq >= this.nextEventSeq) this.consume(event);
    }
    // `events` is a current reducer batch, not a durable queue. Missing batches must never be
    // replayed from a stale state, so advancing the watermark is deliberate.
    this.nextEventSeq = Math.max(this.nextEventSeq, audio.nextEventSeq);
    this.reconcileDesired(audio);
  }

  /** Start audio after a trusted user gesture, synchronizing only the queued looping music. */
  activate(): void {
    if (this.disposed || this.active) return;
    this.active = true;
    this.replacePersistent("music", this.queuedMusic);
    this.queuedMusic = null;
  }

  isMuted(): boolean {
    return this.muted;
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(muted: boolean): void {
    if (this.disposed || this.muted === muted) return;
    this.muted = muted;
    for (const sound of this.allSounds()) this.call(() => sound.howl.mute(muted));
  }

  setVolume(volume: number): void {
    if (this.disposed) return;
    this.volume = clampVolume(volume);
    for (const sound of this.allSounds()) this.call(() => sound.howl.volume(this.volume));
  }

  /** Stop and unload every owned Howl. Hosts must call this when their playback host unmounts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePersistent("music", this.music);
    this.releasePersistent("voice", this.voice);
    for (const sound of this.sfx) this.stopSound(sound);
    this.sfx.clear();
  }

  private consume(event: AudioEvent): void {
    switch (event.type) {
      case "play":
        if (event.channel === "sfx") this.playSfx(event);
        else {
          if (event.channel === "music") this.suppressedMusic = null;
          else this.suppressedVoice = null;
          this.replacePersistent(event.channel, {
            asset: event.asset,
            loop: event.loop,
            startedAtSeq: event.seq,
          });
        }
        return;
      case "stop":
        if (event.channel === "sfx") this.stopSfx();
        else {
          if (event.channel === "music") this.suppressedMusic = null;
          else this.suppressedVoice = null;
          this.replacePersistent(event.channel, null);
        }
    }
  }

  private reconcileDesired(audio: AudioState): void {
    this.reconcilePersistent("music", audio.music);
    this.reconcilePersistent("voice", audio.voice);
  }

  private reconcilePersistent(channel: PersistentChannel, desired: DesiredAudio | null): void {
    const suppressed = channel === "music" ? this.suppressedMusic : this.suppressedVoice;
    if (desired && suppressed && this.sameDesired(desired, suppressed)) return;
    if (channel === "music") this.suppressedMusic = null;
    else this.suppressedVoice = null;
    this.replacePersistent(channel, desired);
  }

  private replacePersistent(channel: PersistentChannel, desired: DesiredAudio | null): void {
    const current = channel === "music" ? this.music : this.voice;
    if (desired && this.sameDesired(current?.desired, desired)) return;

    if (current) this.releasePersistent(channel, current);
    if (!desired) return;

    const sound = this.createSound(desired.asset, desired.loop, channel, false, desired);
    if (!sound) {
      if (channel === "music") this.suppressedMusic = desired;
      else this.suppressedVoice = desired;
      return;
    }
    if (channel === "music") this.music = sound;
    else this.voice = sound;
  }

  private sameDesired(left: DesiredAudio | undefined, right: DesiredAudio): boolean {
    const sameAsset = left?.asset === right.asset;
    const sameLoop = left?.loop === right.loop;
    const sameStart = left?.startedAtSeq === right.startedAtSeq;
    return sameAsset && sameLoop && sameStart;
  }

  private playSfx(event: Extract<AudioEvent, { type: "play" }>): void {
    const sound = this.createSound(event.asset, event.loop, "sfx", true);
    if (sound) this.sfx.add(sound);
  }

  private createSound(
    asset: string,
    loop: boolean,
    channel: "music" | "voice" | "sfx",
    transient = false,
    desired?: DesiredAudio,
  ): ActiveSound | null {
    let active: ActiveSound | null = null;
    try {
      const source = this.resolveSource(asset);
      if (!source) return null;
      const howl = this.createHowl({
        src: [source.src],
        loop,
        volume: this.volume,
        mute: this.muted,
        onplay:
          channel === "voice"
            ? () => {
                if (active && this.voice === active) {
                  this.call(() => this.onVoiceStart?.(asset, source));
                  if (source.generated) this.call(() => this.onGeneratedVoice?.(asset));
                }
              }
            : undefined,
        onend:
          channel === "music" && !loop
            ? () => {
                if (active) this.releasePersistent("music", active);
              }
            : channel === "voice" && !loop
              ? () => {
                  if (active) this.releaseVoice(active);
                }
              : transient
                ? () => {
                    if (active) this.releaseSfx(active);
                  }
                : undefined,
        onloaderror: (_soundId, error) => this.handleSoundError(channel, active, error),
        onplayerror: (_soundId, error) => this.handleSoundError(channel, active, error),
      });
      active = { asset, loop, source, desired, howl };
      howl.play();
      return active;
    } catch (error) {
      if (active) this.stopSound(active);
      this.onError?.(error);
      return null;
    }
  }

  private releaseSfx(sound: ActiveSound): void {
    if (!this.sfx.delete(sound)) return;
    this.stopSound(sound);
  }

  private releasePersistent(channel: PersistentChannel, sound: ActiveSound | null): void {
    if (!sound) return;
    if (channel === "voice") {
      this.releaseVoice(sound);
      return;
    }
    if (this.music !== sound) return;
    this.music = null;
    if (sound.desired) this.suppressedMusic = sound.desired;
    this.stopSound(sound);
  }

  private releaseVoice(sound: ActiveSound): void {
    if (this.voice !== sound) return;
    this.voice = null;
    if (sound.desired) this.suppressedVoice = sound.desired;
    this.stopSound(sound);
    this.call(() => this.onVoiceEnd?.(sound.asset, sound.source));
  }

  private handleSoundError(
    channel: "music" | "voice" | "sfx",
    sound: ActiveSound | null,
    error: unknown,
  ): void {
    if (sound) {
      if (channel === "sfx") this.releaseSfx(sound);
      else this.releasePersistent(channel, sound);
    }
    this.onError?.(error);
  }

  private stopSfx(): void {
    for (const sound of this.sfx) this.stopSound(sound);
    this.sfx.clear();
  }

  private stopSound(sound: ActiveSound | null): void {
    if (!sound) return;
    this.call(() => sound.howl.stop());
    this.call(() => sound.howl.unload());
  }

  private *allSounds(): Iterable<ActiveSound> {
    if (this.music) yield this.music;
    if (this.voice) yield this.voice;
    yield* this.sfx;
  }

  private call(operation: () => unknown): void {
    try {
      operation();
    } catch (error) {
      this.onError?.(error);
    }
  }
}
