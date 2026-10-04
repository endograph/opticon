import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect } from "react";
import { isLive, relativeTime, useNow } from "../format";
import { Link } from "../router";
import { ProviderIcon } from "../ProviderIcon";
import { config, INSTALL_COMMAND, setPageTitle } from "../config";
import { CopyCommand } from "../CopyCommand";

type PublicShare = FunctionReturnType<typeof api.shares.feed>[number];
type ActiveRepo = FunctionReturnType<typeof api.shares.activeRepos>[number];

const HOME_REPOS = 6;

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

/** The busiest repos this week, for the home page. */
export function ActiveRepos() {
  const repos = useQuery(api.shares.activeRepos, { limit: HOME_REPOS });
  if (!repos?.length) return null;
  return (
    <section className="feed">
      <h2>
        Active repos <Link href="/repos" className="section-link">All repos</Link>
      </h2>
      <RepoList repos={repos} />
    </section>
  );
}

/** Every repo with public sessions this week. */
export function ReposPage() {
  const repos = useQuery(api.shares.activeRepos, {});
  useEffect(() => {
    setPageTitle("Repos");
  }, []);
  return (
    <div className="page">
      <header className="page-header">
        <h1>Repos</h1>
        <p className="dim">
          Public GitHub repos with sessions this week, shared by people who can push to them. Sessions land here when
          you autosync or share in a repo.
        </p>
      </header>
      {repos === undefined ? (
        <p className="hint">Loading…</p>
      ) : repos.length ? (
        <RepoList repos={repos} />
      ) : (
        <p className="hint">No repo has public sessions this week.</p>
      )}
    </div>
  );
}

function RepoList({ repos }: { repos: ActiveRepo[] }) {
  const now = useNow(30_000);
  return (
    <ul className="share-list">
      {repos.map((r) => (
        <li key={r.repo} className="share-row">
          <div className="share-row-main">
            <Link href={`/gh/${r.repo}`} className="share-row-title">
              {r.repo}
            </Link>
            <div className="session-meta">
              <span>
                {r.sessions} {r.sessions === 1 ? "session" : "sessions"} this week
              </span>
              <span className="avatars" title={r.contributors.map((c) => c.login).join(", ")}>
                {r.contributors.slice(0, 5).map((c) => (c.avatarUrl ? <img key={c.login} src={c.avatarUrl} alt={c.login} /> : null))}
                {r.contributors.length} {r.contributors.length === 1 ? "contributor" : "contributors"}
              </span>
              <span>active {relativeTime(new Date(r.updatedAt).toISOString(), now)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
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
  // A project with a verified repo links to the repo page, where everyone's sessions are.
  const projects = new Map<string, { count: number; repo?: string }>();
  for (const s of shares) {
    if (!s.project) continue;
    const entry = projects.get(s.project) ?? { count: 0 };
    entry.count += 1;
    entry.repo ??= s.repo;
    projects.set(s.project, entry);
  }
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
          {[...projects].map(([project, { count, repo }]) => (
            <Link
              key={project}
              href={repo ? `/gh/${repo}` : projectHref(user.login, project)}
              className="project-chip"
              title={repo ? `Everyone's sessions in ${repo}` : undefined}
            >
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
        <div className="repo-empty">
          <p>
            <strong>No public sessions yet.</strong> Contribute to {repo}? Share your Claude Code and Codex sessions
            here: install Opticon, sign in, and autosync your clone. They show up once GitHub confirms you can push to
            the repo.
          </p>
          <CopyCommand command={INSTALL_COMMAND} />
          <CopyCommand command="opticon login && opticon autosync" />
        </div>
      )}
      <RepoBadge repo={repo} />
    </div>
  );
}

/** The README badge for a repo, with the snippet to copy. */
function RepoBadge({ repo }: { repo: string }) {
  const markdown = `[![Opticon sessions](${config.webUrl}/badge/gh/${repo}.svg)](${config.webUrl}/gh/${repo})`;
  return (
    <section className="repo-badge">
      <h2>Badge</h2>
      <p className="dim">Link your README to this page. The badge shows how many public sessions the repo has.</p>
      {/* Previewed from the backend directly: only opticon.tv proxies /badge. */}
      <img src={`${config.siteUrl}/badge/gh/${repo}.svg`} alt="Opticon sessions badge" />
      <CopyCommand command={markdown} prompt={false} />
    </section>
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
