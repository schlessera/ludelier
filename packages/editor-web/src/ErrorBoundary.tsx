import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catch for a render/lifecycle throw anywhere in the editor tree — without
 * it, one bad snapshot (e.g. a story the graph analysis chokes on) white-screens the
 * whole app and takes the user's un-exported edit log with it. The story itself is never
 * at risk (edits are validated), so a reload is always safe.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("editor crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="boundary" role="alert">
        <h1>The editor hit an unexpected error</h1>
        <p className="err">{this.state.error.message}</p>
        <p className="muted">
          Your story is not lost — edits only ever land validated. Reload to continue; if this repeats, export
          the edit log after reloading and file an issue with it.
        </p>
        <button type="button" onClick={() => location.reload()}>
          Reload the editor
        </button>
      </div>
    );
  }
}
