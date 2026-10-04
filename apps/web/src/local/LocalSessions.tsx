import { useEffect, useState } from "react";
import { isPrivate } from "../AccessEditor";
import { Shell } from "../Shell";
import { Transcript } from "../Transcript";
import { formatTime, projectName } from "../format";
import { useIdentity } from "../identity";
import { Link, type Route, navigate } from "../router";
import { SessionList } from "./SessionList";
import { ShareDialog } from "./ShareDialog";
import { sessionKey, useSession, useSessionRepo } from "./api";
import { projectHref } from "../shares/Discover";
import { ProviderIcon } from "../ProviderIcon";
import { setPageTitle } from "../config";
import { useGithubUrl } from "../policy";

/** This machine's sessions. Only rendered in the local app, which is served by the daemon. */
export function LocalSessions({ route, selected }: { route: Route; selected?: string }) {
  const { daemon: daemonState, me } = useIdentity();
  const daemon = daemonState!;
  const { sessions, status, account, shares } = daemon;
  const session = useSession(selected);
  const [sharing, setSharing] = useState(false);
  const githubUrl = useGithubUrl();

  const meta = session.meta ?? sessions.find((s) => sessionKey(s) === selected);
  // Private copies (unshared, or auto synced without sharing) aren't marked as shared.
  const sharedKeys = new Set(shares.filter((s) => !isPrivate(s.access)).map((s) => `${s.provider}/${s.sessionId}`));
  const share = shares.find((s) => `${s.provider}/${s.sessionId}` === selected);
  // The verified (canonical) repo once shared, else the local remote.
  const localRepo = useSessionRepo(selected);
  const repo = share?.repo ?? localRepo;
  useEffect(() => {
    setPageTitle(meta?.title);
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
          <p>Your Claude Code and Codex sessions, read straight from this machine. Pick one from the list.</p>
        </div>
      ) : (
        <>
          <header className="session-header">
            <div className="session-title">
              <h1>{meta?.title ?? "Untitled session"}</h1>
              <div className="session-meta">
                {meta && <ProviderIcon provider={meta.provider} />}
                {repo ? (
                  <Link href={`/gh/${repo}`} className="project-link" title={`Public sessions in ${repo}`}>
                    {repo}
                  </Link>
                ) : meta?.cwd && me ? (
                  <Link href={projectHref(me.login, projectName(meta.cwd))} className="project-link" title={meta.cwd}>
                    {projectName(meta.cwd)}
                  </Link>
                ) : (
                  meta?.cwd && <span title={meta.cwd}>{projectName(meta.cwd)}</span>
                )}
                {meta?.gitBranch &&
                  (repo ? (
                    <a
                      className="mono project-link"
                      href={`${githubUrl}/${repo}/tree/${encodeURI(meta.gitBranch)}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Branch on GitHub"
                    >
                      {meta.gitBranch}
                    </a>
                  ) : (
                    <span className="mono">{meta.gitBranch}</span>
                  ))}
                {meta?.startedAt && <span>{formatTime(meta.startedAt)}</span>}
              </div>
            </div>
            {share && (
              <a className="share-badge" href={share.url} target="_blank" rel="noreferrer" title={share.url}>
                {isPrivate(share.access) ? "Synced · private" : "Shared"}
                {share.viewers > 0 ? ` · ${share.viewers} watching` : ""}
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
