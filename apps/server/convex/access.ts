import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
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
    const headers = { authorization: `Bearer ${viewer.githubToken}`, accept: "application/vnd.github+json", "user-agent": "opticon" };
    const orgs = (await paginate<{ login: string }>("https://api.github.com/user/orgs", headers)).map((o) => o.login.toLowerCase());
    const teams = (await paginate<{ slug: string; organization: { login: string } }>("https://api.github.com/user/teams", headers)).map(
      (t) => `${t.organization.login}/${t.slug}`.toLowerCase(),
    );
    await ctx.runMutation(internal.access.saveMemberships, { userId: viewer.userId, orgs, teams, force: force ?? false });
    return { orgs, teams };
  },
});

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
    if (!res.ok) break;
    results.push(...((await res.json()) as T[]));
    next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return results;
}
