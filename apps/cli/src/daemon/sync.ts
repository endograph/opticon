import { type FSWatcher, watch } from "node:fs";
import { basename } from "node:path";
import {
  PRIVATE_ACCESS,
  PROTOCOL_VERSION,
  type SessionMeta,
  type ShareAccess,
  type SharedEvent,
  type SharedSessionProjection,
  projectSessionForShare,
} from "@opticon/core";
import { api } from "@opticon/server/api";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { AUTH_FILE, type Auth, endpoints, readAuth } from "../account";
import { AUTOSYNC_FILE, type AutosyncRule, matches, readRules, repoOf } from "../autosync";
import { OPTICON_HOME } from "../paths";
import { type ListChange, type SessionKey, type SessionMessage, type SessionStore, keyOf } from "./store";

const MAX_BATCH_EVENTS = 200;
const MAX_BATCH_BYTES = 2_000_000;
/** Autosync uploads an active session at most this often. Live viewers still get live updates. */
const AUTOSYNC_INTERVAL_MS = 30_000;

export type MyShare = FunctionReturnType<typeof api.shares.mine>[number];
type Demand = FunctionReturnType<typeof api.shares.liveDemand>;

export interface AccountState {
  configured: boolean;
  signedIn: boolean;
  login?: string;
  liveSync: boolean;
  webUrl?: string;
  /** Set when the server rejected us, e.g. a protocol mismatch or revoked token. */
  error?: string;
}

/**
 * Bridges local sessions and the sharing backend. Shares are uploaded in full when created.
 * After that, a session is streamed only while the server reports live demand (a connected
 * viewer, with live sync on). Uploads are diffed against what this daemon already sent.
 *
 * Autosync rules additionally create and refresh shares, on a slow cadence, for every session
 * in a matching project that's active after the rule was added. Sessions whose share the owner
 * deleted are skipped; the server also rejects them.
 */
export class ShareSync {
  private client?: ConvexClient;
  private auth?: Auth;
  private unsubscribers: (() => void)[] = [];
  private live = new Map<string, () => void>();
  /** shareId -> eventId -> serialized event last uploaded. */
  private uploaded = new Map<string, Map<string, string>>();
  private queues = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private authWatcher?: FSWatcher;
  private offList?: () => void;
  /** Sessions whose share was deleted, from the server. */
  private deleted = new Set<SessionKey>();
  private autoTimers = new Map<SessionKey, Timer>();
  private autoQueue: Promise<void> = Promise.resolve();
  private repos = new Map<string, Promise<string | undefined>>();
  /** Shares this run already tried to link to their repo; see claimRepos. */
  private repoClaims = new Set<string>();
  private claimQueue: Promise<void> = Promise.resolve();
  rules: AutosyncRule[] = [];
  shares: MyShare[] = [];
  account: AccountState = { configured: !!endpoints(), signedIn: false, liveSync: true, webUrl: endpoints()?.webUrl };

  constructor(private readonly store: SessionStore) {}

  async start(): Promise<void> {
    this.rules = await readRules();
    await this.connect();
    // `opticon login` / `logout` rewrite auth.json; reconnect when that happens.
    // `opticon autosync` edits autosync.json; pick up the new rules.
    this.authWatcher = watch(OPTICON_HOME, (_event, name) => {
      if (name === basename(AUTH_FILE)) void this.connect();
      if (name === basename(AUTOSYNC_FILE)) void this.reloadRules();
    });
    this.offList = this.store.onList((change) => this.onSessions(change));
  }

