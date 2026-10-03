import { useEffect, useState } from "react";
import { Shell } from "../Shell";
import { Transcript } from "../Transcript";
import { formatTime, projectName } from "../format";
import { useIdentity } from "../identity";
import { type Route, navigate } from "../router";
import { SessionList } from "./SessionList";
import { ShareDialog } from "./ShareDialog";
import { sessionKey, useSession } from "./api";

/** This machine's sessions. Only rendered in the local app, which is served by the daemon. */
export function LocalSessions({ route, selected }: { route: Route; selected?: string }) {
  const daemon = useIdentity().daemon!;
  const { sessions, status, account, shares } = daemon;
  const session = useSession(selected);
  const [sharing, setSharing] = useState(false);

  const meta = session.meta ?? sessions.find((s) => sessionKey(s) === selected);
  const sharedKeys = new Set(shares.map((s) => `${s.provider}/${s.sessionId}`));
  const share = shares.find((s) => `${s.provider}/${s.sessionId}` === selected);
  useEffect(() => {
    document.title = meta?.title ? `${meta.title} · Opticon` : "Opticon";
  }, [meta?.title]);

  return (
    <Shell
      route={route}
      sidebar={
        <SessionList
          sessions={sessions}
          shared={sharedKeys}
          loading={status === "loading"}
          selected={selected}
          onSelect={(key) => navigate(`/local/${key}`)}
        />
      }
    >
      {!selected ? (
        <div className="empty">
          <h2>Local sessions</h2>
          <p>Your Claude Code and Codex sessions, read straight from this machine. Pick one on the left.</p>
        </div>
      ) : (
        <>
          <header className="session-header">
            <div className="session-title">
              <h1>{meta?.title ?? "Untitled session"}</h1>
              <div className="session-meta">
                {meta && <span className={`badge ${meta.provider}`}>{meta.provider}</span>}
                {meta?.cwd && <span title={meta.cwd}>{projectName(meta.cwd)}</span>}
                {meta?.gitBranch && <span className="mono">{meta.gitBranch}</span>}
                {meta?.startedAt && <span>{formatTime(meta.startedAt)}</span>}
              </div>
            </div>
            {share && (
              <a className="share-badge" href={share.url} target="_blank" rel="noreferrer" title={share.url}>
                Shared{share.viewers > 0 ? ` · ${share.viewers} watching` : ""}
              </a>
            )}
            <button type="button" className="button" disabled={session.status !== "ready"} onClick={() => setSharing(true)}>
              {share ? "Manage…" : "Share…"}
            </button>
          </header>
          <Transcript key={selected} events={session.events} status={session.status} />
          {sharing && <ShareDialog sessionKey={selected} share={share} account={account} onClose={() => setSharing(false)} />}
        </>
      )}
    </Shell>
  );
}
