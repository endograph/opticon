import { v } from "convex/values";
import { internal } from "./_generated/api";
import { type ActionCtx, action, internalMutation } from "./_generated/server";
import { MEMBERSHIP_TTL_MS } from "./lib";

/**
 * Refreshes the viewer's GitHub org and team membership using their own token (read:org).
 * Viewers call this when `shares.view` reports a stale forbidden decision; the view query then
 * re-evaluates reactively once the new membership is saved.
 *
 * Orgs that restrict third-party OAuth apps hide membership until an admin approves Opticon, so
 * those orgs simply won't appear here.
 */
export const refreshMemberships = action({
  args: { token: v.string(), force: v.optional(v.boolean()) },
  handler: async (ctx, { token, force }): Promise<{ orgs: string[]; teams: string[] } | null> => {
    const viewer = await ctx.runQuery(internal.auth.githubToken, { token });
    if (!viewer?.githubToken) return null;
    let githubToken = viewer.githubToken;
    if (viewer.expiresAt !== undefined && viewer.expiresAt <= Date.now() + 60_000) {
      const refreshed = await refreshGithubToken(ctx, viewer);
      if (!refreshed) return null;
      githubToken = refreshed;
    }
    const headers = { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json", "user-agent": "opticon" };
    const orgs = (await paginate<{ login: string }>("https://api.github.com/user/orgs", headers)).map((o) => o.login.toLowerCase());
    const teams = (await paginate<{ slug: string; organization: { login: string } }>("https://api.github.com/user/teams", headers)).map(
      (t) => `${t.organization.login}/${t.slug}`.toLowerCase(),
    );
    await ctx.runMutation(internal.access.saveMemberships, { userId: viewer.userId, orgs, teams, force: force ?? false });
    return { orgs, teams };
  },
});

async function refreshGithubToken(ctx: ActionCtx, viewer: {
  userId: import("./_generated/dataModel").Id<"users">;
  refreshToken?: string; refreshExpiresAt?: number;
}): Promise<string | null> {
  const refreshToken = viewer.refreshToken;
  if (!refreshToken || (viewer.refreshExpiresAt !== undefined && viewer.refreshExpiresAt <= Date.now())) return null;
  if (!await ctx.runMutation(internal.auth.claimGithubRefresh, { userId: viewer.userId, refreshToken })) return null;
  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
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
    if (!force && user.membershipCheckedAt && Date.now() - user.membershipCheckedAt < MEMBERSHIP_TTL_MS / 10) return;
    await ctx.db.patch(userId, { orgs, teams, membershipCheckedAt: Date.now() });
  },
});

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