  stop(): void {
    this.authWatcher?.close();
    this.offList?.();
    for (const timer of this.autoTimers.values()) clearTimeout(timer);
    this.autoTimers.clear();
    this.disconnect();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  shareFor(key: SessionKey): MyShare | undefined {
    return this.shares.find((s) => `${s.provider}/${s.sessionId}` === key);
  }

  urlFor(slug: string): string {
    return `${this.account.webUrl}/s/${slug}`;
  }

  /** Creates or updates a share and uploads the whole session. `auto` only creates; see shares.create. */
  async share(
    key: SessionKey,
    access: ShareAccess,
    options: { auto?: boolean; listed?: boolean } = {},
  ): Promise<{ slug: string; url: string }> {
    const { auto = false, listed } = options;
    const { client, auth } = this.requireClient();
    const session = await this.store.events(key);
    if (!session) throw new Error("Session not found");
    const { meta } = session;
    const projection = projectSessionForShare(session);
    // The server links the share to its GitHub repo once it confirms we can push to it.
    // Other remotes stay on this machine.
    const remote = meta.cwd ? await this.repoFor(meta.cwd) : undefined;
    const repo = remote?.startsWith("github.com/") ? remote : undefined;
    const { shareId, slug } = await client.action(api.shares.create, {
      token: auth.token,
      protocol: PROTOCOL_VERSION,
      provider: meta.provider,
      sessionId: meta.id,
      title: projection.meta.title,
      // Clones and worktrees of a repo are one project.
      project: repo ? repo.split("/").at(-1) : projection.meta.project,
      repo,
      access,
      auto,
      listed,
    });
    if (!auto) this.deleted.delete(key);
    await this.upload(shareId, projection);
    return { slug, url: this.urlFor(slug) };
  }

  /**
   * Shares created before the daemon sent repos have none. Claim each one's GitHub repo, once per
   * run, so it can appear on the repo page; the server verifies push access as for new shares.
   */
  private claimRepos(shares: MyShare[]): void {
    for (const share of shares) {
      if (share.repo || this.repoClaims.has(share.shareId)) continue;
      this.repoClaims.add(share.shareId);
      this.claimQueue = this.claimQueue
        .then(async () => {
          const cwd = this.store.get(keyOf({ provider: share.provider, id: share.sessionId }))?.cwd;
          const remote = cwd ? await this.repoFor(cwd) : undefined;
          if (!remote?.startsWith("github.com/")) return;
          const { client, auth } = this.requireClient();
          await client.action(api.shares.claimRepo, {
            token: auth.token,
            protocol: PROTOCOL_VERSION,
            shareId: share.shareId,
            repo: remote,
            project: remote.split("/").at(-1),
          });
        })
        .catch((error: Error) => console.error(`Repo claim failed (${share.shareId}): ${error.message}`));
    }
  }

  /** Makes a share private. The copy stays on the server and keeps syncing. */
  async unshare(shareId: string): Promise<void> {
    const { client, auth } = this.requireClient();
    await client.mutation(api.shares.setAccess, { token: auth.token, shareId: shareId as never, access: PRIVATE_ACCESS });
  }

  /** Deletes the server copy. Autosync won't re-create it; only an explicit share does. */
  async delete(shareId: string): Promise<void> {
    const { client, auth } = this.requireClient();
    const share = this.shares.find((s) => s.shareId === shareId);
    if (share) this.deleted.add(keyOf({ provider: share.provider, id: share.sessionId }));
    this.stopLive(shareId);
    this.uploaded.delete(shareId);
    await client.mutation(api.shares.remove, { token: auth.token, shareId: shareId as never });
  }


  // --- connection -----------------------------------------------------------

  private async connect(): Promise<void> {
    this.disconnect();
    const ep = endpoints();
    this.auth = await readAuth();
    this.account = { configured: !!ep, signedIn: false, liveSync: true, webUrl: ep?.webUrl };
    if (!ep || !this.auth) return this.emit();
    const { token } = this.auth;
    const client = new ConvexClient(ep.convexUrl);
    this.client = client;
    const onError = (error: Error) => {
      this.account = { ...this.account, signedIn: false, error: error.message };
      this.emit();
    };
    this.unsubscribers.push(
      client.onUpdate(
        api.auth.me,
        { token },
        (me) => {
          this.account = me
            ? { ...this.account, signedIn: true, login: me.login, liveSync: me.liveSync, error: undefined }
            : { ...this.account, signedIn: false, error: "Your login expired. Run `opticon login`." };
          this.emit();
        },
        onError,
      ),
      client.onUpdate(
        api.shares.mine,
        { token },
        (shares) => {
          this.shares = shares;
          // A share deleted elsewhere (e.g. on opticon.tv) lost its events; forget what we sent.
          const live = new Set(shares.map((s) => s.shareId as string));
          for (const shareId of this.uploaded.keys()) if (!live.has(shareId)) this.uploaded.delete(shareId);
          this.claimRepos(shares);
          this.emit();
        },
        onError,
      ),
      client.onUpdate(
        api.shares.deleted,
        { token },
        (deleted) => {
          this.deleted = new Set(deleted.map((d) => keyOf({ provider: d.provider, id: d.sessionId })));
        },
        onError,
      ),
      client.onUpdate(api.shares.liveDemand, { token }, (demand) => this.reconcile(demand), onError),
    );
  }

  private disconnect(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const shareId of [...this.live.keys()]) this.stopLive(shareId);
    void this.client?.close();
    this.client = undefined;
    this.shares = [];
    this.deleted.clear();
    this.repoClaims.clear();
  }

  private requireClient(): { client: ConvexClient; auth: Auth } {
    if (!this.client || !this.auth || !this.account.signedIn) throw new Error("Not signed in. Run `opticon login`.");
    return { client: this.client, auth: this.auth };
  }

  // --- autosync -------------------------------------------------------------

  async reloadRules(): Promise<void> {
    this.rules = await readRules();
    this.emit();
  }

