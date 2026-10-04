import { useEffect, useRef, useState } from "react";
import { projectName } from "../format";

export interface Project {
  cwd: string;
  sessions: number;
}

/** Icon button that opens a multi-select list of projects. Selection is keyed by directory. */
export function ProjectPicker(props: {
  projects: Project[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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
          {!props.projects.length && <p className="hint">No projects yet.</p>}
          <div className="popover-list">
            {props.projects.map((p) => (
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
