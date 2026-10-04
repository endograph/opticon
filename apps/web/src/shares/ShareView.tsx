import type { SessionEvent, SharedEvent } from "@opticon/core";
import { api } from "@opticon/server/api";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Transcript } from "../Transcript";
import { isLocal, setPageTitle } from "../config";
import { formatTime } from "../format";
import { SignInButton, useToken } from "../identity";
import { Link } from "../router";
import { signOut } from "../session";
import { recordLocalVisit, setLocalFollowing, useLocalHistory } from "./localHistory";
import { ProviderIcon } from "../ProviderIcon";

const HEARTBEAT_MS = 15_000;

export function ShareView({ slug }: { slug: string }) {
  const token = useToken();
  const view = useQuery(api.shares.view, { slug, token });
  const ok = view?.status === "ok";
  const events = useShareEvents(slug, token, ok);
  usePresence(slug, token, ok);
  useLocalVisit(slug, token, ok ? view.share.eventCount : undefined);
  useMembershipRefresh(token, view?.status === "forbidden" && view.stale);

  useEffect(() => {
    setPageTitle(ok ? view.share.title : undefined);
  }, [ok, ok && view.share.title]);

  if (!view) return <p className="hint pad">Loading…</p>;
  if (view.status === "not_found") {
    return <Message title="This share doesn't exist">It may have been removed by its owner.</Message>;
  }
  if (view.status === "login_required") {
    return (
      <Message title="Sign in to view this session">
        It's shared with specific GitHub users or groups.
        <div className="actions">
          <SignInButton primary />
        </div>
      </Message>
    );
  }
  if (view.status === "forbidden") {
    return (
      <Message title="You don't have access to this session">
        {view.stale ? (
          "Checking your GitHub org and team membership…"
        ) : (
          <>
            You're signed in as <strong>{view.signedInAs}</strong>. If you were added to an org or team recently, or
            your org hasn't approved Opticon yet, ask the owner or an org admin.
          </>
        )}
        {!isLocal() && (
          <div className="actions">
            <button type="button" className="button" onClick={signOut}>
              Use a different account
            </button>
          </div>
        )}
      </Message>
    );
  }

  const { share, owner, viewers } = view;
  const live = Date.now() - share.updatedAt < 120_000;
  return (
    <>
      <header className="session-header">
        <div className="session-title">
          <h1>{share.title ?? "Untitled session"}</h1>
          <div className="session-meta">
            <ProviderIcon provider={share.provider} />
            {owner && (
              <Link href={`/u/${owner.login}`} className="owner">
                {owner.avatarUrl && <img src={owner.avatarUrl} alt="" />}
                {owner.login}
              </Link>
            )}
            {share.project && <span>{share.project}</span>}
            <span>Updated {formatTime(new Date(share.updatedAt).toISOString())}</span>
          </div>
        </div>
        <span className="presence">
          {live && <span className="live-dot" />}
          {viewers} watching
        </span>
        {(!token || share.following !== undefined) && <FollowButton slug={slug} token={token} following={share.following} />}
      </header>
      <Transcript events={(events ?? []) as SessionEvent[]} status={events ? "ready" : "loading"} />
    </>
  );
}

/** Signed in, follows live in the account; signed out, in this browser's history. */
function FollowButton({ slug, token, following }: { slug: string; token?: string; following?: boolean }) {
  const setFollowing = useMutation(api.follows.setFollowing);
  const local = useLocalHistory().find((e) => e.slug === slug);
  const current = token ? following : local?.following;
  const toggle = () => {
    if (token) void setFollowing({ token, slug, following: !current });
    else setLocalFollowing(slug, !current);
  };
  return (
    <button
      type="button"
      className="button"
      title={current ? "Remove from your Following list" : "Add to your Following list"}
      onClick={toggle}
    >
      {current ? "Unfollow" : "Follow"}
    </button>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page narrow center">
      <h2>{title}</h2>
      <div className="dim">{children}</div>
    </div>
  );
}

/**
 * Loads every event by paging through changes from rev 0, then keeps one subscription open at
 * the latest rev. Each change replaces an event by id; order comes from the event's fixed seq.
 */
function useShareEvents(slug: string, token: string | undefined, enabled: boolean): SharedEvent[] | undefined {
  const client = useConvex();
  const [events, setEvents] = useState<SharedEvent[]>();

  useEffect(() => {
    if (!enabled) return;
    const byId = new Map<string, { seq: number; event: SharedEvent }>();
    let cursor = 0;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    type Page = NonNullable<typeof api.shares.changes._returnType>;

    const apply = (page: Page) => {
      for (const { seq, event } of page.events) byId.set(event.id, { seq, event: event as SharedEvent });
      cursor = page.rev;
      setEvents([...byId.values()].sort((a, b) => a.seq - b.seq).map((e) => e.event));
    };
    const follow = () => {
      const watch = client.watchQuery(api.shares.changes, { slug, token, afterRev: cursor });
      const check = () => {
        const page = watch.localQueryResult();
        if (cancelled || !page?.events.length) return;
        unsubscribe?.();
        apply(page);
        follow();
      };
      unsubscribe = watch.onUpdate(check);
      check();
    };

    void (async () => {
      for (;;) {
        const page = await client.query(api.shares.changes, { slug, token, afterRev: cursor });
        if (cancelled || !page) return;
        apply(page);
        if (!page.more) break;
      }
      follow();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client, slug, token, enabled]);

  return events;
}

/** Tells the owner's daemon someone is watching, which turns on live sync for this share. */
function usePresence(slug: string, token: string | undefined, enabled: boolean): void {
  const heartbeat = useMutation(api.presence.heartbeat);
  const leave = useMutation(api.presence.leave);
  useEffect(() => {
    if (!enabled) return;
    const viewerId = sessionStorage.getItem("opticon_viewer") ?? crypto.randomUUID();
    sessionStorage.setItem("opticon_viewer", viewerId);
    const beat = () => void heartbeat({ slug, viewerId, token }).catch(() => {});
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    const onHide = () => void leave({ slug, viewerId, token });
    addEventListener("pagehide", onHide);
    return () => {
      clearInterval(timer);
      removeEventListener("pagehide", onHide);
      onHide();
    };
  }, [slug, token, enabled, heartbeat, leave]);
}

/** Signed out, records the view in this browser's history. Signed-in views are recorded by presence heartbeats. */
function useLocalVisit(slug: string, token: string | undefined, eventCount: number | undefined): void {
  useEffect(() => {
    if (!token && eventCount !== undefined) recordLocalVisit(slug, eventCount);
  }, [slug, token, eventCount]);
}

function useMembershipRefresh(token: string | undefined, needed: boolean): void {
  const refresh = useAction(api.access.refreshMemberships);
  useEffect(() => {
    if (needed && token) void refresh({ token }).catch(() => {});
  }, [needed, token, refresh]);
}