  /** The rule covering `cwd`, if any. */
  async ruleFor(cwd: string): Promise<AutosyncRule | undefined> {
    if (!this.rules.length) return undefined;
    const remote = this.rules.some((r) => r.repo) ? await this.repoFor(cwd) : undefined;
    return this.rules.find((r) => matches(r, cwd, remote));
  }

  /** The normalized origin remote of `cwd`, looked up once per directory. */
  repoFor(cwd: string): Promise<string | undefined> {
    const repo = this.repos.get(cwd) ?? repoOf(cwd);
    this.repos.set(cwd, repo);
    return repo;
  }

  /**
   * Session files changed. Throttled rather than debounced, so a long-running turn still syncs
   * every AUTOSYNC_INTERVAL_MS; uploads run one at a time.
   */
  private onSessions(change: ListChange): void {
    if (!this.rules.length) return;
    for (const meta of change.upserted) {
      const key = keyOf(meta);
      if (this.autoTimers.has(key)) continue;
      void this.autoRule(meta).then((rule) => {
        if (!rule || this.autoTimers.has(key)) return;
        const timer = setTimeout(() => {
          this.autoTimers.delete(key);
          this.autoQueue = this.autoQueue.then(() => this.autosync(key)).catch((error: Error) => {
            console.error(`Autosync failed (${key}): ${error.message}`);
          });
        }, AUTOSYNC_INTERVAL_MS);
        this.autoTimers.set(key, timer);
      });
    }
  }

  private async autoRule(meta: SessionMeta): Promise<AutosyncRule | undefined> {
    if (!meta.cwd || this.deleted.has(keyOf(meta))) return undefined;
    const rule = await this.ruleFor(meta.cwd);
    // No backfill: only sessions active since the rule was added.
    if (!rule || (meta.updatedAt ?? "") < rule.since) return undefined;
    return rule;
  }

  private async autosync(key: SessionKey): Promise<void> {
    const meta = this.store.get(key);
    if (!meta || !this.account.signedIn || this.deleted.has(key)) return;
    const rule = await this.autoRule(meta);
    if (!rule) return;
    const existing = this.shareFor(key);
    if (!existing) {
      await this.share(key, rule.share ?? PRIVATE_ACCESS, { auto: true, listed: rule.listed });
      return;
    }
    const session = await this.store.events(key);
    if (session) await this.upload(existing.shareId, projectSessionForShare(session));
  }

  // --- live sync ------------------------------------------------------------

  /** Starts streaming newly demanded shares and stops the rest. */
  private reconcile(demand: Demand): void {
    const wanted = new Map(demand.map((d) => [d.shareId as string, keyOf({ provider: d.provider, id: d.sessionId })]));
    for (const shareId of [...this.live.keys()]) if (!wanted.has(shareId)) this.stopLive(shareId);
    for (const [shareId, key] of wanted) {
      if (this.live.has(shareId)) continue;
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      this.live.set(shareId, () => {
        stopped = true;
        unsubscribe?.();
      });
      void this.store
        .subscribe(key, (message: SessionMessage) => {
          // A snapshot after (re)connecting is diffed, so only real changes are sent.
          void this.upload(shareId, projectSessionForShare(message));
        })
        .then((fn) => {
          if (stopped) fn?.();
          else unsubscribe = fn;
        });
    }
  }

  private stopLive(shareId: string): void {
    this.live.get(shareId)?.();
    this.live.delete(shareId);
  }

  /** Projects, diffs, and uploads in batches. Serialized per share to keep order. */
  private upload(shareId: string, projection: SharedSessionProjection): Promise<void> {
    const { title } = projection.meta;
    const previous = this.queues.get(shareId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const { client, auth } = this.requireClient();
        const sent = this.uploaded.get(shareId) ?? new Map<string, string>();
        this.uploaded.set(shareId, sent);
        const pending = projection.events.filter((e) => sent.get(e.id) !== JSON.stringify(e));
        for (const batch of batches(pending)) {
          await client.mutation(api.shares.append, { token: auth.token, protocol: PROTOCOL_VERSION, shareId: shareId as never, title, events: batch });
          for (const e of batch) sent.set(e.id, JSON.stringify(e));
        }
        if (!pending.length && title) {
          await client.mutation(api.shares.append, { token: auth.token, protocol: PROTOCOL_VERSION, shareId: shareId as never, title, events: [] });
        }
      })
      .catch((error: Error) => {
        console.error(`Share upload failed (${shareId}): ${error.message}`);
        throw error;
      });
    // Keep the chain alive after a failure; callers that care get the rejection.
    this.queues.set(shareId, next.catch(() => {}));
    return next;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function* batches(events: SharedEvent[]): Generator<SharedEvent[]> {
  let batch: SharedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length;
    if (batch.length && (batch.length >= MAX_BATCH_EVENTS || bytes + size > MAX_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length) yield batch;
}
