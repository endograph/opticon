import type { SessionEvent, ToolEvent } from "./types";

// Dependency-free: the web app imports this to list a session's artifacts from its events.

export type ArtifactKind = "html" | "markdown" | "svg";

export interface ArtifactVersion {
  /** The tool event that produced this version. */
  eventId: string;
  timestamp?: string;
  /**
   * Full content, when the transcript has it. Missing when only a diff was recorded against
   * content the session never saw (an edit to an existing file, a Codex update); the file on
   * disk stands in.
   */
  content?: string;
}

/** Something a session made that Opticon can render: a file it wrote, or an inline HTML render. */
export interface Artifact {
  /** Stable within a session and URL-safe: a slug of the title plus a hash of the source. */
  id: string;
  kind: ArtifactKind;
  title: string;
  /** Absolute path for files; absent for inline renders. */
  path?: string;
  /** Made in this session (an inline render, a new file) rather than an edit to an existing file. */
  created: boolean;
  versions: ArtifactVersion[];
}

interface Change {
  /** What versions group by: a file path, or an inline render's title. */
  source: string;
  kind: ArtifactKind;
  title: string;
  path?: string;
  created: boolean;
  /** The new content given the previous version's, or undefined when it can't be known. */
  apply: (previous: string | undefined) => string | undefined;
}

/** A session's artifacts in order of first appearance. Only successful tool calls count. */
export function collectArtifacts(events: Iterable<SessionEvent>): Artifact[] {
  const artifacts = new Map<string, Artifact>();
  for (const event of events) {
    if (event.kind !== "tool" || event.status !== "ok") continue;
    for (const change of changesOf(event)) {
      let artifact = artifacts.get(change.source);
      if (!artifact) {
        const { kind, title, path, created } = change;
        artifact = { id: `${slug(title)}-${hash(change.source)}`, kind, title, path, created, versions: [] };
        artifacts.set(change.source, artifact);
      }
      const content = change.apply(artifact.versions.at(-1)?.content);
      artifact.versions.push({ eventId: event.id, timestamp: event.timestamp, content });
    }
  }
  return [...artifacts.values()];
}

export function artifactKind(path: string): ArtifactKind | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "svg") return "svg";
  return undefined;
}

function changesOf(tool: ToolEvent): Change[] {
  const input = tool.input as Record<string, any> | undefined;
  if (!input || typeof input !== "object") return [];

  // T3 Code's html_render: the page is the tool input. Renders with the same title are revisions.
  if (tool.name.endsWith("/html_render") && typeof input.html === "string") {
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "HTML";
    const html: string = input.html;
    return [{ source: `render:${title}`, kind: "html", title, created: true, apply: () => html }];
  }

  // Claude Code file tools.
  const file = (path: unknown, created: boolean, apply: Change["apply"]): Change[] => {
    const kind = typeof path === "string" ? artifactKind(path) : undefined;
    return kind ? [{ source: path as string, kind, title: fileTitle(path as string), path: path as string, created, apply }] : [];
  };
  if (tool.name === "Write" && typeof input.content === "string") {
    const content: string = input.content;
    return file(input.file_path, true, () => content);
  }
  if (tool.name === "Edit") return file(input.file_path, false, (previous) => applyEdits(previous, [input]));
  if (tool.name === "MultiEdit" && Array.isArray(input.edits)) {
    return file(input.file_path, false, (previous) => applyEdits(previous, input.edits));
  }

  // Codex FileChange: `{ [path]: { type: "add", content } | { type: "update", unified_diff } | … }`.
  if (tool.name === "edit") {
    return Object.entries(input).flatMap(([path, change]: [string, any]) => {
      if (change?.type === "add" && typeof change.content === "string") return file(path, true, () => change.content);
      if (change?.type === "update") return file(path, false, () => undefined);
      return [];
    });
  }
  return [];
}

/** Replays Claude Code's exact-string edits. Undefined when the base is unknown or an edit doesn't apply. */
function applyEdits(text: string | undefined, edits: Record<string, any>[]): string | undefined {
  for (const edit of edits) {
    if (text === undefined || typeof edit.old_string !== "string" || typeof edit.new_string !== "string") return undefined;
    const at = text.indexOf(edit.old_string);
    if (at < 0 || !edit.old_string) return undefined;
    text = edit.replace_all
      ? text.split(edit.old_string).join(edit.new_string)
      : text.slice(0, at) + edit.new_string + text.slice(at + edit.old_string.length);
  }
  return text;
}

/** The file name, with its directory when the name alone says nothing (`riff/index.html`). */
function fileTitle(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  const name = parts.at(-1) ?? path;
  return /^(index|readme)\./i.test(name) && parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "artifact"
  );
}

/** FNV-1a, base 36. Only needs to separate sources within one session. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
