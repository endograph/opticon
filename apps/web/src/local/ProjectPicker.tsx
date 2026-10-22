import { useEffect, useMemo, useRef, useState } from "react";
import { projectName } from "../format";

export interface Project {
  cwd: string;
  sessions: number;
}

/**
 * Scores `text` against `query` as an in-order, case-insensitive subsequence, or null when it isn't one.
 * Consecutive letters and letters at the start of a word score higher; shorter texts win ties.
 */
function fuzzyScore(query: string, text: string): number | null {
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of query) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += 1 + (i === prev + 1 ? 2 : 0) + (i === 0 || /[^a-z0-9]/.test(t[i - 1]!) ? 2 : 0);
    prev = i;
    from = i + 1;
  }
  return score - t.length / 1000;
}

/** Projects matching `query`, best first. A match on the project's name outranks one on its full path. */
function searchProjects(projects: Project[], query: string): Project[] {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return projects;
  return projects
    .flatMap((p) => {
      const name = fuzzyScore(q, projectName(p.cwd));
      const score = name !== null ? name + 1000 : fuzzyScore(q, p.cwd);
      return score === null ? [] : [{ p, score }];
    })
    .sort((a, b) => b.score - a.score)
    .map((m) => m.p);
}

/** Icon button that opens a multi-select list of projects. Selection is keyed by directory. */
export function ProjectPicker(props: {
  projects: Project[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return setQuery("");
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const matches = useMemo(() => searchProjects(props.projects, query), [props.projects, query]);

  const toggle = (cwd: string) => {
    const next = new Set(props.selected);
    if (!next.delete(cwd)) next.add(cwd);
    props.onChange(next);
  };

  return (
    <div className="project-picker" ref={root}>
      <button
        type="button"
        className="filter-button"
        aria-label="Filter by project"
        title="Filter by project"
        aria-haspopup="true"
        aria-expanded={open}
        data-active={props.selected.size > 0}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />
        </svg>
      </button>
      {open && (
        <div className="popover" role="group" aria-label="Projects">
          {props.projects.length > 0 && (
            <input
              className="search popover-search"
              placeholder="Find a project"
              aria-label="Find a project"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && matches[0] && toggle(matches[0].cwd)}
              autoFocus
            />
          )}
          {!props.projects.length && <p className="hint">No projects yet.</p>}
          {props.projects.length > 0 && !matches.length && <p className="hint">No projects match.</p>}
          <div className="popover-list">
            {matches.map((p) => (
              <label key={p.cwd} className="popover-option" title={p.cwd}>
                <input type="checkbox" checked={props.selected.has(p.cwd)} onChange={() => toggle(p.cwd)} />
                <span className="truncate">{projectName(p.cwd)}</span>
                <span className="spacer" />
                <span className="count">{p.sessions}</span>
              </label>
            ))}
          </div>
          {props.selected.size > 0 && (
            <button type="button" className="popover-footer" onClick={() => props.onChange(new Set())}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
