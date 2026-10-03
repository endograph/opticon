import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createParser } from "./providers";
import { parseJson } from "./text";
import type { Provider, SessionMeta } from "./types";

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;

export interface Roots {
  claude: string;
  codex: string;
}

export function defaultRoots(): Roots {
  return {
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    codex: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  };
}

export interface SessionFile {
  provider: Provider;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Top-level session files only. Claude subagent transcripts live in <session>/subagents/ and are skipped. */
export async function listSessionFiles(roots = defaultRoots()): Promise<SessionFile[]> {
  const [claude, codex, archived] = await Promise.all([
    findJsonl(join(roots.claude, "projects"), 1),
    findJsonl(join(roots.codex, "sessions"), 3),
    findJsonl(join(roots.codex, "archived_sessions"), 0),
  ]);
  const files = [
    ...claude.map((path) => ({ provider: "claude" as const, path })),
    ...[...codex, ...archived].map((path) => ({ provider: "codex" as const, path })),
  ];
  const stats = await Promise.all(files.map((f) => stat(f.path).catch(() => undefined)));
  return files
    .flatMap((f, i) => {
      const s = stats[i];
      return s ? [{ ...f, size: s.size, mtimeMs: s.mtimeMs }] : [];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Codex keeps thread titles outside the rollout, in session_index.jsonl. Later lines win. */
export async function readCodexTitles(roots = defaultRoots()): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const file = Bun.file(join(roots.codex, "session_index.jsonl"));
  if (!(await file.exists())) return titles;
  for (const line of (await file.text()).split("\n")) {
    const entry = parseJson(line);
    if (entry?.id && entry.thread_name) titles.set(entry.id, entry.thread_name);
  }
  return titles;
}

/**
 * Cheap metadata from the first and last few hundred KB of a file. Good enough for listing;
 * open a SessionTail for the full transcript.
 */
export async function readSessionMeta(file: SessionFile, codexTitles?: Map<string, string>): Promise<SessionMeta> {
  const parser = createParser(file.provider, file.path);
  const blob = Bun.file(file.path);
  for (const line of completeLines(await blob.slice(0, HEAD_BYTES).text(), file.size <= HEAD_BYTES)) {
    parser.push(line);
  }
  if (file.size > HEAD_BYTES) {
    const tail = await blob.slice(Math.max(HEAD_BYTES, file.size - TAIL_BYTES)).text();
    // Drop the first line: it's likely cut off. Only the parser's metadata matters here.
    for (const line of completeLines(tail.slice(tail.indexOf("\n") + 1), true)) parser.push(line);
  }
  const meta = parser.meta;
  meta.updatedAt = new Date(file.mtimeMs).toISOString();
  if (file.provider === "codex") meta.title = codexTitles?.get(meta.id) ?? meta.title;
  return meta;
}

function completeLines(text: string, endsAtEof: boolean): string[] {
  const lines = text.split("\n");
  if (!endsAtEof) lines.pop();
  return lines.filter((l) => l.trim());
}

async function findJsonl(dir: string, depth: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (e) => {
      const path = join(dir, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) return depth === 0 ? [path] : [];
      if (e.isDirectory() && depth > 0) return findJsonl(path, depth - 1);
      return [];
    }),
  );
  return nested.flat();
}
