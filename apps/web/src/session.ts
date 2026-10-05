import type { api } from "@opticon/server/api";
import type { FunctionReturnType } from "convex/server";
import { useSyncExternalStore } from "react";
import { config } from "./config";

/** Browser sign-in for opticon.tv. The local app uses the CLI's login instead (see identity.tsx). */
const KEY = "opticon_session";
const USER_KEY = "opticon_auth";
/** This tab's in-progress sign-in; see captureSessionFromHash. */
const NONCE_KEY = "opticon_login_nonce";
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

/**
 * Picks up `#session=…` from a login redirect, stores it, and removes it from the URL. Only a
 * sign-in this tab started is accepted: its nonce must come back with the session. Anything
 * else is a link trying to sign this browser into another account, and is dropped.
 */
export function captureSessionFromHash(): void {
  const params = new URLSearchParams(location.hash.slice(1));
  const session = params.get("session");
  if (!session) return;
  history.replaceState(null, "", location.pathname + location.search);
  const expected = sessionStorage.getItem(NONCE_KEY);
  sessionStorage.removeItem(NONCE_KEY);
  if (!expected || params.get("nonce") !== expected || !/^[\w-]+$/.test(session)) return;
  if (getSession() !== session) localStorage.removeItem(USER_KEY);
  localStorage.setItem(KEY, session);
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
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem(NONCE_KEY, nonce);
  const params = `redirect=${encodeURIComponent(location.href)}&nonce=${nonce}`;
  location.href = config.devAuth
    ? `${config.siteUrl}/auth/dev?login=${encodeURIComponent(devLogin ?? "dev")}&${params}`
    : `${config.siteUrl}/auth/github/start?${params}`;
}
