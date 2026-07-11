// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Asset, Story } from "@ludelier/schema";
import { EditorSession } from "@ludelier/editor-core";
import { SAVE_VERSION, isCurrentSave } from "../../runtime-web/src/save";

const mocks = vi.hoisted(() => ({
  howls: [] as Array<{ options: { onplay?: () => void; onend?: () => void } }>,
  renderedStates: [] as Array<{ pending: { text?: string } }>,
  preload: vi.fn(),
}));

vi.mock("howler", () => ({
  Howl: class {
    play = vi.fn();
    stop = vi.fn();
    unload = vi.fn();
    volume = vi.fn();
    mute = vi.fn();

    constructor(readonly options: { onplay?: () => void; onend?: () => void }) {
      mocks.howls.push(this);
    }
  },
}));

vi.mock("@ludelier/renderer-pixi", () => ({
  PixiRenderer: class {
    constructor(
      private readonly options: {
        onAdvance(): void;
        onChoose(index: number): void;
      },
    ) {}

    async mount(host: HTMLElement): Promise<void> {
      const advance = document.createElement("button");
      advance.type = "button";
      advance.setAttribute("aria-label", "Advance preview");
      advance.addEventListener("click", () => this.options.onAdvance());
      host.append(advance);
    }

    destroy(): void {}
    setCharacters(): void {}
    render(state: { pending: { text?: string } }): void {
      mocks.renderedStates.push(state);
    }
    async preload(assets: unknown): Promise<void> {
      await mocks.preload(assets);
    }
  },
}));

import { ensureAssets, imageAssets, PlayCanvas, resolveAudioSource } from "../src/PlayCanvas";

afterEach(() => {
  cleanup();
  mocks.howls.length = 0;
  mocks.renderedStates.length = 0;
  mocks.preload.mockReset();
  mocks.preload.mockResolvedValue(undefined);
});

const assets: Asset[] = [
  { id: "backdrop", src: "/images/backdrop.webp", kind: "image", generated: false },
  { id: "theme", src: "/audio/theme.ogg", kind: "audio", generated: false },
  { id: "line", src: "/audio/line.ogg", kind: "audio", generated: true },
];

const story: Story = {
  meta: { id: "preview", title: "Preview", start: "start", seed: 1 },
  characters: [{ id: "narrator", name: "Narrator" }],
  assets: [],
  nodes: [{ id: "start", body: [{ op: "say", who: "narrator", text: "Ready." }, { op: "end" }] }],
};

describe("PlayCanvas audio presentation", () => {
  it("passes only images to Pixi preload while resolving audio URLs separately", async () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    await ensureAssets({ preload }, imageAssets(assets));

    expect(preload).toHaveBeenCalledWith([
      { id: "backdrop", src: "/images/backdrop.webp", kind: "image", generated: false },
    ]);
    expect(resolveAudioSource(assets, "theme")).toEqual({ src: "/audio/theme.ogg", generated: false });
    expect(resolveAudioSource(assets, "line")).toEqual({ src: "/audio/line.ogg", generated: true });
    expect(resolveAudioSource(assets, "backdrop")).toBeUndefined();
  });

  it("renders accessible muted audio controls in the preview", async () => {
    render(<PlayCanvas session={new EditorSession(story)} version={0} />);

    const mute = await screen.findByRole("button", { name: "Unmute audio" });
    const volume = screen.getByRole("slider", { name: "Audio volume" }) as HTMLInputElement;
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(volume.value).toBe("0.8");
  });

  it("shows and clears the generated-voice disclosure around natural playback end", async () => {
    const voiceStory: Story = {
      ...story,
      assets,
      nodes: [
        {
          id: "start",
          body: [
            { op: "say", who: "narrator", text: "Ready." },
            { op: "sound", channel: "voice", asset: "line" },
            { op: "say", who: "narrator", text: "Spoken." },
            { op: "end" },
          ],
        },
      ],
    };
    render(<PlayCanvas session={new EditorSession(voiceStory)} version={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Unmute audio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Advance preview" }));
    const generatedVoice = mocks.howls[0];
    act(() => generatedVoice?.options.onplay?.());
    expect((await screen.findByRole("status")).textContent).toBe("Generated voice audio is playing.");

    act(() => generatedVoice?.options.onend?.());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the latest play-from-here state when a shared preload completes later", async () => {
    let resolvePreload!: () => void;
    const preload = new Promise<void>((resolve) => {
      resolvePreload = resolve;
    });
    mocks.preload.mockImplementationOnce(() => preload);
    const raceStory: Story = {
      meta: { id: "preview-race", title: "Preview race", start: "first", seed: 1 },
      characters: [{ id: "narrator", name: "Narrator" }],
      assets: [{ id: "race-background", src: "/images/race.webp", kind: "image", generated: false }],
      nodes: [
        { id: "first", body: [{ op: "say", who: "narrator", text: "First." }, { op: "end" }] },
        { id: "second", body: [{ op: "say", who: "narrator", text: "Second." }, { op: "end" }] },
      ],
    };
    const session = new EditorSession(raceStory);
    const view = render(<PlayCanvas session={session} version={0} startNode="first" />);

    await waitFor(() => expect(mocks.preload).toHaveBeenCalledTimes(1));
    view.rerender(<PlayCanvas session={session} version={0} startNode="second" />);
    expect(mocks.preload).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePreload();
      await preload;
    });
    await waitFor(() => {
      const state = mocks.renderedStates[mocks.renderedStates.length - 1];
      expect(state?.pending.text).toBe("Second.");
    });
  });

  it("keeps a newer same-id source error when an older preload resolves afterward", async () => {
    let resolveOld!: () => void;
    const oldPreload = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    mocks.preload.mockImplementationOnce(() => oldPreload);
    const oldStory: Story = {
      meta: { id: "preview-source-old", title: "Preview source old", start: "start", seed: 1 },
      characters: [{ id: "narrator", name: "Narrator" }],
      assets: [{ id: "same-id-race", src: "/images/old.webp", kind: "image", generated: false }],
      nodes: [{ id: "start", body: [{ op: "say", who: "narrator", text: "Old." }, { op: "end" }] }],
    };
    const currentStory: Story = {
      ...oldStory,
      meta: { ...oldStory.meta, id: "preview-source-current", title: "Preview source current" },
      assets: [{ id: "same-id-race", src: "/images/current.webp", kind: "image", generated: false }],
    };
    const view = render(<PlayCanvas session={new EditorSession(oldStory)} version={0} />);

    await waitFor(() => expect(mocks.preload).toHaveBeenCalledTimes(1));
    view.rerender(<PlayCanvas session={new EditorSession(currentStory)} version={1} />);
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain('asset "same-id-race" is already loading from "/images/old.webp"');
    expect(mocks.preload).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOld();
      await oldPreload;
    });
    expect(screen.getByRole("alert").textContent).toContain(
      'asset "same-id-race" is already loading from "/images/old.webp"',
    );
    expect(mocks.renderedStates).toHaveLength(0);
  });
  it("rejects a legacy Dexie save version", () => {
    expect(isCurrentSave({ storyHash: "story", saveVersion: SAVE_VERSION - 1 }, "story")).toBe(false);
    expect(isCurrentSave({ storyHash: "story", saveVersion: SAVE_VERSION }, "story")).toBe(true);
  });
});
