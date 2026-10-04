import type { Provider, SessionMeta } from "@opticon/core";
import { useMemo, useState } from "react";
import { dayLabel, isLive, projectName, relativeTime, useNow } from "../format";
import { sessionKey } from "./api";
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
  const [project, setProject] = useState<string>();
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  const now = useNow(30_000);

  // Distinct project directories, most recently active first (sessions arrive newest first).
  const projects = useMemo(
    () => [...new Set(props.sessions.flatMap((s) => (s.cwd ? [s.cwd] : [])))],
    [props.sessions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.sessions.filter(
      (s) =>
        (provider === "all" || s.provider === provider) &&
        (!project || s.cwd === project) &&
        (!q || s.title?.toLowerCase().includes(q) || s.cwd?.toLowerCase().includes(q)),
    );
  }, [props.sessions, query, provider, project]);

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
          {/* The select sits invisibly over the icon so a click opens the native picker directly. */}
          <label className="filter-button" title="Filter by project" data-active={!!project}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
            </svg>
            <select aria-label="Filter by project" value={project ?? ""} onChange={(e) => setProject(e.target.value || undefined)}>
              <option value="">All projects</option>
              {projects.map((cwd) => (
                <option key={cwd} value={cwd}>
                  {projectName(cwd)}
                </option>
              ))}
            </select>
          </label>
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
        {project && (
          <div className="filter-chips">
            <span className="chip" title={project}>
              <span className="truncate">{projectName(project)}</span>
              <button type="button" aria-label="Clear project filter" onClick={() => setProject(undefined)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 4.5 7 7m0-7-7 7" />
                </svg>
              </button>
            </span>
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
