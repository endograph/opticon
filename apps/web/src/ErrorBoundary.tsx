import { Component, type ReactNode } from "react";

/**
 * Keeps one failing part of the page from blanking the whole app. A failing Convex query throws
 * during render, e.g. when this app is newer than the server it talks to.
 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
