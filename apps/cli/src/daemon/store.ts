import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Roots,
  type SessionEvent,
  type SessionFile,
  type SessionMeta,
  SessionTail,
  defaultRoots,
  listSessionFiles,
  readCodexTitles,
  readSessionMeta,
} from "@opticon/core";
import { INDEX_FILE } from "../paths";

/** Bump whenever parser output changes, so cached metadata is rebuilt. */
const INDEX_VERSION = 2;
const BATCH = 16;
const DEBOUNCE_MS = 150;
const POLL_MS = 3_000;
const RESCAN_MS = 60_000;
const IDLE_TAIL_MS = 60_000;

export type SessionKey = `${SessionMeta["provider"]}/${string}`;
export const keyOf = (meta: Pick<SessionMeta, "provider" | "id">): SessionKey => `${meta.provider}/${meta.id}`;

export type ListChange = { upserted: SessionMeta[]; removed: SessionKey[] };
export type SessionMessage =
  | { type: "snapshot"; meta: SessionMeta; events: SessionEvent[] }
  | { type: "events"; meta: SessionMeta; events: SessionEvent[] }
  | { type: "reset"; meta: SessionMeta; events: SessionEvent[] };

interface Entry {
  file: SessionFile;
  meta?: SessionMeta;
}

interface OpenSession {
  tail: SessionTail;
  subscribers: Set<(message: SessionMessage) => void>;
  /** Serializes reads so watcher events and polls never interleave on one tail. */
  queue: Promise<void>;
  idleTimer?: Timer;
}

/**
 * The daemon's view of local sessions. Keeps a metadata index (persisted across restarts,
 * keyed by file size and mtime) and full tails for sessions that someone is looking at.
 */
export class SessionStore {
  private entries = new Map<string, Entry>();
  private paths = new Map<SessionKey, string>();
  private open = new Map<SessionKey, OpenSession>();
  private listeners = new Set<(change: ListChange) => void>();
  private pending = new Map<string, Timer>();
  private watchers: FSWatcher[] = [];
  private timers: Timer[] = [];
  private codexTitles = new Map<string, string>();
  private titlesMtime = 0;
  private scanning: Promise<void> | undefined;
  private saveTimer?: Timer;

  constructor(private readonly roots: Roots = defaultRoots()) {}

  async start(): Promise<void> {
    await this.loadIndex();
    this.watch();
    this.timers.push(setInterval(() => this.pollOpen(), POLL_MS));
    this.timers.push(setInterval(() => void this.scan(), RESCAN_MS));
    // Don't block startup on a cold index: the list fills in as batches complete.
    void this.scan();
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    for (const t of this.timers) clearInterval(t);
  }

  list(): SessionMeta[] {
    return [...this.entries.values()]
      .flatMap((e) => (e.meta && this.paths.get(keyOf(e.meta)) === e.file.path ? [e.meta] : []))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  get(key: SessionKey): SessionMeta | undefined {
    const path = this.paths.get(key);
    return path ? this.entries.get(path)?.meta : undefined;
  }

  onList(listener: (change: ListChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Full event list for one session, opening (and briefly caching) its tail. */
  async events(key: SessionKey): Promise<{ meta: SessionMeta; events: SessionEvent[] } | undefined> {
    const session = await this.openSession(key);
    if (!session) return undefined;
    this.scheduleClose(key, session);
    return { meta: this.metaFor(key, session), events: [...session.tail.events.values()] };
  }

  /** Streams a snapshot, then changes as the file grows. Returns undefined for unknown sessions. */
  async subscribe(key: SessionKey, send: (message: SessionMessage) => void): Promise<(() => void) | undefined> {
    const session = await this.openSession(key);
    if (!session) return undefined;
    clearTimeout(session.idleTimer);
    session.subscribers.add(send);
    send({ type: "snapshot", meta: this.metaFor(key, session), events: [...session.tail.events.values()] });
    return () => {
      session.subscribers.delete(send);
      this.scheduleClose(key, session);
    };
  }

  // --- indexing -------------------------------------------------------------

  /** Re-lists files and re-indexes any whose size or mtime changed. Concurrent calls share one scan. */
  scan(): Promise<void> {
    this.scanning ??= this.runScan().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async runScan(): Promise<void> {
    await this.refreshTitles();
    const files = await listSessionFiles(this.roots);
    const seen = new Set(files.map((f) => f.path));
    const removed: SessionKey[] = [];
    for (const [path, entry] of this.entries) {
      if (seen.has(path)) continue;
      this.entries.delete(path);
      if (entry.meta) {
        this.paths.delete(keyOf(entry.meta));
        removed.push(keyOf(entry.meta));
      }
    }
    if (removed.length) this.emit({ upserted: [], removed });
    // Files arrive newest first, so recent sessions show up before the long tail.
    const stale = files.filter((f) => {
      const known = this.entries.get(f.path)?.file;
      return !known || known.size !== f.size || known.mtimeMs !== f.mtimeMs;
    });
    for (let i = 0; i < stale.length; i += BATCH) {
      const metas = await Promise.all(stale.slice(i, i + BATCH).map((f) => this.index(f)));
      const upserted = metas.filter((m): m is SessionMeta => !!m);
      if (upserted.length) this.emit({ upserted, removed: [] });
    }
    if (stale.length || removed.length) this.saveIndex();
  }

  private async index(file: SessionFile): Promise<SessionMeta | undefined> {
    try {
      const meta = await readSessionMeta(file, this.codexTitles);
      const previous = this.entries.get(file.path)?.meta;
      if (previous && keyOf(previous) !== keyOf(meta)) this.paths.delete(keyOf(previous));
      this.entries.set(file.path, { file, meta });
      // Ids should be unique per provider; if two files ever claim one, the newer file wins.
      const claimed = this.paths.get(keyOf(meta));
      const rival = claimed && claimed !== file.path ? this.entries.get(claimed)?.file : undefined;
      if (rival && rival.mtimeMs > file.mtimeMs) return undefined;
      this.paths.set(keyOf(meta), file.path);
      return meta;
    } catch {
      return undefined;
    }
  }

  private async refreshTitles(): Promise<void> {
    const mtime = await stat(join(this.roots.codex, "session_index.jsonl")).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (mtime === this.titlesMtime) return;
    this.titlesMtime = mtime;
    this.codexTitles = await readCodexTitles(this.roots);
    const upserted: SessionMeta[] = [];
    for (const entry of this.entries.values()) {
      const title = entry.meta?.provider === "codex" ? this.codexTitles.get(entry.meta.id) : undefined;
      if (entry.meta && title && title !== entry.meta.title) {
        entry.meta = { ...entry.meta, title };
        upserted.push(entry.meta);
      }
    }
    if (upserted.length) this.emit({ upserted, removed: [] });
  }

  // --- watching -------------------------------------------------------------

  private watch(): void {
    const onSessionFile = (dir: string) => (name: string) => {
      if (name.endsWith(".jsonl") && !name.includes("subagents")) this.changed(join(dir, name));
    };
    const dirs: [string, boolean, (name: string) => void][] = [
      [join(this.roots.claude, "projects"), true, onSessionFile(join(this.roots.claude, "projects"))],
      [join(this.roots.codex, "sessions"), true, onSessionFile(join(this.roots.codex, "sessions"))],
      [join(this.roots.codex, "archived_sessions"), false, onSessionFile(join(this.roots.codex, "archived_sessions"))],
      // Top-level ~/.codex churns constantly (sqlite, history.jsonl); only the title index matters.
      [this.roots.codex, false, (name) => name === "session_index.jsonl" && void this.refreshTitles()],
    ];
    for (const [dir, recursive, handle] of dirs) {
      try {
        this.watchers.push(watch(dir, { recursive }, (_event, name) => name && handle(name)));
      } catch {
        // Provider not installed. The periodic rescan picks it up if it appears later.
      }
    }
  }

  /** Debounced: FSEvents fires several times per append. */
  private changed(path: string): void {
    clearTimeout(this.pending.get(path));
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        void this.refreshPath(path);
      }, DEBOUNCE_MS),
    );
  }

  private async refreshPath(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry) {
      // New file, or a directory we don't index (top-level ~/.codex, subagents). Let the scan decide.
      await this.scan();
    } else {
      const s = await stat(path).catch(() => undefined);
      if (!s) return void this.scan();
      if (s.size !== entry.file.size || s.mtimeMs !== entry.file.mtimeMs) {
        const meta = await this.index({ ...entry.file, size: s.size, mtimeMs: s.mtimeMs });
        if (meta) this.emit({ upserted: [meta], removed: [] });
        this.saveIndex();
      }
    }
    const meta = this.entries.get(path)?.meta;
    if (meta) this.pump(keyOf(meta));
  }

