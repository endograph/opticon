import { PROTOCOL_VERSION } from "@opticon/core/protocol";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { type InstancePolicy, allowedAccess, instancePolicy } from "./instance";

/**
 * Cached GitHub answers (org and team membership, repo read access) older than this still count,
 * but viewers are asked to refresh them.
 */
export const ACCESS_REFRESH_MS = 10 * 60_000;
/** Past this, a cached GitHub answer no longer grants anything. */
export const ACCESS_EXPIRY_MS = 60 * 60_000;
/** Public repos are re-checked daily by the repo cron; past this, public no longer counts. */
export const PUBLIC_REPO_EXPIRY_MS = 48 * 60 * 60_000;
/** On org-limited instances, sign-in lapses this long after membership was last confirmed. */
export const MEMBER_EXPIRY_MS = 6 * 60 * 60_000;
export const PRESENCE_TTL_MS = 45_000;

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Only call from actions: queries and mutations get deterministic randomness. */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function userForToken(ctx: QueryCtx, token: string | undefined): Promise<Doc<"users"> | null> {
  if (!token) return null;
  const hash = await sha256(token);
  const found = await ctx.db
    .query("tokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
  if (!found || (found.expiresAt && found.expiresAt < Date.now())) return null;
  const user = await ctx.db.get(found.userId);
  return user && isAllowedUser(user, instancePolicy()) ? user : null;
}

/** On org-limited instances, only users recently confirmed to be in an allowed org are signed in. */
export function isAllowedUser(user: Doc<"users">, policy: InstancePolicy, now = Date.now()): boolean {
  if (!policy.allowedOrgs.length) return true;
  return !!user.memberOf && policy.allowedOrgs.includes(user.memberOf) && now - (user.memberVerifiedAt ?? 0) < MEMBER_EXPIRY_MS;
}

export async function requireUser(ctx: QueryCtx, token: string | undefined): Promise<Doc<"users">> {
  const user = await userForToken(ctx, token);
  if (!user) throw new ConvexError({ code: "unauthenticated" });
  return user;
}

export function requireProtocol(protocol: number): void {
  if (protocol !== PROTOCOL_VERSION) {
    throw new ConvexError({ code: "protocol_mismatch", expected: PROTOCOL_VERSION, message: "Run `opticon update`." });
  }
}

/** GitHub answers a viewer should refresh: orgs and teams (`org/team`) they may be in, and repos they may read. */
export interface Stale {
  groups: string[];
  repos: string[];
}

export type AccessDecision =
  /** `stale`: allowed on an answer due for a refresh. */
  | { ok: true; stale?: Stale }
  | { ok: false; reason: "login_required" }
  /** `stale`: may be allowed once these are refreshed. */
  | { ok: false; reason: "forbidden"; stale?: Stale };

/** What's known about the viewer and a share, for its grants. */
export interface AccessFacts {
  /** The share's repo, for its `repo` grant. */
  visibility?: { private: boolean; checkedAt: number };
  /** The viewer's read access to the share's repo. */
  read?: { canRead: boolean; checkedAt: number };
  /** The viewer's membership in the share's orgs and teams, by `org` or `org/team`. */
  groups?: Record<string, { member: boolean; checkedAt: number }>;
}

/**
 * Whether `viewer` can open `share`: the owner always can; anyone else needs the instance to let
 * them in and one of the share's grants that the instance allows. Pure, so it's easy to test;
 * `canView` gathers its inputs.
 */
export function decideAccess(
  policy: InstancePolicy,
  share: Pick<Doc<"shares">, "access" | "ownerId" | "repo">,
  viewer: Doc<"users"> | null,
  facts: AccessFacts = {},
  now = Date.now(),
): AccessDecision {
  if (viewer && viewer._id === share.ownerId) return { ok: true };
  if (!viewer && !policy.anonymous) return { ok: false, reason: "login_required" };
  const access = allowedAccess(share.access, policy);
  if (access.link) return { ok: true };
  const repo = access.repo ? share.repo : undefined;
  if (repo && facts.visibility?.private === false && now - facts.visibility.checkedAt < PUBLIC_REPO_EXPIRY_MS) return { ok: true };
  if (!viewer) return { ok: false, reason: "login_required" };
  if (access.users.includes(viewer.login)) return { ok: true };

  const stale: Stale = { groups: [], repos: [] };
  const staleOrUndefined = () => (stale.groups.length || stale.repos.length ? stale : undefined);
  const groups = [...access.orgs, ...access.teams];
  if (groups.length) {
    const age = (group: string) => now - (facts.groups?.[group]?.checkedAt ?? Number.NEGATIVE_INFINITY);
    const memberOf = groups.filter((g) => facts.groups?.[g]?.member && age(g) < ACCESS_EXPIRY_MS);
    // A fresh yes settles it; otherwise refresh whatever is due.
    if (memberOf.some((g) => age(g) <= ACCESS_REFRESH_MS)) return { ok: true };
    stale.groups.push(...groups.filter((g) => age(g) > ACCESS_REFRESH_MS));
    if (memberOf.length) return { ok: true, stale: staleOrUndefined() };
  }
  if (repo) {
    const age = now - (facts.read?.checkedAt ?? Number.NEGATIVE_INFINITY);
    if (age > ACCESS_REFRESH_MS) stale.repos.push(repo);
    if (facts.read?.canRead && age < ACCESS_EXPIRY_MS) return { ok: true, stale: staleOrUndefined() };
  }
  return { ok: false, reason: "forbidden", stale: staleOrUndefined() };
}

/**
 * Decides access for many shares as one viewer, loading each repo's facts once, and collects
 * what the viewer should refresh.
 */
export function viewChecker(ctx: QueryCtx, viewer: Doc<"users"> | null) {
  const policy = instancePolicy();
  const repos = new Map<string, Promise<AccessFacts>>();
  const groups = new Map<string, Promise<{ member: boolean; checkedAt: number } | null>>();
  const stale: Stale = { groups: [], repos: [] };
  const repoFactsFor = (repo: string) => {
    let found = repos.get(repo);
    if (!found) repos.set(repo, (found = repoFacts(ctx, repo, viewer)));
    return found;
  };
  const groupFactFor = (group: string) => {
    let found = groups.get(group);
    if (!found) groups.set(group, (found = groupFact(ctx, group, viewer!)));
    return found;
  };
  const decide = async (share: Doc<"shares">): Promise<AccessDecision> => {
    const owner = !!viewer && share.ownerId === viewer._id;
    const facts: AccessFacts = !owner && share.access.repo && share.repo ? { ...(await repoFactsFor(share.repo)) } : {};
    if (viewer && !owner) {
      const names = [...share.access.orgs, ...share.access.teams];
      const found = await Promise.all(names.map(groupFactFor));
      facts.groups = Object.fromEntries(names.flatMap((name, i) => (found[i] ? [[name, found[i]]] : [])));
    }
    const decision = decideAccess(policy, share, viewer, facts);
    if ("stale" in decision && decision.stale) {
      for (const group of decision.stale.groups) if (!stale.groups.includes(group)) stale.groups.push(group);
      for (const repo of decision.stale.repos) if (!stale.repos.includes(repo)) stale.repos.push(repo);
    }
    return decision;
  };
  return {
    decide,
    /** The shares the viewer can open, in order. */
    async visible(shares: Doc<"shares">[]): Promise<Doc<"shares">[]> {
      const decisions = await Promise.all(shares.map(decide));
      return shares.filter((_, i) => decisions[i]!.ok);
    },
    stale,
  };
}

export async function canView(ctx: QueryCtx, share: Doc<"shares">, viewer: Doc<"users"> | null): Promise<AccessDecision> {
  return viewChecker(ctx, viewer).decide(share);
}

async function groupFact(ctx: QueryCtx, group: string, viewer: Doc<"users">) {
  const row = await ctx.db
    .query("groupMembers")
    .withIndex("by_user_group", (q) => q.eq("userId", viewer._id).eq("group", group))
    .unique();
  return row && { member: row.member, checkedAt: row.checkedAt };
}

async function repoFacts(ctx: QueryCtx, repo: string, viewer: Doc<"users"> | null): Promise<AccessFacts> {
  const visibility = await ctx.db
    .query("repoVisibility")
    .withIndex("by_repo", (q) => q.eq("repo", repo))
    .unique();
  const read = viewer
    ? await ctx.db
        .query("repoReads")
        .withIndex("by_user_repo", (q) => q.eq("userId", viewer._id).eq("repo", repo))
        .unique()
    : null;
  return { visibility: visibility ?? undefined, read: read ?? undefined };
}
