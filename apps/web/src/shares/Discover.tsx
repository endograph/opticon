import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect } from "react";
import { isLive, relativeTime, useNow } from "../format";
import { Link } from "../router";
import { ProviderIcon } from "../ProviderIcon";

type PublicShare = FunctionReturnType<typeof api.shares.feed>[number];

/** Recently active public sessions from everyone, for the home page. */
export function Feed() {
  const shares = useQuery(api.shares.feed, {});
  if (!shares?.length) return null;
  return (
    <section className="feed">
      <h2>Recent public sessions</h2>
      <PublicShareList shares={shares} showOwner />
    </section>
  );
}

/** A user's discoverable sessions. */
export function Profile({ login }: { login: string }) {
  const profile = useQuery(api.shares.profile, { login });
  useEffect(() => {
    document.title = `${login} · Opticon`;
  }, [login]);

  if (profile === undefined) return <p className="hint page">Loading…</p>;
  if (profile === null) {
    return (
      <div className="empty">
        <h2>No such user</h2>
        <p>{login} hasn't signed in to Opticon.</p>
      </div>
    );
  }
  const { user, shares } = profile;
  return (
    <div className="page">
      <header className="page-header profile-header">
        {user.avatarUrl && <img src={user.avatarUrl} alt="" />}
        <div>
          <h1>{user.name ?? user.login}</h1>
          {user.name && <p className="dim">{user.login}</p>}
        </div>
      </header>
      {shares.length ? <PublicShareList shares={shares} /> : <p className="hint">No public sessions yet.</p>}
    </div>
  );
}

function PublicShareList({ shares, showOwner = false }: { shares: PublicShare[]; showOwner?: boolean }) {
  const now = useNow(30_000);
  return (
    <ul className="share-list">
      {shares.map((share) => {
        const updated = new Date(share.updatedAt).toISOString();
        return (
          <li key={share.slug} className="share-row">
            <div className="share-row-main">
              <Link href={`/s/${share.slug}`} className="share-row-title">
                {share.title ?? "Untitled session"}
              </Link>
              <div className="session-meta">
                <ProviderIcon provider={share.provider} />
                {showOwner && share.owner && (
                  <Link href={`/u/${share.owner.login}`} className="owner">
                    {share.owner.avatarUrl && <img src={share.owner.avatarUrl} alt="" />}
                    {share.owner.login}
                  </Link>
                )}
                {share.project && <span>{share.project}</span>}
                {(isLive(updated, now) || share.viewers > 0) && (
                  <span className="presence">
                    {isLive(updated, now) && <span className="live-dot" />}
                    {share.viewers} watching
                  </span>
                )}
                <span>updated {relativeTime(updated, now)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
