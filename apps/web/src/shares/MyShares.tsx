import { PRIVATE_ACCESS } from "@opticon/core/protocol";
import { api } from "@opticon/server/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { describeAccess, isPrivate, useAccessEditor } from "../AccessEditor";
import { config, isLocal } from "../config";
import { relativeTime } from "../format";
import { SignInButton, useIdentity, useToken } from "../identity";
import { Link } from "../router";
import { ProviderIcon } from "../ProviderIcon";
import { ProjectLink } from "./Discover";

type Share = FunctionReturnType<typeof api.shares.mine>[number];

/**
 * Everything you've shared, with viewers, access, and unsharing. Works on opticon.tv too:
 * these only touch the server copy. Creating or resyncing a share needs the local app, because
 * only your machine has the session.
 */
export function MyShares() {
  const token = useToken();
  const shares = useQuery(api.shares.mine, token ? { token } : "skip");

  if (!token) {
    return (
      <div className="empty">
        <h2>My shares</h2>
        <p>Sign in to see the sessions you've shared.</p>
        <SignInButton primary />
      </div>
    );
  }

  const sorted = [...(shares ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="page">
      <header className="page-header">
        <h1>My shares</h1>
        <p className="dim">
          Shares are copies on the server. Unsharing makes a copy private; deleting removes it, and auto sync won't
          upload that session again.{" "}
          {isLocal() ? (
            "To share another session, open it under Local sessions."
          ) : (
            <>
              To share a session, run <code>opticon web</code> on your machine.
            </>
          )}
        </p>
      </header>
      {!shares && <p className="hint">Loading…</p>}
      {shares && !sorted.length && <p className="hint">You haven't shared any sessions yet.</p>}
      <ul className="share-list">
        {sorted.map((share) => (
          <ShareRow key={share.shareId} share={share} token={token} />
        ))}
      </ul>
    </div>
  );
}

function ShareRow({ share, token }: { share: Share; token: string }) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const remove = useMutation(api.shares.remove);
  const setAccess = useMutation(api.shares.setAccess);
  const setListed = useMutation(api.shares.setListed);
  const { me } = useIdentity();
  const privateShare = isPrivate(share.access);
  const url = `${config.webUrl}/s/${share.slug}`;

  return (
    <li className="share-row">
      <div className="share-row-main">
        <Link href={`/s/${share.slug}`} className="share-row-title">
          {share.title ?? "Untitled session"}
        </Link>
        <div className="session-meta">
          <ProviderIcon provider={share.provider} />
          <ProjectLink project={share.project} repo={share.repo} login={me?.login} />
          <span>{describeAccess(share.access)}</span>
          {share.listed && <span title="On your profile, the repo page, and the feed">listed</span>}
          {share.auto && <span title="Created by autosync">auto</span>}
          <span>{share.eventCount} events</span>
          <span>updated {relativeTime(new Date(share.updatedAt).toISOString())}</span>
          {share.viewers > 0 && (
            <span className="presence">
              <span className="live-dot" />
              {share.viewers} watching
            </span>
          )}
        </div>
      </div>
      <div className="share-row-actions">
        {isLocal() && (
          <Link href={`/local/${share.provider}/${share.sessionId}`} className="button subtle">
            Open session
          </Link>
        )}
        <button
          type="button"
          className="button"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" className="button" onClick={() => setEditing(!editing)} aria-expanded={editing}>
          Access…
        </button>
        <button
          type="button"
          className="button"
          title={share.listed
            ? "Remove from your profile, the repo page, and the feed"
            : "Show on your profile, the repo page, and the feed, to people who can open it"}
          onClick={() => void setListed({ token, shareId: share.shareId, listed: !share.listed })}
        >
          {share.listed ? "Unlist" : "List"}
        </button>
        {!privateShare && (
          <button
            type="button"
            className="button"
            title="Only you can open it. The copy stays and keeps syncing."
            onClick={() => void setAccess({ token, shareId: share.shareId, access: PRIVATE_ACCESS })}
          >
            Unshare
          </button>
        )}
        <button
          type="button"
          className="button danger"
          onClick={() => {
            if (confirm(`Delete "${share.title ?? "this session"}" from the server? The link stops working, and auto sync won't upload it again.`)) {
              void remove({ token, shareId: share.shareId });
            }
          }}
        >
          Delete
        </button>
      </div>
      {editing && <AccessForm share={share} token={token} onDone={() => setEditing(false)} />}
    </li>
  );
}

function AccessForm({ share, token, onDone }: { share: Share; token: string; onDone: () => void }) {
  const { access, empty, editor } = useAccessEditor(share.access);
  const setAccess = useMutation(api.shares.setAccess);
  const [error, setError] = useState<string>();
  return (
    <div className="share-row-editor">
      {editor}
      {error && <p className="notice error">{error}</p>}
      <div className="actions-row">
        <button type="button" className="button subtle" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={empty}
          onClick={() => setAccess({ token, shareId: share.shareId, access }).then(onDone, (e: Error) => setError(e.message))}
        >
          Save access
        </button>
      </div>
    </div>
  );
}
