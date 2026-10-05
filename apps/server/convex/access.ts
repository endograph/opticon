import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, type MutationCtx, action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { githubApi, githubApiHeaders, githubUrl } from "./github";
import { instancePolicy } from "./instance";
const MAX_REPO_REFRESH = 20;
const MAX_GROUP_REFRESH = 20;
const MEMBER_RECHECK_MS = 60 * 60_000;
/** A membership check GitHub couldn't answer is retried after this, not immediately. */
const MEMBER_RETRY_MS = 15 * 60_000;
const MEMBER_BATCH = 100;

/**
 * Refreshes what GitHub says about the viewer, using their own token: whether they're in `groups`
 * (orgs, and teams as `org/team`), and whether they can read `repos`. Viewers call this with a
 * decision's `stale`; queries then re-evaluate reactively once the answers are saved. Anything
 * GitHub can't answer for is left as it was.
 *
 * Orgs that restrict third-party apps hide membership until an admin approves Opticon, so their
 * members count as outside them until then.
 */
export const refresh = action({
  args: { token: v.string(), groups: v.array(v.string()), repos: v.array(v.string()) },
  handler: async (ctx, { token, groups, repos }): Promise<void> => {
    const viewer = await ctx.runQuery(internal.auth.githubToken, { token });
    const headers = viewer && (await githubHeaders(ctx, viewer));
    if (!viewer || !headers) return;
    await Promise.all([
      ...repos.slice(0, MAX_REPO_REFRESH).map((repo) => refreshRepoRead(ctx, viewer.userId, headers, repo.toLowerCase())),
      ...groups.slice(0, MAX_GROUP_REFRESH).map(async (group) => {
        const member = await groupMembership(headers, group.toLowerCase(), viewer.login).catch(() => undefined);
        if (member !== undefined) await ctx.runMutation(internal.access.saveGroupMember, { userId: viewer.userId, group: group.toLowerCase(), member });
      }),
    ]);
  },
});

export const saveGroupMember = internalMutation({
  args: { userId: v.id("users"), group: v.string(), member: v.boolean() },
  handler: async (ctx, { userId, group, member }) => {
    const existing = await ctx.db
      .query("groupMembers")
      .withIndex("by_user_group", (q) => q.eq("userId", userId).eq("group", group))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { member, checkedAt: Date.now() });
    else await ctx.db.insert("groupMembers", { userId, group, member, checkedAt: Date.now() });
  },
});

/**
 * Whether GitHub says the token's user is an active member of `group`: an org (`acme`), or a
 * team (`acme/platform`). Throws when GitHub can't answer, e.g. when rate limited.
 */
export async function groupMembership(headers: Record<string, string>, group: string, login: string): Promise<boolean> {
  const [org, team] = group.split("/");
  const url = team
    ? `${githubApi()}/orgs/${encodeURIComponent(org!)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`
    : `${githubApi()}/user/memberships/orgs/${encodeURIComponent(org!)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (await rateLimited(res)) throw new Error("GitHub rate limit");
  // 403: the org restricts Opticon's GitHub app; membership can't be seen, so it doesn't count.
  if (res.status === 401 || res.status === 403 || res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub membership check failed (${res.status})`);
  return ((await res.json()) as { state?: string }).state === "active";
}

async function refreshRepoRead(ctx: ActionCtx, userId: Id<"users">, headers: Record<string, string>, repo: string): Promise<void> {
  const res = await fetch(`${githubApi()}/repos/${repo}`, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res || (await rateLimited(res))) return;
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
  for (const org of orgs) if (await groupMembership(headers, org, "")) return org;
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
      try {
        const credentials = await ctx.runQuery(internal.auth.githubTokenForUser, { userId });
        const headers = credentials && (await githubHeaders(ctx, credentials));
        const org = headers ? await allowedOrgMembership(headers, allowedOrgs) : null;
        await ctx.runMutation(internal.access.settleMember, { userId, org });
      } catch (error) {
        console.warn(`Couldn't re-check membership for ${userId}: ${(error as Error).message}`);
        await ctx.runMutation(internal.access.deferMember, { userId });
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

/** Retries an unanswered check after MEMBER_RETRY_MS. Verification, and so expiry, is unchanged. */
export const deferMember = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await ctx.db.patch(userId, { memberCheckedAt: Date.now() - MEMBER_RECHECK_MS + MEMBER_RETRY_MS });
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
  login: string;
  githubToken?: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

/**
 * API headers using the user's own GitHub token, refreshed if it's about to expire. Null when
 * there's no usable token and GitHub has said so; throws when it couldn't say (an outage, or
 * another refresh in flight), so callers never treat that as lost access.
 */
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
  if (!await ctx.runMutation(internal.auth.claimGithubRefresh, { userId: viewer.userId, refreshToken })) {
    throw new Error("GitHub token refresh already in progress");
  }
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
    if (!response.ok) throw new Error(`GitHub token refresh failed (${response.status})`);
    // GitHub rejects a revoked or expired refresh token with a 200 and an `error`.
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
    if (!saved) throw new Error("GitHub token refresh superseded by a new sign-in");
    return result.access_token;
  } finally {
    await ctx.runMutation(internal.auth.finishGithubRefresh, { userId: viewer.userId, previousRefreshToken: refreshToken });
  }
}

/**
 * Whether GitHub refused for a rate limit, which is never an answer: 429, or 403 with no requests
 * left, a Retry-After (secondary limits, which leave requests remaining), or a message saying so.
 */
export async function rateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  if (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")) return true;
  return /rate limit/i.test(await res.clone().text().catch(() => ""));
}
