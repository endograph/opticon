import { api } from "@opticon/server/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect } from "react";
import { isLive, relativeTime, useNow } from "../format";
import { SignInButton, useToken } from "../identity";
import { Link } from "../router";
import { clearLocalHistory, readLocalHistory, setLocalFollowing, useLocalHistory } from "./localHistory";
import { ProviderIcon } from "../ProviderIcon";

type Followed = FunctionReturnType<typeof api.follows.list>[number];
type Available = Extract<Followed, { available: true }>;

const SIDEBAR_LIMIT = 15;

/**
 * Followed shares, most recently viewed first: the account's when signed in, otherwise this
 * browser's history with details looked up from the server.
 */
function useFollowing(): { follows: Followed[] | undefined; unfollow: (slug: string) => void } {
  const token = useToken();
  const accountFollows = useQuery(api.follows.list, token ? { token } : "skip");
  const setFollowing = useMutation(api.follows.setFollowing);
  const entries = useLocalHistory().filter((e) => e.following);
  const shares = useQuery(api.follows.resolve, token ? "skip" : { slugs: entries.map((e) => e.slug) });

  if (token) return { follows: accountFollows, unfollow: (slug) => void setFollowing({ token, slug, following: false }) };
  const follows = shares?.flatMap((share): Followed[] => {
    const entry = entries.find((e) => e.slug === share.slug);
    if (!entry) return [];
    const unread = share.available ? Math.max(0, share.eventCount - (entry.seenEventCount ?? share.eventCount)) : 0;
    return [{ ...share, lastViewedAt: entry.lastViewedAt, unread }];
  });
  return {
    follows: follows?.sort((a, b) => b.lastViewedAt - a.lastViewedAt),
    unfollow: (slug) => setLocalFollowing(slug, false),
  };
}

/** Sessions others shared that you've opened. Opening a share follows it. */
export function Following() {
  const token = useToken();
  const { follows, unfollow } = useFollowing();
  const now = useNow(30_000);
  return (
    <div className="page">
      <header className="page-header">
        <h1>Following</h1>
        <p className="dim">
          {token ? (
            "Sessions shared with you that you've opened. Unfollow to remove one from this list."
          ) : (
            <>
              Saved in this browser only. <SignInButton /> to keep your history across devices.
            </>
          )}
        </p>
      </header>
      {!follows && <p className="hint">Loading…</p>}
      {follows && !follows.length && <p className="hint">Sessions you open from someone's share link will show up here.</p>}
      <ul className="share-list">
        {follows?.map((f) => (
          <li key={f.slug} className={`share-row ${f.available ? "" : "unavailable"}`}>
            <div className="share-row-main">
              <Link href={`/s/${f.slug}`} className="share-row-title">
                {f.available ? (f.title ?? "Untitled session") : "Session no longer available to you"}
              </Link>
              <div className="session-meta">
                {f.available ? <FollowedMeta share={f} now={now} /> : <span>Its owner changed who can view it</span>}
                <span>viewed {relativeTime(new Date(f.lastViewedAt).toISOString(), now)}</span>
              </div>
            </div>
            <div className="share-row-actions">
              <button type="button" className="button" onClick={() => unfollow(f.slug)}>
                Unfollow
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FollowedMeta({ share, now }: { share: Available; now: number }) {
  const updated = new Date(share.updatedAt).toISOString();
  return (
    <>
      <ProviderIcon provider={share.provider} />
      {share.owner && (
        <Link href={`/u/${share.owner.login}`} className="owner">
          {share.owner.avatarUrl && <img src={share.owner.avatarUrl} alt="" />}
          {share.owner.login}
        </Link>
      )}
      {share.project && <span>{share.project}</span>}
      {share.unread > 0 && <span className="unread-mark">{share.unread} new</span>}
      {(isLive(updated, now) || share.viewers > 0) && (
        <span className="presence">
          {isLive(updated, now) && <span className="live-dot" />}
          {share.viewers} watching
        </span>
      )}
      <span>updated {relativeTime(updated, now)}</span>
    </>
  );
}

/** Followed sessions in the sidebar, most recently active first, for switching between them. */
export function FollowingSidebar({ current }: { current?: string }) {
  const { follows } = useFollowing();
  const now = useNow(30_000);
  const items = (follows ?? [])
    .filter((f): f is Available => f.available)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SIDEBAR_LIMIT);
  if (!items.length) return null;
  return (
    <div className="session-list">
      <h3 className="group-label">Following</h3>
      {items.map((f) => {
        const updated = new Date(f.updatedAt).toISOString();
        // The open share is being watched; its count lags until the next heartbeat.
        const unread = f.slug === current ? 0 : f.unread;
        return (
          <Link key={f.slug} href={`/s/${f.slug}`} className="session-item" aria-current={f.slug === current}>
            <span className="session-item-title">
              {isLive(updated, now) && <span className="live-dot" title="Active in the last 2 minutes" />}
              <span className="truncate">{f.title ?? "Untitled session"}</span>
            </span>
            <span className="session-item-meta">
              <ProviderIcon provider={f.provider} size={12} />
              {f.owner && <span className="truncate">{f.owner.login}</span>}
              <span className="spacer" />
              {unread > 0 && <span className="unread-mark">{unread} new</span>}
              <span>{relativeTime(updated, now)}</span>
            </span>
          </Link>
        );
      })}
      {(follows?.length ?? 0) > items.length && (
        <Link href="/following" className="nav-item">
          All followed sessions
        </Link>
      )}
    </div>
  );
}

/** After sign-in, moves this browser's history into the account. Cleared only once the import succeeds. */
export function useImportLocalHistory(token: string | undefined): void {
  const importLocal = useMutation(api.follows.importLocal);
  useEffect(() => {
    const entries = readLocalHistory();
    if (!token || !entries.length) return;
    void importLocal({ token, entries }).then(clearLocalHistory, () => {});
  }, [token, importLocal]);
}
