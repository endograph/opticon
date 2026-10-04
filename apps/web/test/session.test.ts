import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SessionUser, cacheUser, captureSessionFromHash, getSession, getSessionUser, signOut } from "../src/session";

const backend = "https://example.convex.cloud";
const user: SessionUser = { login: "alice", name: "Alice", avatarUrl: "https://example.com/alice.png", liveSync: true };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

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
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
    let replaced: string | undefined;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { hash: "#session=new-session", pathname: "/cli", search: "?code=abc" },
    });
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: { replaceState: (_state: unknown, _unused: string, url: string) => { replaced = url; } },
    });
    try {
      captureSessionFromHash();
      expect(getSession()).toBe("new-session");
      expect(storage.has("opticon_auth")).toBe(false);
      expect(getSessionUser(getSession(), backend, undefined)).toBeUndefined();
      expect(replaced).toBe("/cli?code=abc");
    } finally {
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
      else Reflect.deleteProperty(globalThis, "location");
      if (originalHistory) Object.defineProperty(globalThis, "history", originalHistory);
      else Reflect.deleteProperty(globalThis, "history");
    }
  });
});
