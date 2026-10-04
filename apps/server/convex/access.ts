import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, type MutationCtx, action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { githubApi, githubApiHeaders, githubUrl } from "./github";
import { instancePolicy } from "./instance";
import { ACCESS_REFRESH_MS } from "./lib";

const MAX_REPO_REFRESH = 20;
const MEMBER_RECHECK_MS = 60 * 60_000;
const MEMBER_BATCH = 100;

/**
 * Refreshes what GitHub says about the viewer, using their own token: org and team membership
 * (read:org) and read access to `repos`. Viewers call this with a decision's `stale`; queries
 * then re-evaluate reactively once the answers are saved. Repos GitHub can't answer for are left
 * as they were.
 *
 * Orgs that restrict third-party OAuth apps hide membership until an admin approves Opticon, so
 * those orgs simply won't appear here.
 */
export const refresh = action({
  args: { token: v.string(), memberships: v.boolean(), repos: v.array(v.string()), force: v.optional(v.boolean()) },
  handler: async (ctx, { token, memberships, repos, force }): Promise<{ orgs: string[]; teams: string[] } | null> => {
    const viewer = await ctx.runQuery(internal.auth.githubToken, { token });
    const headers = viewer && (await githubHeaders(ctx, viewer));
    if (!viewer || !headers) return null;
    await Promise.all(repos.slice(0, MAX_REPO_REFRESH).map((repo) => refreshRepoRead(ctx, viewer.userId, headers, repo.toLowerCase())));
    if (!memberships) return null;
    const orgs = (await paginate<{ login: string }>(`${githubApi()}/user/orgs`, headers)).map((o) => o.login.toLowerCase());
    const teams = (await paginate<{ slug: string; organization: { login: string } }>(`${githubApi()}/user/teams`, headers)).map(
      (t) => `${t.organization.login}/${t.slug}`.toLowerCase(),
    );
    await ctx.runMutation(internal.access.saveMemberships, { userId: viewer.userId, orgs, teams, force: force ?? false });
    return { orgs, teams };
  },
});

async function refreshRepoRead(ctx: ActionCtx, userId: Id<"users">, headers: Record<string, string>, repo: string): Promise<void> {
  const res = await fetch(`${githubApi()}/repos/${repo}`, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res || rateLimited(res)) return;
  // GitHub answers 404 for private repos the user can't see; 403 when an org blocks Opticon.
  if (res.status === 403 || res.status === 404) {
    await ctx.runMutation(internal.access.saveRepoRead, { userId, repo, canRead: false });
    return;
  }
  if (!res.ok) return;
  const body = (await res.json()) as { full_name: string; private: boolean; permissions?: { pull?: boolean } };
  // A renamed repo answers under its new name; shares follow renames via the repo cron.
  if (body.full_name.toLowerCase() !== repo) return;
  await ctx.runMutation(internal.access.saveRepoRead, { userId, repo, canRead: body.permissions?.pull ?? !body.private, private: body.private });
}

export const saveRepoRead = internalMutation({
  args: { userId: v.id("users"), repo: v.string(), canRead: v.boolean(), private: v.optional(v.boolean()) },
  handler: async (ctx, { userId, repo, canRead, private: isPrivate }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("repoReads")
      .withIndex("by_user_repo", (q) => q.eq("userId", userId).eq("repo", repo))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { canRead, checkedAt: now });
    else await ctx.db.insert("repoReads", { userId, repo, canRead, checkedAt: now });
    if (isPrivate !== undefined) await saveVisibility(ctx, repo, isPrivate);
  },
});

export async function saveVisibility(ctx: MutationCtx, repo: string, isPrivate: boolean): Promise<void> {
  const existing = await ctx.db
    .query("repoVisibility")
    .withIndex("by_repo", (q) => q.eq("repo", repo))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { private: isPrivate, checkedAt: Date.now() });
  else await ctx.db.insert("repoVisibility", { repo, private: isPrivate, checkedAt: Date.now() });
}

// --- org-limited instances ---------------------------------------------------

/**
 * The first of `orgs` GitHub confirms the token's user is an active member of, or null. Throws
 * when GitHub can't answer, so an outage never counts as leaving the org.
 */
export async function allowedOrgMembership(headers: Record<string, string>, orgs: string[]): Promise<string | null> {
  for (const org of orgs) {
    const res = await fetch(`${githubApi()}/user/memberships/orgs/${org}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (rateLimited(res)) throw new Error("GitHub rate limit");
    // 403: the org restricts Opticon's GitHub app; membership can't be seen, so it doesn't count.
    if (res.status === 401 || res.status === 403 || res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub membership check failed (${res.status})`);
    if (((await res.json()) as { state?: string }).state === "active") return org;
  }
  return null;
}

/**
 * Re-confirms org membership on org-limited instances. Users GitHub says have left, or whose
 * token no longer works, are signed out everywhere. Users GitHub can't answer for keep their
 * sign-in until it lapses (MEMBER_EXPIRY_MS).
 */
