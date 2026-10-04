import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, type MutationCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { type GithubCredentials, githubHeaders, saveVisibility } from "./access";

/** How long a verified grant is trusted before the cron checks it again. */
export const REPO_TTL_MS = 24 * 60 * 60_000;
const RECHECK_BATCH = 100;

/** `github.com/Owner/Name`, as the daemon normalizes remotes, to `owner/name`. Null for anything else. */
export function parseRepoClaim(claim: string): string | null {
  const match = /^github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(claim);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * Resolves the repo a daemon claims for a share. Returns the canonical repo when the user can
 * push to it, null when they can't (or it can't be verified), and undefined when GitHub couldn't
 * answer, in which case the share keeps whatever it had.
 */
export async function verifyRepoClaim(ctx: ActionCtx, token: string, claim: string | undefined): Promise<string | null | undefined> {
  const repo = claim ? parseRepoClaim(claim) : null;
  if (!repo) return null;
  const credentials = await ctx.runQuery(internal.auth.githubToken, { token });
  if (!credentials) return null;
  if (await ctx.runQuery(internal.repos.freshGrant, { userId: credentials.userId, repo })) return repo;
  try {
    const pushable = await pushableRepo(ctx, credentials, repo);
    await ctx.runMutation(internal.repos.settle, { userId: credentials.userId, repo, ...pushable });
    return pushable.canonical;
  } catch (error) {
    console.warn(`Couldn't verify ${repo}: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Re-verifies grants older than REPO_TTL_MS, and with them whether each repo is public. Lost
 * access unlinks the user's shares from the repo; a renamed repo moves them. Grants GitHub can't
 * answer for are retried next run.
 */
export const recheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.runQuery(internal.repos.staleGrants, { before: Date.now() - REPO_TTL_MS, limit: RECHECK_BATCH });
    for (const grant of stale) {
      const credentials = await ctx.runQuery(internal.auth.githubTokenForUser, { userId: grant.userId });
      try {
        const pushable = credentials ? await pushableRepo(ctx, credentials, grant.repo) : { canonical: null };
        await ctx.runMutation(internal.repos.settle, { userId: grant.userId, repo: grant.repo, ...pushable });
      } catch (error) {
        console.warn(`Couldn't re-verify ${grant.repo}: ${(error as Error).message}`);
      }
    }
  },
});

/**
 * The canonical `owner/name` if the user can push to `repo`, else null, and whether it's private.
 * GitHub follows renames, so it may differ from `repo`. Throws when GitHub can't answer.
 */
async function pushableRepo(
  ctx: ActionCtx,
  credentials: GithubCredentials,
  repo: string,
): Promise<{ canonical: string | null; private?: boolean }> {
  const headers = await githubHeaders(ctx, credentials);
  if (!headers) return { canonical: null };
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 401 || res.status === 404) return { canonical: null };
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const body = (await res.json()) as { full_name: string; private: boolean; permissions?: { push?: boolean } };
  return { canonical: body.permissions?.push ? body.full_name.toLowerCase() : null, private: body.private };
}

export const freshGrant = internalQuery({
  args: { userId: v.id("users"), repo: v.string() },
  handler: async (ctx, { userId, repo }) => {
    const grant = await ctx.db
      .query("repoAccess")
      .withIndex("by_user_repo", (q) => q.eq("userId", userId).eq("repo", repo))
      .unique();
    return !!grant && Date.now() - grant.checkedAt < REPO_TTL_MS;
  },
});

export const staleGrants = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, { before, limit }) =>
    ctx.db
      .query("repoAccess")
      .withIndex("by_checked", (q) => q.lt("checkedAt", before))
      .take(limit),
});

/**
 * Records the result of checking `repo` for a user: `canonical` is the verified repo (possibly
 * renamed) or null, and `private` its visibility when GitHub said. The user's shares linked to
 * `repo` follow it.
 */
export const settle = internalMutation({
  args: { userId: v.id("users"), repo: v.string(), canonical: v.union(v.string(), v.null()), private: v.optional(v.boolean()) },
  handler: async (ctx, { userId, repo, canonical, private: isPrivate }) => {
    if (canonical) await saveGrant(ctx, userId, canonical);
    if (canonical && isPrivate !== undefined) await saveVisibility(ctx, canonical, isPrivate);
    if (canonical === repo) return;
    const grant = await ctx.db
      .query("repoAccess")
      .withIndex("by_user_repo", (q) => q.eq("userId", userId).eq("repo", repo))
      .unique();
    if (grant) await ctx.db.delete(grant._id);
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    for (const share of shares) if (share.repo === repo) await ctx.db.patch(share._id, { repo: canonical ?? undefined });
  },
});

async function saveGrant(ctx: MutationCtx, userId: Id<"users">, repo: string) {
  const grant = await ctx.db
    .query("repoAccess")
    .withIndex("by_user_repo", (q) => q.eq("userId", userId).eq("repo", repo))
    .unique();
  if (grant) await ctx.db.patch(grant._id, { checkedAt: Date.now() });
  else await ctx.db.insert("repoAccess", { userId, repo, checkedAt: Date.now() });
}
