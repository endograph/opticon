import { type ArtifactKind, type SessionEvent, collectArtifacts } from "@opticon/core";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Artifacts are agent-written pages served from the daemon's own origin. The CSP sandbox gives
 * them an opaque origin, inside the app's iframe or opened in their own tab, so their scripts
 * can't use the local cookie to call /api. Scripts, popups and CDN assets still work.
 */
const HEADERS: Record<ArtifactKind, Record<string, string>> = {
  html: { "content-type": "text/html; charset=utf-8" },
  svg: { "content-type": "image/svg+xml; charset=utf-8" },
  markdown: { "content-type": "text/plain; charset=utf-8" },
};
const COMMON = {
  "content-security-policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * One version of a session's artifact (the latest when `version` is null). Content comes from
 * the transcript; when it only recorded a diff, from the file on disk. Only paths the session
 * itself wrote are ever read.
 */
export async function artifactResponse(events: Iterable<SessionEvent>, id: string, version: string | null): Promise<Response> {
  const artifact = collectArtifacts(events).find((a) => a.id === id);
  if (!artifact) return new Response("No such artifact in this session", { status: 404 });
  const n = version === null ? artifact.versions.length : Number(version);
  const found = Number.isInteger(n) ? artifact.versions[n - 1] : undefined;
  if (!found) return new Response("No such version", { status: 404 });
  const body = found.content ?? (artifact.path ? await readSmall(artifact.path) : undefined);
  if (body === undefined) return new Response("The transcript doesn't have this version and the file is gone", { status: 404 });
  return new Response(body, { headers: { ...HEADERS[artifact.kind], ...COMMON } });
}

async function readSmall(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > MAX_FILE_BYTES) return undefined;
  return file.text().catch(() => undefined);
}
