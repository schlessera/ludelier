import { describe, expect, it, vi } from "vitest";
import type { AudioState } from "@ludelier/engine";
import { AudioPlayer, type AudioSource, type HowlLike, type HowlOptions } from "../src";

class MockHowl implements HowlLike {
  readonly play = vi.fn();
  readonly stop = vi.fn();
  readonly unload = vi.fn();
  readonly volume = vi.fn();
  readonly mute = vi.fn();

  constructor(readonly options: HowlOptions) {}
}

const sources: Record<string, AudioSource> = {
  theme: { src: "/audio/theme.ogg", generated: false },
  battle: { src: "/audio/battle.ogg", generated: false },
  hit: { src: "/audio/hit.ogg", generated: false },
  chime: { src: "/audio/chime.ogg", generated: false },
  line: { src: "/audio/line.ogg", generated: false },
  generatedLine: { src: "/audio/generated-line.ogg", generated: true },
};

function audio(overrides: Partial<AudioState> = {}): AudioState {
  return { music: null, voice: null, events: [], nextEventSeq: 0, ...overrides };
}

function makePlayer(
  options: {
    active?: boolean;
    onGeneratedVoice?: (asset: string) => void;
    onVoiceStart?: (asset: string, source: AudioSource) => void;
    onVoiceEnd?: (asset: string, source: AudioSource) => void;
    onError?: (error: unknown) => void;
  } = {},
) {
  const howls: MockHowl[] = [];
  const player = new AudioPlayer({
    active: options.active,
    createHowl: (options) => {
      const howl = new MockHowl(options);
      howls.push(howl);
      return howl;
    },
    resolveSource: (asset) => sources[asset],
    onGeneratedVoice: options.onGeneratedVoice,
    onVoiceStart: options.onVoiceStart,
    onVoiceEnd: options.onVoiceEnd,
    onError: options.onError,
  });
  return { howls, player };
}