export const recheckMembers = internalAction({
  args: {},
  handler: async (ctx) => {
    const { allowedOrgs } = instancePolicy();
    if (!allowedOrgs.length) return;
    const due = await ctx.runQuery(internal.access.membersDue, { before: Date.now() - MEMBER_RECHECK_MS, limit: MEMBER_BATCH });
    for (const userId of due) {
      const credentials = await ctx.runQuery(internal.auth.githubTokenForUser, { userId });
      const headers = credentials && (await githubHeaders(ctx, credentials));
      try {
        const org = headers ? await allowedOrgMembership(headers, allowedOrgs) : null;
        await ctx.runMutation(internal.access.settleMember, { userId, org });
      } catch (error) {
        console.warn(`Couldn't re-check membership for ${userId}: ${(error as Error).message}`);
      }
    }
    if (due.length === MEMBER_BATCH) await ctx.scheduler.runAfter(0, internal.access.recheckMembers, {});
  },
});

export const membersDue = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, { before, limit }) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_member_checked", (q) => q.lt("memberCheckedAt", before))
      .take(limit);
    return users.map((u) => u._id);
  },
});

/** Records a membership check: `org` is the confirmed allowed org, or null to sign the user out. */
export const settleMember = internalMutation({
  args: { userId: v.id("users"), org: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, org }) => {
    const now = Date.now();
    if (org) {
      await ctx.db.patch(userId, { memberOf: org, memberVerifiedAt: now, memberCheckedAt: now });
      return;
    }
    await ctx.db.patch(userId, { memberOf: undefined, memberVerifiedAt: undefined, memberCheckedAt: now });
    const tokens = await ctx.db
      .query("tokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of tokens) await ctx.db.delete(t._id);
  },
});

export interface GithubCredentials {
  userId: Id<"users">;
  githubToken?: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

/** API headers using the user's own GitHub token, refreshed if it's about to expire. Null without a usable token. */
export async function githubHeaders(ctx: ActionCtx, credentials: GithubCredentials): Promise<Record<string, string> | null> {
  let githubToken = credentials.githubToken;
  if (!githubToken) return null;
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now() + 60_000) {
    const refreshed = await refreshGithubToken(ctx, credentials);
    if (!refreshed) return null;
    githubToken = refreshed;
  }
  return githubApiHeaders(githubToken);
}

async function refreshGithubToken(ctx: ActionCtx, viewer: GithubCredentials): Promise<string | null> {
  const refreshToken = viewer.refreshToken;
  if (!refreshToken || (viewer.refreshExpiresAt !== undefined && viewer.refreshExpiresAt <= Date.now())) return null;
  if (!await ctx.runMutation(internal.auth.claimGithubRefresh, { userId: viewer.userId, refreshToken })) return null;
  try {
    const response = await fetch(`${githubUrl()}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token", refresh_token: refreshToken,
        client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const result = await response.json() as {
      access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number;
    };
    if (!result.access_token || !result.refresh_token || !result.expires_in || !result.refresh_token_expires_in) return null;
    const saved = await ctx.runMutation(internal.auth.finishGithubRefresh, {
      userId: viewer.userId, previousRefreshToken: refreshToken,
      credentials: {
        token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000,
        refreshToken: result.refresh_token, refreshExpiresAt: Date.now() + result.refresh_token_expires_in * 1000,
      },
    });
    return saved ? result.access_token : null;
  } finally {
    await ctx.runMutation(internal.auth.finishGithubRefresh, { userId: viewer.userId, previousRefreshToken: refreshToken });
  }
}

export const saveMemberships = internalMutation({
  args: { userId: v.id("users"), orgs: v.array(v.string()), teams: v.array(v.string()), force: v.boolean() },
  handler: async (ctx, { userId, orgs, teams, force }) => {
    const user = await ctx.db.get(userId);
    if (!user) return;
    // Concurrent viewers of several shares may all refresh at once; one write per TTL is enough.
    if (!force && user.membershipCheckedAt && Date.now() - user.membershipCheckedAt < ACCESS_REFRESH_MS / 10) return;
    await ctx.db.patch(userId, { orgs, teams, membershipCheckedAt: Date.now() });
  },
});

/** GitHub signals rate limits with 429, or 403 and no requests remaining. Never an answer. */
function rateLimited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
}

async function paginate<T>(url: string, headers: Record<string, string>): Promise<T[]> {
  const results: T[] = [];
  let next: string | undefined = `${url}?per_page=100`;
  for (let page = 0; next && page < 10; page++) {
    const res: Response = await fetch(next, { headers });
    // An API failure must not replace cached memberships with an incomplete list.
    if (!res.ok) throw new Error(`GitHub membership request failed (${res.status})`);
    results.push(...((await res.json()) as T[]));
    next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return results;
}
