import { type FSWatcher, watch } from "node:fs";
import { basename } from "node:path";
import { PROTOCOL_VERSION, type ShareAccess, type SharedEvent, type SharedSessionProjection, projectSessionForShare } from "@opticon/core";
import { api } from "@opticon/server/api";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { AUTH_FILE, type Auth, endpoints, readAuth } from "../account";
import { OPTICON_HOME } from "../paths";
import { type SessionKey, type SessionMessage, type SessionStore, keyOf } from "./store";

const MAX_BATCH_EVENTS = 200;
const MAX_BATCH_BYTES = 2_000_000;

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
  shares: MyShare[] = [];
  account: AccountState = { configured: !!endpoints(), signedIn: false, liveSync: true, webUrl: endpoints()?.webUrl };

  constructor(private readonly store: SessionStore) {}

  async start(): Promise<void> {
    await this.connect();
    // `opticon login` / `logout` rewrite auth.json; reconnect when that happens.
    this.authWatcher = watch(OPTICON_HOME, (_event, name) => {
      if (name === basename(AUTH_FILE)) void this.connect();
    });
  }

  stop(): void {
    this.authWatcher?.close();
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

  /** Creates or updates a share and uploads the whole session. */
  async share(key: SessionKey, access: ShareAccess): Promise<{ slug: string; url: string }> {
    const { client, auth } = this.requireClient();
    const session = await this.store.events(key);
    if (!session) throw new Error("Session not found");
    const { meta } = session;
    const projection = projectSessionForShare(session);
    const { shareId, slug } = await client.action(api.shares.create, {
      token: auth.token,
      protocol: PROTOCOL_VERSION,
      provider: meta.provider,
      sessionId: meta.id,
      title: projection.meta.title,
      project: projection.meta.project,
      access,
    });
    await this.upload(shareId, projection);
    return { slug, url: this.urlFor(slug) };
  }

  async unshare(shareId: string): Promise<void> {
    const { client, auth } = this.requireClient();
    this.stopLive(shareId);
    this.uploaded.delete(shareId);
    await client.mutation(api.shares.remove, { token: auth.token, shareId: shareId as never });
  }

  async setLiveSync(liveSync: boolean): Promise<void> {
    const { client, auth } = this.requireClient();
    await client.mutation(api.auth.setLiveSync, { token: auth.token, liveSync });
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
          this.emit();
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
  }

  private requireClient(): { client: ConvexClient; auth: Auth } {
    if (!this.client || !this.auth || !this.account.signedIn) throw new Error("Not signed in. Run `opticon login`.");
    return { client: this.client, auth: this.auth };
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
