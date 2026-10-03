import { LINK_ACCESS, type ShareAccess } from "@opticon/core";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OPTICON_HOME } from "./paths";

export const AUTOSYNC_FILE = join(OPTICON_HOME, "autosync.json");

/**
 * Autosync for one project, matched by git remote (so every clone and worktree counts) or,
 * outside a git repo, by directory prefix. Syncing, sharing, and listing are separate so a rule
 * can later sync privately; for now the CLI and UI only create public, discoverable rules.
 */
export interface AutosyncRule {
  /** Normalized origin remote, e.g. `github.com/rt2zz/opticon`. */
  repo?: string;
  /** Absolute directory; matches it and everything below. Used when there's no remote. */
  path?: string;
  sync: boolean;
  /** Access for newly created shares. Absent: synced but private. */
  share?: ShareAccess;
  /** List new shares on the owner's profile and the public feed. Needs link access. */
  discoverable?: boolean;
  /** ISO time the rule was added. Sessions last active before it are left alone (no backfill). */
  since: string;
}

export async function readRules(): Promise<AutosyncRule[]> {
  const file = Bun.file(AUTOSYNC_FILE);
  if (!(await file.exists())) return [];
  const data = (await file.json().catch(() => undefined)) as { rules?: AutosyncRule[] } | undefined;
  return data?.rules ?? [];
}

export async function writeRules(rules: AutosyncRule[]): Promise<void> {
  await Bun.write(AUTOSYNC_FILE, `${JSON.stringify({ rules }, null, 2)}\n`);
}

/** A public, discoverable rule for `dir`: by remote when it has one, else by path. */
export async function newRule(dir: string): Promise<AutosyncRule> {
  // Session cwds are real paths (e.g. /private/tmp on macOS, not /tmp).
  const path = await realpath(resolve(dir)).catch(() => resolve(dir));
  const repo = await repoOf(path);
  return { ...(repo ? { repo } : { path }), sync: true, share: LINK_ACCESS, discoverable: true, since: new Date().toISOString() };
}

/** Adds or replaces the rule for the same repo or path. */
export async function addRule(rule: AutosyncRule): Promise<AutosyncRule[]> {
  const rules = (await readRules()).filter((r) => !sameTarget(r, rule));
  rules.push(rule);
  await writeRules(rules);
  return rules;
}

export async function removeRule(rule: Pick<AutosyncRule, "repo" | "path">): Promise<boolean> {
  const rules = await readRules();
  const kept = rules.filter((r) => !sameTarget(r, rule));
  await writeRules(kept);
  return kept.length !== rules.length;
}

export const describeRule = (rule: AutosyncRule) => rule.repo ?? rule.path ?? "?";

function sameTarget(a: Pick<AutosyncRule, "repo" | "path">, b: Pick<AutosyncRule, "repo" | "path">): boolean {
  return a.repo === b.repo && a.path === b.path;
}

/** Whether a session's working directory falls under `rule`. `repo` is the cwd's remote, if any. */
export function matches(rule: AutosyncRule, cwd: string, repo: string | undefined): boolean {
  if (!rule.sync) return false;
  if (rule.repo) return rule.repo === repo;
  return !!rule.path && (cwd === rule.path || cwd.startsWith(`${rule.path}/`));
}

/** The normalized origin remote of the repo containing `dir`, or undefined (no repo, no origin, or gone). */
export async function repoOf(dir: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => ["", 1] as const);
  return code === 0 ? normalizeRemote(out.trim()) : undefined;
}

/** `git@github.com:Foo/bar.git`, `https://github.com/foo/bar` → `github.com/foo/bar`. */
export function normalizeRemote(url: string): string | undefined {
  if (!url) return undefined;
  const scp = /^[^/@:]+@([^:/]+):(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp) [, host, path] = scp as unknown as [string, string, string];
  else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return host && path ? `${host}/${path}`.toLowerCase() : undefined;
}
