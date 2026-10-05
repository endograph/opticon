import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SessionUser, cacheUser, captureSessionFromHash, getSession, getSessionUser, signOut } from "../src/session";

const backend = "https://example.convex.cloud";
const user: SessionUser = { login: "alice", name: "Alice", avatarUrl: "https://example.com/alice.png", liveSync: true };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
let storage: Map<string, string>;
let tabStorage: Map<string, string>;

const fakeStorage = (map: () => Map<string, string>) => ({
  getItem: (key: string) => map().get(key) ?? null,
  setItem: (key: string, value: string) => map().set(key, value),
  removeItem: (key: string) => map().delete(key),
});

beforeEach(() => {
  storage = new Map();
  tabStorage = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fakeStorage(() => storage) });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: fakeStorage(() => tabStorage) });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

/** Runs `run` on a page at `hash`, returning the URL the hash was stripped to. */
function onRedirect(hash: string, run: () => void): string | undefined {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  let replaced: string | undefined;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hash, pathname: "/cli", search: "?code=abc" } });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState: (_state: unknown, _unused: string, url: string) => { replaced = url; } },
  });
  try {
    run();
    return replaced;
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
    if (originalHistory) Object.defineProperty(globalThis, "history", originalHistory);
    else Reflect.deleteProperty(globalThis, "history");
  }
}

describe("session display", () => {
  test("an unchecked token has unknown auth, while no token is signed out", () => {
    expect(getSessionUser("pending", backend, undefined)).toBeUndefined();
    expect(getSessionUser(undefined, backend, undefined)).toBeNull();
  });

  test("restores the account before auth resolves on a returning visit", () => {
    cacheUser("session", backend, user);
    expect(getSessionUser("session", backend, undefined)).toEqual(user);
  });

  test("does not reuse a cached account for another session or backend", () => {
    cacheUser("session", backend, user);
    expect(getSessionUser("different-session", backend, undefined)).toBeUndefined();
    expect(getSessionUser("session", "https://other.convex.cloud", undefined)).toBeUndefined();
    expect(getSessionUser(undefined, backend, undefined)).toBeNull();
  });

  test("the server replaces cached account data and rejects expired sessions", () => {
    cacheUser("session", backend, user);
    const updated = { ...user, name: "Updated Alice", avatarUrl: undefined };
    expect(getSessionUser("session", backend, updated)).toEqual(updated);
    expect(getSessionUser("session", backend, null)).toBeNull();
  });

  test("a damaged display cache leaves auth pending instead of signing out", () => {
    storage.set("opticon_auth", "{broken");
    expect(getSessionUser("session", backend, undefined)).toBeUndefined();
    storage.set("opticon_auth", JSON.stringify({ token: "session", backend, user: { login: "alice" } }));
    expect(getSessionUser("session", backend, undefined)).toBeUndefined();
  });

  test("signing out clears both the token and cached account immediately", () => {
    storage.set("opticon_session", "session");
    cacheUser("session", backend, user);
    signOut();
    expect(getSession()).toBeUndefined();
    expect(storage.has("opticon_auth")).toBe(false);
    expect(getSessionUser(getSession(), backend, undefined)).toBeNull();
  });

  test("a login redirect drops the previous account cache and removes the token from the URL", () => {
    storage.set("opticon_session", "previous-session");
    cacheUser("previous-session", backend, user);
    tabStorage.set("opticon_login_nonce", "tab-nonce");
    const replaced = onRedirect("#session=new-session&nonce=tab-nonce", captureSessionFromHash);
    expect(getSession()).toBe("new-session");
    expect(storage.has("opticon_auth")).toBe(false);
    expect(tabStorage.has("opticon_login_nonce")).toBe(false);
    expect(getSessionUser(getSession(), backend, undefined)).toBeUndefined();
    expect(replaced).toBe("/cli?code=abc");
  });

  test("a session this tab didn't ask for is dropped, keeping the current account", () => {
    storage.set("opticon_session", "mine");
    cacheUser("mine", backend, user);
    for (const hash of ["#session=attacker", "#session=attacker&nonce=guess"]) {
      if (hash.includes("guess")) tabStorage.set("opticon_login_nonce", "tab-nonce");
      expect(onRedirect(hash, captureSessionFromHash)).toBe("/cli?code=abc");
      expect(getSession()).toBe("mine");
      expect(getSessionUser("mine", backend, undefined)).toEqual(user);
    }
    // A failed attempt uses up the nonce, so it can't be replayed.
    expect(tabStorage.has("opticon_login_nonce")).toBe(false);
  });
});
