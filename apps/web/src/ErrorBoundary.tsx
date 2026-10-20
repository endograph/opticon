import { Component, type ReactNode } from "react";

/**
 * Keeps one failing part of the page from blanking the whole app. A failing Convex query throws
 * during render, e.g. when this app is newer than the server it talks to.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode | ((error: Error) => ReactNode); children: ReactNode },
  { error?: Error }
> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return typeof this.props.fallback === "function" ? this.props.fallback(error) : this.props.fallback;
  }
}

/** The whole app failed. Shows the error, since a blank page leaves nothing to report. */
export function AppError({ error }: { error: unknown }) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    <div className="blocked">
      <h2>Opticon couldn't load</h2>
      <p>Reload to try again. If it keeps happening, include this error when you report it:</p>
      <pre className="app-error">{message}</pre>
    </div>
  );
}