  // --- open sessions --------------------------------------------------------

  private async openSession(key: SessionKey): Promise<OpenSession | undefined> {
    const existing = this.open.get(key);
    if (existing) {
      await existing.queue;
      return existing;
    }
    const path = this.paths.get(key);
    const meta = path ? this.entries.get(path)?.meta : undefined;
    if (!path || !meta) return undefined;
    const session: OpenSession = {
      tail: new SessionTail(meta.provider, path, meta.title),
      subscribers: new Set(),
      queue: Promise.resolve(),
    };
    this.open.set(key, session);
    session.queue = session.tail.read().then(() => undefined);
    await session.queue;
    return session;
  }

  private pump(key: SessionKey): void {
    const session = this.open.get(key);
    if (!session) return;
    session.queue = session.queue.then(async () => {
      const { changed, reset } = await session.tail.read().catch(() => ({ changed: [], reset: false }));
      if (!changed.length && !reset) return;
      const meta = this.metaFor(key, session);
      const message: SessionMessage = reset
        ? { type: "reset", meta, events: [...session.tail.events.values()] }
        : { type: "events", meta, events: changed };
      for (const send of session.subscribers) send(message);
    });
  }

  private pollOpen(): void {
    for (const [key, session] of this.open) if (session.subscribers.size) this.pump(key);
  }

  private scheduleClose(key: SessionKey, session: OpenSession): void {
    if (session.subscribers.size) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.subscribers.size) this.open.delete(key);
    }, IDLE_TAIL_MS);
  }

  /** Index metadata (title from ai-title/session_index, mtime) merged with the tail's fuller view. */
  private metaFor(key: SessionKey, session: OpenSession): SessionMeta {
    const merged: SessionMeta = { ...session.tail.meta };
    for (const [k, v] of Object.entries(this.get(key) ?? {})) if (v !== undefined) (merged as any)[k] = v;
    return merged;
  }

  private emit(change: ListChange): void {
    for (const listener of this.listeners) listener(change);
  }

  // --- persistence ----------------------------------------------------------

  private async loadIndex(): Promise<void> {
    const file = Bun.file(INDEX_FILE);
    if (!(await file.exists())) return;
    try {
      const data = await file.json();
      if (data.version !== INDEX_VERSION) return;
      for (const entry of data.entries as Entry[]) {
        this.entries.set(entry.file.path, entry);
        if (entry.meta) this.paths.set(keyOf(entry.meta), entry.file.path);
      }
    } catch {
      // Corrupt cache: rebuild from scratch.
    }
  }

  private saveIndex(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = { version: INDEX_VERSION, entries: [...this.entries.values()] };
      void Bun.write(INDEX_FILE, JSON.stringify(data));
    }, 1_000);
  }
}
