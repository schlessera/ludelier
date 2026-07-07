import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders `children` into a separate top-level browser window (for multi-monitor use).
 *
 * React keeps running in the *opener's* realm — only the rendered DOM nodes live in the
 * child window — so the editor session, Pixi's module singletons, and live edit updates
 * are all shared with the main app; the popped-out preview stays in sync with edits.
 *
 * The opener's stylesheets are cloned into the child so styling carries over, and closing
 * the child window (or unmounting this component) calls `onClose` so the app can re-dock.
 */
export function NewWindowPortal({
  title,
  features = "width=960,height=680",
  onClose,
  children,
}: {
  title: string;
  features?: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element | null {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  // Open once. The empty window name ("") always spawns a fresh window, so StrictMode's
  // mount→cleanup→mount probe closes the first before opening the second (net: one window).
  // biome-ignore lint/correctness/useExhaustiveDependencies: open-once by design — re-running would spawn a second window
  useEffect(() => {
    const win = window.open("", "", features);
    if (!win) {
      // Blocked by a popup blocker — fall back to the docked overlay.
      onClose();
      return;
    }
    win.document.title = title;
    // Carry the opener's styles over: <style> tags (Vite dev) and <link rel=stylesheet>
    // (production build) both clone cleanly.
    for (const node of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
      win.document.head.appendChild(node.cloneNode(true));
    }
    win.document.body.style.margin = "0";
    win.document.body.style.background = "#0e1117";
    const host = win.document.createElement("div");
    host.className = "popout-host";
    win.document.body.appendChild(host);
    setContainer(host);

    const handleUnload = () => onClose();
    win.addEventListener("beforeunload", handleUnload);
    return () => {
      // Remove the listener before we close so our own teardown doesn't re-fire onClose.
      win.removeEventListener("beforeunload", handleUnload);
      win.close();
    };
  }, []);

  return container ? createPortal(children, container) : null;
}
