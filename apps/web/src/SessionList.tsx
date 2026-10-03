import type { Provider, SessionMeta } from "@opticon/core";
import { useEffect, useMemo, useState } from "react";
import { sessionKey } from "./api";
import { dayLabel, isLive, projectName, relativeTime } from "./format";

const PAGE = 200;

export function SessionList(props: {
  sessions: SessionMeta[];
  loading: boolean;
  selected?: string;
  onSelect: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [limit, setLimit] = useState(PAGE);
  const now = useNow(30_000);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.sessions.filter(
      (s) =>
        (provider === "all" || s.provider === provider) &&
        (!q || s.title?.toLowerCase().includes(q) || s.cwd?.toLowerCase().includes(q)),
    );
  }, [props.sessions, query, provider]);

  const groups: [string, SessionMeta[]][] = [];
  for (const s of filtered.slice(0, limit)) {
    const label = dayLabel(s.updatedAt);
    if (groups.at(-1)?.[0] !== label) groups.push([label, []]);
    groups.at(-1)![1].push(s);
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <input
          className="search"
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sessions"
        />
        <div className="segmented" role="tablist">
          {(["all", "claude", "codex"] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={provider === p} onClick={() => setProvider(p)}>
              {p === "all" ? "All" : p === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
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
                    <span className={`provider-mark ${s.provider}`}>{s.provider === "claude" ? "Claude" : "Codex"}</span>
                    {s.cwd && <span className="truncate">{projectName(s.cwd)}</span>}
                    <span className="spacer" />
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
    </nav>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
