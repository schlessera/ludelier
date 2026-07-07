import { useEffect, useState } from "react";
import type { EditorSession } from "@ludelier/editor-core";
import { PlayCanvas } from "../PlayCanvas";
import { NewWindowPortal } from "./NewWindowPortal";

/**
 * On-demand play preview. Hidden until the author asks to play, then shown as a modal
 * overlay over the editor — reclaiming the center space the graph now owns. It can also
 * pop out into a separate window for multi-monitor use (a second screen for the running
 * game while the graph stays on the first).
 *
 * Moving the canvas between the docked modal and the popped-out window remounts it (a
 * different DOM parent / document), which is what we want: a fresh renderer in the target
 * document, replaying the current story from the same selected start.
 */
export function PlayOverlay({
  session,
  version,
  startNode,
  playKey,
  onClose,
}: {
  session: EditorSession;
  version: number;
  startNode?: string;
  playKey: number;
  onClose: () => void;
}): JSX.Element {
  const [poppedOut, setPoppedOut] = useState(false);

  // Escape closes the preview — the keyboard equivalent of the backdrop click and the
  // explicit Close button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const from = startNode ? `from ${startNode} · fresh state` : "from start";
  const canvas = (
    <PlayCanvas key={`play-${playKey}`} session={session} version={version} startNode={startNode} bare />
  );

  if (poppedOut) {
    return (
      <>
        <div className="play-overlay">
          <div className="play-modal popped">
            <div className="play-modal-head">
              <strong>Play preview</strong>
              <span className="muted">· running in a separate window</span>
              <div className="spacer" />
              <button type="button" onClick={() => setPoppedOut(false)}>
                ⧉ Return here
              </button>
              <button type="button" className="danger" onClick={onClose}>
                ✕ Close
              </button>
            </div>
            <p className="muted popout-note">
              The preview opened in its own window — drag it to another monitor and keep editing here. It
              stays in sync with your edits.
            </p>
          </div>
        </div>
        <NewWindowPortal title="Ludelier · Play preview" onClose={() => setPoppedOut(false)}>
          <div className="popout-play">{canvas}</div>
        </NewWindowPortal>
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-on-backdrop is a mouse-only convenience; the keyboard path is Escape (above) and the explicit Close button
    <div
      className="play-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Play preview"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="play-modal">
        <div className="play-modal-head">
          <strong>Play preview</strong>
          <span className="muted">· {from}</span>
          <div className="spacer" />
          <button type="button" onClick={() => setPoppedOut(true)} title="Open in a separate window">
            ⧉ Pop out
          </button>
          <button type="button" className="danger" onClick={onClose}>
            ✕ Close
          </button>
        </div>
        {canvas}
      </div>
    </div>
  );
}
