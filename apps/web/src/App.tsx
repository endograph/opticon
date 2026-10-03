import { useEffect, useState } from "react";
import { type Status, sessionKey, useSession, useSessionList } from "./api";
import { SessionList } from "./SessionList";
import { SharePreviewDialog } from "./SharePreview";
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
  const { sessions, status } = useSessionList();
  const [selected, select] = useRoute();
  const session = useSession(selected);
  const [sharing, setSharing] = useState(false);

  const meta = session.meta ?? sessions.find((s) => sessionKey(s) === selected);
  useEffect(() => {
    document.title = meta?.title ? `${meta.title} · Opticon` : "Opticon";
  }, [meta?.title]);

  if (status === "unauthorized" || status === "offline") return <Blocked status={status} />;

  return (
    <div className="app">
      <SessionList sessions={sessions} loading={status === "loading"} selected={selected} onSelect={select} />
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
              <button type="button" className="button" disabled={session.status !== "ready"} onClick={() => setSharing(true)}>
                Share…
              </button>
            </header>
            <Transcript key={selected} events={session.events} status={session.status} />
            {sharing && <SharePreviewDialog sessionKey={selected} onClose={() => setSharing(false)} />}
          </>
        )}
      </main>
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
