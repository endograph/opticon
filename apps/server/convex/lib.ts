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

/** GitHub answers a viewer should refresh: their org and team membership, and repos they may read. */
export interface Stale {
  memberships: boolean;
  repos: string[];
}

export type AccessDecision =
  /** `stale`: allowed on an answer due for a refresh. */
  | { ok: true; stale?: Stale }
  | { ok: false; reason: "login_required" }
  /** `stale`: may be allowed once these are refreshed. */
  | { ok: false; reason: "forbidden"; stale?: Stale };

/** What's known about a share's repo, for its `repo` grant. */
export interface RepoFacts {
  visibility?: { private: boolean; checkedAt: number };
  /** The viewer's read access. */
  read?: { canRead: boolean; checkedAt: number };
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
  facts: RepoFacts = {},
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

  const stale: Stale = { memberships: false, repos: [] };
  const staleOrUndefined = () => (stale.memberships || stale.repos.length ? stale : undefined);
  if (access.orgs.length || access.teams.length) {
    const age = now - (viewer.membershipCheckedAt ?? Number.NEGATIVE_INFINITY);
    stale.memberships = age > ACCESS_REFRESH_MS;
    const orgs = viewer.orgs ?? [];
    const teams = viewer.teams ?? [];
    const member = access.orgs.some((o) => orgs.includes(o)) || access.teams.some((t) => teams.includes(t));
    if (member && age < ACCESS_EXPIRY_MS) return { ok: true, stale: staleOrUndefined() };
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
  const facts = new Map<string, Promise<RepoFacts>>();
  const stale: Stale = { memberships: false, repos: [] };
  const factsFor = (repo: string) => {
    let found = facts.get(repo);
    if (!found) facts.set(repo, (found = repoFacts(ctx, repo, viewer)));
    return found;
  };
  const decide = async (share: Doc<"shares">): Promise<AccessDecision> => {
    const needsFacts = share.access.repo && share.repo && share.ownerId !== viewer?._id;
    const decision = decideAccess(policy, share, viewer, needsFacts ? await factsFor(share.repo!) : {});
    if ("stale" in decision && decision.stale) {
      stale.memberships ||= decision.stale.memberships;
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

async function repoFacts(ctx: QueryCtx, repo: string, viewer: Doc<"users"> | null): Promise<RepoFacts> {
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
