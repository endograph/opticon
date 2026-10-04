import type { ShareAccess } from "@opticon/core";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_INSTANCE, endpoints } from "./account";
import { OPTICON_HOME } from "./paths";

export const AUTOSYNC_FILE = join(OPTICON_HOME, "autosync.json");

/**
 * Autosync for one project, matched by git remote (so every clone and worktree counts) or,
 * outside a git repo, by directory prefix. Syncing, sharing, and listing are separate so a rule
 * can later sync privately; for now the CLI and UI create listed rules with the instance's
 * default access.
 */
export interface AutosyncRule {
  /**
   * The backend (Convex URL) the rule uploads to. Rules only run while their instance is
   * selected, so switching instances never sends one instance's projects to another.
   */
  instance: string;
  /** Normalized origin remote, e.g. `github.com/rt2zz/opticon`. */
  repo?: string;
  /** Absolute directory; matches it and everything below. Used when there's no remote. */
  path?: string;
  sync: boolean;
  /** Access for newly created shares. Absent: synced but private. */
  share?: ShareAccess;
  /** List new shares on the owner's profile, the repo page, and the feed, for viewers who can open them. */
  listed?: boolean;
  /** ISO time the rule was added. Sessions last active before it are left alone (no backfill). */
  since: string;
}

export async function readRules(): Promise<AutosyncRule[]> {
  const file = Bun.file(AUTOSYNC_FILE);
  if (!(await file.exists())) return [];
  const data = (await file.json().catch(() => undefined)) as { rules?: StoredRule[] } | undefined;
  return (data?.rules ?? []).map(upgradeRule);
}

/** Rules for the selected instance. */
export async function currentRules(): Promise<AutosyncRule[]> {
  const instance = endpoints().convexUrl;
  return (await readRules()).filter((r) => r.instance === instance);
}

/**
 * Rules written before instances (always opticon.tv), before access had `link` and `repo`, and
 * before `discoverable` became `listed`.
 */
type StoredRule = Omit<AutosyncRule, "share" | "instance"> & {
  instance?: string;
  share?: ShareAccess & { anyone?: boolean };
  discoverable?: boolean;
};

function upgradeRule({ discoverable, ...rule }: StoredRule): AutosyncRule {
  const share = rule.share && { ...rule.share, link: rule.share.link ?? rule.share.anyone ?? false, repo: rule.share.repo ?? false };
  if (share) delete share.anyone;
  return { ...rule, instance: rule.instance ?? DEFAULT_INSTANCE.convexUrl, share, listed: rule.listed ?? discoverable };
}

export async function writeRules(rules: AutosyncRule[]): Promise<void> {
  await Bun.write(AUTOSYNC_FILE, `${JSON.stringify({ rules }, null, 2)}\n`);
}

type RuleTarget = Pick<AutosyncRule, "instance" | "repo" | "path">;

/** What a rule for `dir` on the selected instance matches: its remote when it has one, else its path. */
export async function ruleTarget(dir: string): Promise<RuleTarget> {
  // Session cwds are real paths (e.g. /private/tmp on macOS, not /tmp).
  const path = await realpath(resolve(dir)).catch(() => resolve(dir));
  const repo = await repoOf(path);
  return { instance: endpoints().convexUrl, ...(repo ? { repo } : { path }) };
}

/** A listed rule for `dir` that shares with `access`. */
export async function newRule(dir: string, access: ShareAccess): Promise<AutosyncRule> {
  return { ...(await ruleTarget(dir)), sync: true, share: access, listed: true, since: new Date().toISOString() };
}

/** Adds or replaces the rule for the same instance and repo or path. */
export async function addRule(rule: AutosyncRule): Promise<AutosyncRule[]> {
  const rules = (await readRules()).filter((r) => !sameTarget(r, rule));
  rules.push(rule);
  await writeRules(rules);
  return rules;
}

export async function removeRule(rule: RuleTarget): Promise<boolean> {
  const rules = await readRules();
  const kept = rules.filter((r) => !sameTarget(r, rule));
  await writeRules(kept);
  return kept.length !== rules.length;
}

export const describeRule = (rule: Pick<AutosyncRule, "repo" | "path">) => rule.repo ?? rule.path ?? "?";

function sameTarget(a: RuleTarget, b: RuleTarget): boolean {
  return a.instance === b.instance && a.repo === b.repo && a.path === b.path;
}

/** Drops every rule for an instance, e.g. when it's removed. Returns how many there were. */
export async function removeInstanceRules(instance: string): Promise<number> {
  const rules = await readRules();
  const kept = rules.filter((r) => r.instance !== instance);
  if (kept.length !== rules.length) await writeRules(kept);
  return rules.length - kept.length;
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
