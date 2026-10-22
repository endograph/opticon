import type { Artifact } from "@opticon/core/artifacts";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ArtifactLink } from "../Transcript";
import { formatTime } from "../format";
import { Link, navigate } from "../router";

/** The in-app deep link: the session with the artifact open. Without a version it follows the latest. */
export const artifactHref = (key: string, id: string, version?: number) =>
  `/local/${key}/a/${id}${version ? `?v=${version}` : ""}`;

/** The raw, sandboxed artifact the daemon serves. */
const rawUrl = (key: string, id: string, version: number) => `/artifacts/${key}/${id}?v=${version}`;

/** "Open" links for the tool calls that made each version. The latest version's link follows new ones. */
export function artifactLinks(key: string, artifacts: Artifact[]): Map<string, ArtifactLink[]> {
  const links = new Map<string, ArtifactLink[]>();
  for (const a of artifacts) {
    a.versions.forEach((v, i) => {
      const href = artifactHref(key, a.id, i + 1 === a.versions.length ? undefined : i + 1);
      links.set(v.eventId, [...(links.get(v.eventId) ?? []), { href, title: a.title }]);
    });
  }
  return links;
}

/** Header button listing the session's artifacts, newest change first. */
export function ArtifactsMenu({ sessionKey, artifacts }: { sessionKey: string; artifacts: Artifact[] }) {
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

  const sorted = [...artifacts].sort((a, b) => (b.versions.at(-1)?.timestamp ?? "").localeCompare(a.versions.at(-1)?.timestamp ?? ""));
  return (
    <div className="artifacts-menu" ref={root}>
      <button type="button" className="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        Artifacts · {artifacts.length}
      </button>
      {open && (
        <div className="popover" role="menu" aria-label="Artifacts">
          <div className="popover-list">
            {sorted.map((a) => (
              <Link
                key={a.id}
                role="menuitem"
                className="popover-option"
                href={artifactHref(sessionKey, a.id)}
                title={a.path ?? a.title}
                onClick={() => setOpen(false)}
              >
                <span className="artifact-kind">{a.kind === "markdown" ? "md" : a.kind}</span>
                <span className="truncate">{a.title}</span>
                <span className="spacer" />
                {a.versions.length > 1 && <span className="count">v{a.versions.length}</span>}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One artifact beside the transcript. HTML and SVG run in a sandboxed iframe without
 * allow-same-origin, so they get an opaque origin and can't reach the cookie-gated local API.
 * Markdown renders in the app.
 */
export function ArtifactPane({ sessionKey, artifact, version }: { sessionKey: string; artifact: Artifact; version?: number }) {
  const latest = artifact.versions.length;
  const shown = version && version <= latest ? version : latest;
  const raw = rawUrl(sessionKey, artifact.id, shown);
  const at = artifact.versions[shown - 1]?.timestamp;
  return (
    <section className="artifact-pane" aria-label={artifact.title}>
      <header className="artifact-header">
        <span className="artifact-kind">{artifact.kind === "markdown" ? "md" : artifact.kind}</span>
        <span className="artifact-title truncate" title={artifact.path ?? artifact.title}>
          {artifact.title}
        </span>
        {latest > 1 ? (
          <select
            className="artifact-version"
            aria-label="Version"
            value={version ?? ""}
            onChange={(e) => navigate(artifactHref(sessionKey, artifact.id, Number(e.target.value) || undefined), { replace: true })}
          >
            <option value="">Latest (v{latest})</option>
            {artifact.versions.map((v, i) => (
              <option key={v.eventId} value={i + 1}>
                v{i + 1}
                {v.timestamp ? ` · ${formatTime(v.timestamp)}` : ""}
              </option>
            ))}
          </select>
        ) : (
          at && <span className="dim artifact-time">{formatTime(at)}</span>
        )}
        <a className="artifact-action" href={raw} target="_blank" rel="noreferrer" title="Open in a new tab">
          {artifact.kind === "markdown" ? "Raw" : "Open"} ↗
        </a>
        <Link className="artifact-action" href={`/local/${sessionKey}`} aria-label="Close artifact" title="Close">
          ✕
        </Link>
      </header>
      {artifact.kind === "markdown" ? (
        <MarkdownArtifact url={raw} />
      ) : (
        <iframe
          className="artifact-frame"
          title={artifact.title}
          src={raw}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}

function MarkdownArtifact({ url }: { url: string }) {
  const [state, setState] = useState<{ url: string; text?: string; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => ({ url, ...(res.ok ? { text: await res.text() } : { error: await res.text() }) }))
      .catch(() => ({ url, error: "Couldn't load this artifact." }))
      .then((next) => !cancelled && setState(next));
    return () => {
      cancelled = true;
    };
  }, [url]);
  // Keep showing the previous version while the next one loads, so live updates don't flash.
  if (!state) return <p className="hint pad">Loading…</p>;
  if (state.error && state.url === url) return <p className="hint pad">{state.error}</p>;
  return (
    <div className="artifact-markdown">
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{state.text ?? ""}</Markdown>
      </div>
    </div>
  );
}

/** Shown in the pane's place when the URL names an artifact the session doesn't have (yet). */
export function MissingArtifact({ sessionKey, loading }: { sessionKey: string; loading: boolean }) {
  return (
    <section className="artifact-pane">
      <header className="artifact-header">
        <span className="spacer" />
        <Link className="artifact-action" href={`/local/${sessionKey}`} aria-label="Close artifact" title="Close">
          ✕
        </Link>
      </header>
      <p className="hint pad">{loading ? "Loading…" : "This session has no such artifact."}</p>
    </section>
  );
}
