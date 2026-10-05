import { type FSWatcher, watch } from "node:fs";
import { basename } from "node:path";
import { AUTH_FILE, INSTANCES_FILE, endpoints, syncedInstances } from "../account";
import { AUTOSYNC_FILE } from "../autosync";
import { OPTICON_HOME } from "../paths";
import type { SessionStore } from "./store";
import { ShareSync } from "./sync";

export class UnknownInstanceError extends Error {
  constructor(convexUrl: string) {
    super(`${convexUrl} isn't set up on this machine anymore. Reload the page.`);
  }
}

/**
 * One ShareSync per known server, all fed by the same session store, so autosync and live
 * updates keep working for every server whichever one is selected. Servers you aren't signed
 * in to stay idle.
 */
export class Syncs {
  private syncs = new Map<string, ShareSync>();
  private listeners = new Set<() => void>();
  private watcher?: FSWatcher;
  private offs = new Map<string, () => void>();

  constructor(private readonly store: SessionStore) {}

  async start(): Promise<void> {
    await this.reconcile();
    // `opticon login` / `logout` rewrite auth.json; `opticon autosync` edits autosync.json;
    // `opticon instance` adds, removes, or selects servers.
    this.watcher = watch(OPTICON_HOME, (_event, name) => {
      if (name === basename(AUTH_FILE)) for (const sync of this.syncs.values()) void sync.refreshAuth();
      if (name === basename(AUTOSYNC_FILE)) for (const sync of this.syncs.values()) void sync.reloadRules();
      if (name === basename(INSTANCES_FILE)) void this.reconcile();
    });
  }

  stop(): void {
    this.watcher?.close();
    for (const sync of this.syncs.values()) sync.stop();
    this.syncs.clear();
  }

  /** The selected server's sync. */
  selected(): ShareSync {
    return this.syncs.get(endpoints().convexUrl) ?? [...this.syncs.values()][0]!;
  }

  /**
   * The sync for a backend URL, or the selected server's when none is given. A URL that isn't
   * set up here (a page left open on a removed server) is refused rather than sent elsewhere.
   */
  for(convexUrl: string | null | undefined): ShareSync {
    if (!convexUrl) return this.selected();
    const sync = this.syncs.get(convexUrl);
    if (!sync) throw new UnknownInstanceError(convexUrl);
    return sync;
  }

  all(): ShareSync[] {
    return [...this.syncs.values()];
  }

  /** Called on any server's change, and when servers are added, removed, or selected. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async reconcile(): Promise<void> {
    const wanted = new Map(syncedInstances().map((i) => [i.convexUrl, i]));
    for (const [convexUrl, sync] of this.syncs) {
      if (wanted.has(convexUrl)) continue;
      sync.stop();
      this.offs.get(convexUrl)?.();
      this.syncs.delete(convexUrl);
      this.offs.delete(convexUrl);
    }
    for (const [convexUrl, instance] of wanted) {
      if (this.syncs.has(convexUrl)) continue;
      const sync = new ShareSync(this.store, instance);
      this.syncs.set(convexUrl, sync);
      this.offs.set(convexUrl, sync.onChange(() => this.emit()));
      // Connecting waits on the server; one that's down mustn't hold up local browsing or the others.
      void sync.start().catch((error: Error) => console.error(`Couldn't connect to ${instance.name}: ${error.message}`));
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