describe("AudioPlayer", () => {
  it("deduplicates each event sequence while playing same-step SFX independently", () => {
    const { howls, player } = makePlayer({ active: true });
    const state = audio({
      events: [
        { type: "play", seq: 0, channel: "sfx", asset: "hit", loop: false },
        { type: "play", seq: 1, channel: "sfx", asset: "hit", loop: false },
      ],
      nextEventSeq: 2,
    });

    player.reconcile(state);
    player.reconcile(state);

    expect(howls).toHaveLength(2);
    expect(howls.map((howl) => howl.options.src)).toEqual([["/audio/hit.ogg"], ["/audio/hit.ogg"]]);
    expect(howls.every((howl) => howl.play.mock.calls.length === 1)).toBe(true);
  });

  it("replaces persistent channels and stops every sound on the requested channel", () => {
    const { howls, player } = makePlayer({ active: true });
    player.reconcile(
      audio({
        music: { asset: "theme", loop: true, startedAtSeq: 0 },
        voice: { asset: "line", loop: false, startedAtSeq: 1 },
        events: [
          { type: "play", seq: 0, channel: "music", asset: "theme", loop: true },
          { type: "play", seq: 1, channel: "voice", asset: "line", loop: false },
          { type: "play", seq: 2, channel: "sfx", asset: "hit", loop: false },
        ],
        nextEventSeq: 3,
      }),
    );
    const [theme, line, hit] = howls;
    expect(theme).toBeDefined();
    expect(line).toBeDefined();
    expect(hit).toBeDefined();

    player.reconcile(
      audio({
        music: { asset: "battle", loop: true, startedAtSeq: 3 },
        voice: { asset: "line", loop: false, startedAtSeq: 1 },
        events: [{ type: "play", seq: 3, channel: "music", asset: "battle", loop: true }],
        nextEventSeq: 4,
      }),
    );
    const battle = howls[3];
    expect(theme?.stop).toHaveBeenCalledTimes(1);
    expect(theme?.unload).toHaveBeenCalledTimes(1);
    expect(battle?.options.src).toEqual(["/audio/battle.ogg"]);

    player.reconcile(
      audio({
        events: [
          { type: "stop", seq: 4, channel: "music" },
          { type: "stop", seq: 5, channel: "voice" },
          { type: "stop", seq: 6, channel: "sfx" },
        ],
        nextEventSeq: 7,
      }),
    );

    expect(battle?.stop).toHaveBeenCalledTimes(1);
    expect(line?.stop).toHaveBeenCalledTimes(1);
    expect(hit?.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for a user gesture, queues only looping music, and never unmutes historical SFX or voice", () => {
    const disclosed = vi.fn();
    const { howls, player } = makePlayer({ onGeneratedVoice: disclosed });
    const restored = audio({
      music: { asset: "theme", loop: true, startedAtSeq: 0 },
      voice: { asset: "generatedLine", loop: false, startedAtSeq: 2 },
      events: [
        { type: "play", seq: 0, channel: "music", asset: "theme", loop: true },
        { type: "play", seq: 1, channel: "sfx", asset: "hit", loop: false },
        { type: "play", seq: 2, channel: "voice", asset: "generatedLine", loop: false },
      ],
      nextEventSeq: 3,
    });

    player.initialize(restored);
    expect(howls).toHaveLength(0);

    player.activate();
    expect(howls.map((howl) => howl.options.src)).toEqual([["/audio/theme.ogg"]]);
    expect(disclosed).not.toHaveBeenCalled();

    // A later non-audio reducer update still must not revive the pre-gesture voice request.
    player.reconcile(audio({ music: restored.music, voice: restored.voice, nextEventSeq: 3 }));
    expect(howls).toHaveLength(1);

    player.reconcile(
      audio({
        music: restored.music,
        voice: { asset: "generatedLine", loop: false, startedAtSeq: 3 },
        events: [{ type: "play", seq: 3, channel: "voice", asset: "generatedLine", loop: false }],
        nextEventSeq: 4,
      }),
    );
    expect(howls).toHaveLength(2);
    howls[1]?.options.onplay?.();
    expect(disclosed).toHaveBeenCalledWith("generatedLine");

    player.reconcile(
      audio({
        music: restored.music,
        voice: { asset: "line", loop: false, startedAtSeq: 4 },
        events: [{ type: "play", seq: 4, channel: "voice", asset: "line", loop: false }],
        nextEventSeq: 5,
      }),
    );
    expect(disclosed).toHaveBeenCalledTimes(1);
  });

  it("suppresses a restored event batch but reconciles its desired music and voice when already active", () => {
    const disclosed = vi.fn();
    const { howls, player } = makePlayer({ active: true, onGeneratedVoice: disclosed });

    player.initialize(
      audio({
        music: { asset: "theme", loop: true, startedAtSeq: 0 },
        voice: { asset: "generatedLine", loop: false, startedAtSeq: 2 },
        events: [
          { type: "play", seq: 0, channel: "music", asset: "theme", loop: true },
          { type: "play", seq: 1, channel: "sfx", asset: "hit", loop: false },
          { type: "play", seq: 2, channel: "voice", asset: "generatedLine", loop: false },
        ],
        nextEventSeq: 3,
      }),
    );

    expect(howls.map((howl) => howl.options.src)).toEqual([
      ["/audio/theme.ogg"],
      ["/audio/generated-line.ogg"],
    ]);
    howls[1]?.options.onplay?.();
    expect(disclosed).toHaveBeenCalledTimes(1);
  });

  it("reconciles changed music and voice after an editor restart without replaying its reset SFX sequence", () => {
    const { howls, player } = makePlayer({ active: true });
    player.reconcile(
      audio({
        music: { asset: "theme", loop: true, startedAtSeq: 7 },
        events: [
          { type: "play", seq: 7, channel: "music", asset: "theme", loop: true },
          { type: "play", seq: 8, channel: "sfx", asset: "hit", loop: false },
        ],
        nextEventSeq: 9,
      }),
    );
    const [theme, oldSfx] = howls;

    player.initialize(
      audio({
        music: { asset: "battle", loop: true, startedAtSeq: 0 },
        voice: { asset: "line", loop: false, startedAtSeq: 1 },
        events: [
          { type: "play", seq: 0, channel: "sfx", asset: "chime", loop: false },
          { type: "play", seq: 1, channel: "voice", asset: "line", loop: false },
        ],
        nextEventSeq: 2,
      }),
    );

    expect(theme?.stop).toHaveBeenCalledTimes(1);
    expect(oldSfx?.stop).toHaveBeenCalledTimes(1);
    expect(howls.map((howl) => howl.options.src)).toEqual([
      ["/audio/theme.ogg"],
      ["/audio/hit.ogg"],
      ["/audio/battle.ogg"],
      ["/audio/line.ogg"],
    ]);
  });

  it("unloads a naturally ended one-shot music cue and never replays its unchanged desired request", () => {
    const { howls, player } = makePlayer({ active: true });
    const state = audio({
      music: { asset: "theme", loop: false, startedAtSeq: 0 },
      events: [{ type: "play", seq: 0, channel: "music", asset: "theme", loop: false }],
      nextEventSeq: 1,
    });

    player.reconcile(state);
    const oneShotMusic = howls[0];
    oneShotMusic?.options.onend?.();

    expect(oneShotMusic?.stop).toHaveBeenCalledTimes(1);
    expect(oneShotMusic?.unload).toHaveBeenCalledTimes(1);
    player.reconcile(audio({ music: state.music, nextEventSeq: 1 }));
    expect(howls).toHaveLength(1);
  });

  it("unloads failed music and SFX while reporting errors without retrying either", () => {
    const onError = vi.fn();
    const { howls, player } = makePlayer({ active: true, onError });
    const state = audio({
      music: { asset: "theme", loop: true, startedAtSeq: 0 },
      events: [
        { type: "play", seq: 0, channel: "music", asset: "theme", loop: true },
        { type: "play", seq: 1, channel: "sfx", asset: "hit", loop: false },
      ],
      nextEventSeq: 2,
    });

    player.reconcile(state);
    const [failedMusic, failedSfx] = howls;
    const musicFailure = new Error("music failed to load");
    failedMusic?.options.onloaderror?.(0, musicFailure);
    expect(failedMusic?.stop).toHaveBeenCalledTimes(1);
    expect(failedMusic?.unload).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(musicFailure);
    player.reconcile(audio({ music: state.music, nextEventSeq: 2 }));
    expect(howls).toHaveLength(2);

    const sfxFailure = new Error("SFX failed to play");
    failedSfx?.options.onplayerror?.(0, sfxFailure);
    expect(failedSfx?.stop).toHaveBeenCalledTimes(1);
    expect(failedSfx?.unload).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(sfxFailure);
    player.reconcile(audio({ music: state.music, nextEventSeq: 2 }));
    expect(howls).toHaveLength(2);
  });

  it("unloads a naturally ended generated voice and never replays its unchanged desired request", () => {
    const onVoiceEnd = vi.fn();
    const { howls, player } = makePlayer({ active: true, onVoiceEnd });
    const state = audio({
      voice: { asset: "generatedLine", loop: false, startedAtSeq: 0 },
      events: [{ type: "play", seq: 0, channel: "voice", asset: "generatedLine", loop: false }],
      nextEventSeq: 1,
    });

    player.reconcile(state);
    const generatedVoice = howls[0];
    generatedVoice?.options.onplay?.();
    generatedVoice?.options.onend?.();

    expect(generatedVoice?.stop).toHaveBeenCalledTimes(1);
    expect(generatedVoice?.unload).toHaveBeenCalledTimes(1);
    expect(onVoiceEnd).toHaveBeenCalledWith("generatedLine", sources.generatedLine);

    // The engine's desired voice remains until a later authored cue changes it. Do not restart
    // a voice that has already ended simply because rendering reconciles the same state again.
    player.reconcile(audio({ voice: state.voice, nextEventSeq: 1 }));
    expect(howls).toHaveLength(1);
  });

  it("clears generated-voice presentation when the cue stops or is replaced", () => {
    let generatedVoiceVisible = false;
    const onVoiceStart = vi.fn((_asset: string, source: AudioSource) => {
      generatedVoiceVisible = source.generated;
    });
    const onVoiceEnd = vi.fn(() => {
      generatedVoiceVisible = false;
    });
    const { howls, player } = makePlayer({ active: true, onVoiceStart, onVoiceEnd });

    player.reconcile(
      audio({
        voice: { asset: "generatedLine", loop: false, startedAtSeq: 0 },
        events: [{ type: "play", seq: 0, channel: "voice", asset: "generatedLine", loop: false }],
        nextEventSeq: 1,
      }),
    );
    const stoppedVoice = howls[0];
    stoppedVoice?.options.onplay?.();
    expect(generatedVoiceVisible).toBe(true);

    const stopped = audio({
      events: [{ type: "stop", seq: 1, channel: "voice" }],
      nextEventSeq: 2,
    });
    player.reconcile(stopped);
    expect(stoppedVoice?.stop).toHaveBeenCalledTimes(1);
    expect(stoppedVoice?.unload).toHaveBeenCalledTimes(1);
    expect(generatedVoiceVisible).toBe(false);
    player.reconcile(stopped);
    expect(howls).toHaveLength(1);

    player.reconcile(
      audio({
        voice: { asset: "generatedLine", loop: false, startedAtSeq: 2 },
        events: [{ type: "play", seq: 2, channel: "voice", asset: "generatedLine", loop: false }],
        nextEventSeq: 3,
      }),
    );
    const replacedVoice = howls[1];
    replacedVoice?.options.onplay?.();
    expect(generatedVoiceVisible).toBe(true);

    player.reconcile(
      audio({
        voice: { asset: "line", loop: false, startedAtSeq: 3 },
        events: [{ type: "play", seq: 3, channel: "voice", asset: "line", loop: false }],
        nextEventSeq: 4,
      }),
    );
    expect(replacedVoice?.stop).toHaveBeenCalledTimes(1);
    expect(replacedVoice?.unload).toHaveBeenCalledTimes(1);
    expect(generatedVoiceVisible).toBe(false);
    expect(onVoiceEnd).toHaveBeenCalledTimes(2);
  });

  it("announces generated voice only after confirmed playback and clears a load error", () => {
    let generatedVoiceVisible = false;
    const onVoiceStart = vi.fn((_asset: string, source: AudioSource) => {
      generatedVoiceVisible = source.generated;
    });
    const onVoiceEnd = vi.fn(() => {
      generatedVoiceVisible = false;
    });
    const onError = vi.fn();
    const { howls, player } = makePlayer({ active: true, onVoiceStart, onVoiceEnd, onError });
    const state = audio({
      voice: { asset: "generatedLine", loop: false, startedAtSeq: 0 },
      events: [{ type: "play", seq: 0, channel: "voice", asset: "generatedLine", loop: false }],
      nextEventSeq: 1,
    });

    player.reconcile(state);
    const failedVoice = howls[0];
    expect(onVoiceStart).not.toHaveBeenCalled();
    expect(generatedVoiceVisible).toBe(false);

    const failure = new Error("voice failed to load");
    failedVoice?.options.onloaderror?.(0, failure);
    expect(failedVoice?.stop).toHaveBeenCalledTimes(1);
    expect(failedVoice?.unload).toHaveBeenCalledTimes(1);
    expect(onVoiceEnd).toHaveBeenCalledWith("generatedLine", sources.generatedLine);
    expect(onError).toHaveBeenCalledWith(failure);
    player.reconcile(audio({ voice: state.voice, nextEventSeq: 1 }));
    expect(howls).toHaveLength(1);
  });

  it("ignores stale voice play errors while clearing the current failed voice", () => {
    let generatedVoiceVisible = false;
    const onVoiceStart = vi.fn((_asset: string, source: AudioSource) => {
      generatedVoiceVisible = source.generated;
    });
    const onVoiceEnd = vi.fn(() => {
      generatedVoiceVisible = false;
    });
    const onError = vi.fn();
    const { howls, player } = makePlayer({ active: true, onVoiceStart, onVoiceEnd, onError });

    player.reconcile(
      audio({
        voice: { asset: "generatedLine", loop: false, startedAtSeq: 0 },
        events: [{ type: "play", seq: 0, channel: "voice", asset: "generatedLine", loop: false }],
        nextEventSeq: 1,
      }),
    );
    const oldVoice = howls[0];
    oldVoice?.options.onplay?.();

    player.reconcile(
      audio({
        voice: { asset: "generatedLine", loop: false, startedAtSeq: 1 },
        events: [{ type: "play", seq: 1, channel: "voice", asset: "generatedLine", loop: false }],
        nextEventSeq: 2,
      }),
    );
    const currentVoice = howls[1];
    currentVoice?.options.onplay?.();
    expect(generatedVoiceVisible).toBe(true);

    const staleFailure = new Error("stale voice playback failed");
    oldVoice?.options.onplayerror?.(0, staleFailure);
    expect(currentVoice?.stop).not.toHaveBeenCalled();
    expect(generatedVoiceVisible).toBe(true);
    expect(onError).toHaveBeenCalledWith(staleFailure);

    const currentFailure = new Error("current voice playback failed");
    currentVoice?.options.onplayerror?.(0, currentFailure);
    expect(currentVoice?.stop).toHaveBeenCalledTimes(1);
    expect(currentVoice?.unload).toHaveBeenCalledTimes(1);
    expect(generatedVoiceVisible).toBe(false);
    expect(onError).toHaveBeenCalledWith(currentFailure);
    player.reconcile(
      audio({ voice: { asset: "generatedLine", loop: false, startedAtSeq: 1 }, nextEventSeq: 2 }),
    );
    expect(howls).toHaveLength(2);
  });

  it("disposes all owned Howls", () => {
    const { howls, player } = makePlayer({ active: true });
    player.reconcile(
      audio({
        music: { asset: "theme", loop: true, startedAtSeq: 0 },
        voice: { asset: "line", loop: false, startedAtSeq: 1 },
        events: [
          { type: "play", seq: 0, channel: "music", asset: "theme", loop: true },
          { type: "play", seq: 1, channel: "voice", asset: "line", loop: false },
          { type: "play", seq: 2, channel: "sfx", asset: "hit", loop: false },
        ],
        nextEventSeq: 3,
      }),
    );

    player.dispose();
    player.dispose();

    expect(
      howls.every((howl) => howl.stop.mock.calls.length === 1 && howl.unload.mock.calls.length === 1),
    ).toBe(true);
  });

  it("contains presentation failures without changing the audio state supplied by the simulation", () => {
    const failure = new Error("audio unavailable");
    const onError = vi.fn();
    const player = new AudioPlayer({
      active: true,
      createHowl: () => {
        throw failure;
      },
      resolveSource: (asset) => sources[asset],
      onError,
    });
    const state = audio({
      music: { asset: "theme", loop: true, startedAtSeq: 0 },
      events: [{ type: "play", seq: 0, channel: "music", asset: "theme", loop: true }],
      nextEventSeq: 1,
    });
    const expected = structuredClone(state);

    expect(() => player.reconcile(state)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(state).toEqual(expected);
  });
});
