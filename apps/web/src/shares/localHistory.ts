import { useSyncExternalStore } from "react";

/**
 * Watch history for signed-out viewers, kept in this browser. Only slugs are stored; share details
 * are looked up from the server so they stay current. Signing in moves this into the account.
 */
const KEY = "opticon_history";
const MAX_ENTRIES = 200;
const listeners = new Set<() => void>();

export interface LocalEntry {
  slug: string;
  lastViewedAt: number;
  following: boolean;
  /** The share's event count when last viewed; newer events show as unread. */
  seenEventCount?: number;
}

let cachedRaw: string | null = null;
let cached: LocalEntry[] = [];

export function readLocalHistory(): LocalEntry[] {
  const raw = localStorage.getItem(KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const parsed: unknown = JSON.parse(raw ?? "[]");
      cached = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      cached = [];
    }
  }
  return cached;
}

function isEntry(e: unknown): e is LocalEntry {
  const entry = e as Partial<LocalEntry> | null;
  return (
    typeof entry?.slug === "string" &&
    typeof entry.lastViewedAt === "number" &&
    typeof entry.following === "boolean" &&
    (entry.seenEventCount === undefined || typeof entry.seenEventCount === "number")
  );
}

function write(entries: LocalEntry[]): void {
  if (entries.length) localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  else localStorage.removeItem(KEY);
  for (const l of listeners) l();
}

/** The first view follows; later views never re-follow. */
export function recordLocalVisit(slug: string, seenEventCount: number): void {
  const entries = readLocalHistory();
  const existing = entries.find((e) => e.slug === slug);
  const entry = { slug, lastViewedAt: Date.now(), following: existing?.following ?? true, seenEventCount };
  write([entry, ...entries.filter((e) => e.slug !== slug)]);
}

export function setLocalFollowing(slug: string, following: boolean): void {
  const entries = readLocalHistory();
  const existing = entries.find((e) => e.slug === slug);
  if (existing) write(entries.map((e) => (e === existing ? { ...e, following } : e)));
  else write([{ slug, lastViewedAt: Date.now(), following }, ...entries]);
}

export function clearLocalHistory(): void {
  write([]);
}

export function useLocalHistory(): LocalEntry[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    addEventListener("storage", listener);
    return () => {
      listeners.delete(listener);
      removeEventListener("storage", listener);
    };
  }, readLocalHistory);
}
