import { useSyncExternalStore } from "react";

/** Deployment config, served as /config.json (dynamically in dev, statically in production). */
export interface HostedConfig {
  convexUrl: string;
  siteUrl: string;
  /** Show the passwordless dev login instead of GitHub. Only true against a dev backend. */
  devAuth?: boolean;
}

const KEY = "opticon_session";
const listeners = new Set<() => void>();

/** Picks up `#session=…` from a login redirect, stores it, and removes it from the URL. */
export function captureSessionFromHash(): void {
  const match = location.hash.match(/session=([\w-]+)/);
  if (!match?.[1]) return;
  localStorage.setItem(KEY, match[1]);
  history.replaceState(null, "", location.pathname + location.search);
}

export function getSession(): string | undefined {
  return localStorage.getItem(KEY) ?? undefined;
}

export function signOut(): void {
  localStorage.removeItem(KEY);
  for (const l of listeners) l();
}

export function useSessionToken(): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      addEventListener("storage", listener);
      return () => {
        listeners.delete(listener);
        removeEventListener("storage", listener);
      };
    },
    getSession,
  );
}

export function signIn(config: HostedConfig, devLogin?: string): void {
  const redirect = encodeURIComponent(location.href);
  location.href = config.devAuth
    ? `${config.siteUrl}/auth/dev?login=${encodeURIComponent(devLogin ?? "dev")}&redirect=${redirect}`
    : `${config.siteUrl}/auth/github/start?redirect=${redirect}`;
}
