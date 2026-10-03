import { useEffect, useState } from "react";
import { type Account, type Status, sessionKey, setLiveSync, useSession, useSessionList } from "./api";
import { SessionList } from "./SessionList";
import { ShareDialog } from "./ShareDialog";
import { Transcript } from "./Transcript";
import { formatTime, projectName } from "./format";

/** Routes: `/` and `/s/<provider>/<id>`. */
function useRoute(): [string | undefined, (key: string) => void] {
  const parse = () => location.pathname.match(/^\/s\/(\w+\/[\w-]+)$/)?.[1];
  const [key, setKey] = useState(parse);
  useEffect(() => {
    const onPop = () => setKey(parse());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = (next: string) => {
    history.pushState(null, "", `/s/${next}`);
    setKey(next);
  };
  return [key, navigate];
}

export function App() {
  const { sessions, status, account, shares } = useSessionList();
  const [selected, select] = useRoute();
  const session = useSession(selected);
  const [sharing, setSharing] = useState(false);

  const meta = session.meta ?? sessions.find((s) => sessionKey(s) === selected);
  const sharedKeys = new Set(shares.map((s) => `${s.provider}/${s.sessionId}`));
  const share = shares.find((s) => `${s.provider}/${s.sessionId}` === selected);
  useEffect(() => {
    document.title = meta?.title ? `${meta.title} · Opticon` : "Opticon";
  }, [meta?.title]);

  if (status === "unauthorized" || status === "offline") return <Blocked status={status} />;

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        shared={sharedKeys}
        loading={status === "loading"}
        selected={selected}
        onSelect={select}
        footer={<AccountFooter account={account} />}
      />
      <main className="main">
        {!selected ? (
          <div className="empty">
            <h2>Opticon</h2>
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
      </main>
    </div>
  );
}

function AccountFooter({ account }: { account?: Account }) {
  // Optimistic: show the new value at once; the server's value wins when it arrives.
  const [liveSync, setLocalLiveSync] = useState(account?.liveSync ?? true);
  useEffect(() => setLocalLiveSync(account?.liveSync ?? true), [account?.liveSync]);
  if (!account?.configured) return null;
  if (!account.signedIn) {
    return (
      <p className="hint">
        Run <code>opticon login</code> to share sessions.
      </p>
    );
  }
  return (
    <div className="account">
      <span className="truncate">
        Signed in as <strong>{account.login}</strong>
      </span>
      <label className="toggle" title="Stream new messages to shared sessions while someone is viewing">
        <input
          type="checkbox"
          checked={liveSync}
          onChange={(e) => {
            setLocalLiveSync(e.target.checked);
            void setLiveSync(e.target.checked);
          }}
        />
        Live sync shared sessions
      </label>
    </div>
  );
}

function Blocked({ status }: { status: Status }) {
  return (
    <div className="blocked">
      <h2>{status === "offline" ? "The Opticon daemon isn't running" : "Not connected to this machine"}</h2>
      <p>
        Run <code>opticon web</code> in a terminal to {status === "offline" ? "start it" : "connect this browser"}.
      </p>
    </div>
  );
}
