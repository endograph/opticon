import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect } from "react";
import { isLive, relativeTime, useNow } from "../format";
import { Link } from "../router";
import { ProviderIcon } from "../ProviderIcon";
import { setPageTitle } from "../config";

type PublicShare = FunctionReturnType<typeof api.shares.feed>[number];

export const projectHref = (login: string, project: string) => `/u/${login}/p/${encodeURIComponent(project)}`;

/** A share's project: its repo page when verified, else the owner's project page. */
export function ProjectLink({ project, repo, login }: { project?: string; repo?: string; login?: string }) {
  if (repo) return <Link href={`/gh/${repo}`} className="project-link">{repo}</Link>;
  if (project && login) return <Link href={projectHref(login, project)} className="project-link">{project}</Link>;
  return project ? <span>{project}</span> : null;
}

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
    setPageTitle(login);
  }, [login]);

  if (profile === undefined) return <p className="hint page">Loading…</p>;
  if (profile === null) return <NoSuchUser login={login} />;
  const { user, shares } = profile;
  const projects = new Map<string, number>();
  for (const s of shares) if (s.project) projects.set(s.project, (projects.get(s.project) ?? 0) + 1);
  return (
    <div className="page">
      <header className="page-header profile-header">
        {user.avatarUrl && <img src={user.avatarUrl} alt="" />}
        <div>
          <h1>{user.name ?? user.login}</h1>
          {user.name && <p className="dim">{user.login}</p>}
        </div>
      </header>
      {projects.size > 0 && (
        <nav className="project-chips" aria-label="Projects">
          {[...projects].map(([project, count]) => (
            <Link key={project} href={projectHref(user.login, project)} className="project-chip">
              {project}
              <span className="count">{count}</span>
            </Link>
          ))}
        </nav>
      )}
      {shares.length ? <PublicShareList shares={shares} /> : <p className="hint">No public sessions yet.</p>}
    </div>
  );
}

/** One user's discoverable sessions in one project. */
export function UserProject({ login, project }: { login: string; project: string }) {
  const page = useQuery(api.shares.userProject, { login, project });
  useEffect(() => {
    setPageTitle(`${project} · ${login}`);
  }, [login, project]);

  if (page === undefined) return <p className="hint page">Loading…</p>;
  if (page === null) return <NoSuchUser login={login} />;
  const { user, shares } = page;
  const repo = shares.find((s) => s.repo)?.repo;
  return (
    <div className="page">
      <header className="page-header profile-header">
        {user.avatarUrl && <img src={user.avatarUrl} alt="" />}
        <div>
          <h1>{project}</h1>
          <p className="dim">
            <Link href={`/u/${user.login}`} className="owner">{user.login}</Link>
            {repo && (
              <>
                {" · "}
                <Link href={`/gh/${repo}`} className="project-link">Everyone in {repo}</Link>
              </>
            )}
          </p>
        </div>
      </header>
      {shares.length ? <PublicShareList shares={shares} hideProject /> : <p className="hint">No public sessions in this project.</p>}
    </div>
  );
}

/** Discoverable sessions in a public GitHub repo, from everyone verified to push to it. */
export function RepoPage({ repo }: { repo: string }) {
  const shares = useQuery(api.shares.repoShares, { repo });
  useEffect(() => {
    setPageTitle(repo);
  }, [repo]);

  const contributors = new Map<string, string | undefined>();
  for (const s of shares ?? []) if (s.owner) contributors.set(s.owner.login, s.owner.avatarUrl);
  return (
    <div className="page">
      <header className="page-header">
        <h1>
          <a href={`https://github.com/${repo}`} className="repo-title" target="_blank" rel="noreferrer">
            {repo}
          </a>
        </h1>
        <p className="dim">Public sessions from people who can push to this repo.</p>
        {contributors.size > 0 && (
          <div className="contributors">
            {[...contributors].map(([login, avatarUrl]) => (
              <Link key={login} href={`/u/${login}`} className="owner" title={login}>
                {avatarUrl && <img src={avatarUrl} alt="" />}
                {login}
              </Link>
            ))}
          </div>
        )}
      </header>
      {shares === undefined ? (
        <p className="hint">Loading…</p>
      ) : shares.length ? (
        <PublicShareList shares={shares} showOwner hideProject />
      ) : (
        <p className="hint">No public sessions in this repo yet.</p>
      )}
    </div>
  );
}

function NoSuchUser({ login }: { login: string }) {
  return (
    <div className="empty">
      <h2>No such user</h2>
      <p>{login} hasn't signed in to Opticon.</p>
    </div>
  );
}

function PublicShareList({ shares, showOwner = false, hideProject = false }: { shares: PublicShare[]; showOwner?: boolean; hideProject?: boolean }) {
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
                {!hideProject && <ProjectLink project={share.project} repo={share.repo} login={share.owner?.login} />}
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
