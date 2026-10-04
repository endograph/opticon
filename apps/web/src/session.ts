import type { api } from "@opticon/server/api";
import type { FunctionReturnType } from "convex/server";
import { useSyncExternalStore } from "react";
import { config } from "./config";

/** Browser sign-in for opticon.tv. The local app uses the CLI's login instead (see identity.tsx). */
const KEY = "opticon_session";
const USER_KEY = "opticon_auth";
const listeners = new Set<() => void>();

export type SessionUser = NonNullable<FunctionReturnType<typeof api.auth.me>>;

/** Cached account for display while checking auth; the server's answer always wins. */
export function getSessionUser(
  token: string | undefined,
  backend: string,
  confirmed: SessionUser | null | undefined,
): SessionUser | null | undefined {
  if (!token) return null;
  if (confirmed !== undefined) return confirmed;
  try {
    const cached = JSON.parse(localStorage.getItem(USER_KEY) ?? "null");
    if (cached?.token !== token || cached.backend !== backend) return;
    const user = cached.user;
    if (
      typeof user?.login !== "string" ||
      typeof user.liveSync !== "boolean" ||
      (user.name !== undefined && typeof user.name !== "string") ||
      (user.avatarUrl !== undefined && typeof user.avatarUrl !== "string")
    ) return;
    return user;
  } catch {
    return undefined;
  }
}

export function cacheUser(token: string, backend: string, user: SessionUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify({ token, backend, user }));
  } catch {
    // Auth still works if the browser cannot persist this display cache.
  }
}

/** Picks up `#session=…` from a login redirect, stores it, and removes it from the URL. */
export function captureSessionFromHash(): void {
  const match = location.hash.match(/session=([\w-]+)/);
  if (!match?.[1]) return;
  if (getSession() !== match[1]) localStorage.removeItem(USER_KEY);
  localStorage.setItem(KEY, match[1]);
  history.replaceState(null, "", location.pathname + location.search);
}

export function getSession(): string | undefined {
  return localStorage.getItem(KEY) ?? undefined;
}

export function signOut(): void {
  localStorage.removeItem(KEY);
  localStorage.removeItem(USER_KEY);
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

export function signIn(devLogin?: string): void {
  const redirect = encodeURIComponent(location.href);
  location.href = config.devAuth
    ? `${config.siteUrl}/auth/dev?login=${encodeURIComponent(devLogin ?? "dev")}&redirect=${redirect}`
    : `${config.siteUrl}/auth/github/start?redirect=${redirect}`;
}
