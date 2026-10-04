import type { Provider, SessionMeta } from "@opticon/core";
import { useMemo, useState } from "react";
import { dayLabel, isLive, projectName, relativeTime, useNow } from "../format";
import { sessionKey } from "./api";
import { type Project, ProjectPicker } from "./ProjectPicker";
import { ProviderIcon } from "../ProviderIcon";

const PAGE = 200;

export function SessionList(props: {
  sessions: SessionMeta[];
  shared: Set<string>;
  loading: boolean;
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Set<string>>(new Set());
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  const now = useNow(30_000);

  // Distinct project directories, most recently active first.
  const allProjects = useMemo(() => {
    const byCwd = new Map<string, Project & { updatedAt: string }>();
    for (const s of props.sessions) {
      if (!s.cwd) continue;
      const p = byCwd.get(s.cwd) ?? { cwd: s.cwd, sessions: 0, updatedAt: "" };
      p.sessions++;
      if ((s.updatedAt ?? "") > p.updatedAt) p.updatedAt = s.updatedAt!;
      byCwd.set(s.cwd, p);
    }
    return [...byCwd.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [props.sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.sessions.filter(
      (s) =>
        (provider === "all" || s.provider === provider) &&
        (!projects.size || (s.cwd !== undefined && projects.has(s.cwd))) &&
        (!q || s.title?.toLowerCase().includes(q) || s.cwd?.toLowerCase().includes(q)),
    );
  }, [props.sessions, query, provider, projects]);

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const groups: [string, SessionMeta[]][] = [];
  for (const s of filtered.slice(0, limit)) {
    const label = dayLabel(s.updatedAt);
    if (groups.at(-1)?.[0] !== label) groups.push([label, []]);
    groups.at(-1)![1].push(s);
  }

  return (
    <>
      <div className="sidebar-top">
        <div className="filter-row">
          <div className="segmented" role="tablist">
            {(["all", "claude", "codex"] as const).map((p) => (
              <button key={p} type="button" role="tab" aria-selected={provider === p} onClick={() => setProvider(p)}>
                {p === "all" ? "All" : <ProviderIcon provider={p} />}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="filter-button"
            aria-label="Search sessions"
            title="Search sessions"
            aria-pressed={searching}
            onClick={() => (searching ? closeSearch() : setSearching(true))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.4 10.4 3.6 3.6" />
            </svg>
          </button>
          <ProjectPicker projects={allProjects} selected={projects} onChange={setProjects} />
        </div>
        {searching && (
          <input
            className="search"
            placeholder="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
            aria-label="Search sessions"
            autoFocus
          />
        )}
        {projects.size > 0 && (
          <div className="filter-chips">
            {[...projects].map((cwd) => (
              <span key={cwd} className="chip" title={cwd}>
                <span className="truncate">{projectName(cwd)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${projectName(cwd)} filter`}
                  onClick={() => setProjects(new Set([...projects].filter((p) => p !== cwd)))}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m4.5 4.5 7 7m0-7-7 7" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="session-list">
        {props.loading && !props.sessions.length && <p className="hint">Indexing sessions…</p>}
        {!props.loading && !filtered.length && <p className="hint">No sessions match.</p>}
        {groups.map(([label, items]) => (
          <section key={label}>
            <h3 className="group-label">{label}</h3>
            {items.map((s) => {
              const key = sessionKey(s);
              return (
                <button
                  key={key}
                  type="button"
                  className="session-item"
                  aria-current={props.selected === key}
                  onClick={() => props.onSelect(key)}
                >
                  <span className="session-item-title">
                    {isLive(s.updatedAt, now) && <span className="live-dot" title="Active in the last 2 minutes" />}
                    <span className="truncate">{s.title ?? "Untitled session"}</span>
                  </span>
                  <span className="session-item-meta">
                    <ProviderIcon provider={s.provider} size={12} />
                    {s.cwd && <span className="truncate">{projectName(s.cwd)}</span>}
                    <span className="spacer" />
                    {props.shared.has(key) && <span className="shared-mark">Shared</span>}
                    <span>{relativeTime(s.updatedAt, now)}</span>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {filtered.length > limit && (
          <button type="button" className="button subtle more" onClick={() => setLimit(limit + PAGE)}>
            Show more ({filtered.length - limit})
          </button>
        )}
      </div>
    </>
  );
}
