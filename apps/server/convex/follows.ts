import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import { canView, requireUser, viewChecker } from "./lib";
import { headFor, shareBySlug } from "./shares";

const LIST_LIMIT = 200;
/** Heartbeats re-record a view at most this often; leaving always records it. */
const VIEW_RECORD_MS = 5 * 60_000;

/**
 * Records that a signed-in viewer has someone else's share open, and how much of it they've seen.
 * Called from presence heartbeats, at most every VIEW_RECORD_MS so their Following list isn't
 * rewritten every few seconds, and on leaving (`final`). The first view follows the share; later
 * views never re-follow, so an unfollowed share stays unfollowed until followed again. Callers
 * check access.
 */
export async function recordView(ctx: MutationCtx, user: Doc<"users">, share: Doc<"shares">, { final = false } = {}): Promise<void> {
  if (share.ownerId === user._id) return;
  const existing = await followRow(ctx, user._id, share._id);
  const now = Date.now();
  if (existing && !final && now - existing.lastViewedAt < VIEW_RECORD_MS) return;
  // The live count: the share's own may trail it by up to ACTIVITY_MS, and unread never goes below 0.
  const seen = { lastViewedAt: now, seenEventCount: (await headFor(ctx, share)).eventCount };
  if (existing) await ctx.db.patch(existing._id, seen);
  else await ctx.db.insert("follows", { userId: user._id, shareId: share._id, following: true, ...seen });
}

export const setFollowing = mutation({
  args: { token: v.string(), slug: v.string(), following: v.boolean() },
  handler: async (ctx, { token, slug, following }) => {
    const user = await requireUser(ctx, token);
    const share = await shareBySlug(ctx, slug);
    if (!share) throw new ConvexError({ code: "not_found" });
    if (share.ownerId === user._id) return;
    const existing = await followRow(ctx, user._id, share._id);
    // Unfollowing needs no access, so shares listed as unavailable can still be removed.
    if (following && !(await canView(ctx, share, user)).ok) throw new ConvexError({ code: "forbidden" });
    if (existing) await ctx.db.patch(existing._id, { following });
    else await ctx.db.insert("follows", { userId: user._id, shareId: share._id, following, lastViewedAt: Date.now() });
  },
});

/**
 * Shares the viewer follows, most recently viewed first. Shares they can no longer open are
 * listed as unavailable, without details.
 */
export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    const rows = await ctx.db
      .query("follows")
      .withIndex("by_user_following", (q) => q.eq("userId", user._id).eq("following", true))
      .order("desc")
      .take(LIST_LIMIT);
    const checker = viewChecker(ctx, user);
    const followed = await Promise.all(
      rows.map(async (row) => {
        const summary = await shareSummary(ctx, await ctx.db.get(row.shareId), checker);
        if (!summary) return null;
        const unread = summary.available ? Math.max(0, summary.eventCount - (row.seenEventCount ?? summary.eventCount)) : 0;
        return { ...summary, lastViewedAt: row.lastViewedAt, unread };
      }),
    );
    return followed.filter((f) => f !== null);
  },
});

/**
 * Current details for a signed-out viewer's browser-stored history, checked as a signed-out
 * viewer: only shares anyone can open are available. Removed shares are left out.
 */
export const resolve = query({
  args: { slugs: v.array(v.string()) },
  handler: async (ctx, { slugs }) => {
    const checker = viewChecker(ctx, null);
    const resolved = await Promise.all(slugs.slice(0, LIST_LIMIT).map(async (slug) => shareSummary(ctx, await shareBySlug(ctx, slug), checker)));
    return resolved.filter((s) => s !== null);
  },
});

/** Merges browser-stored history into the account after sign-in. The account's follow choice wins where both exist. */
export const importLocal = mutation({
  args: {
    token: v.string(),
    entries: v.array(
      v.object({ slug: v.string(), lastViewedAt: v.number(), following: v.boolean(), seenEventCount: v.optional(v.number()) }),
    ),
  },
  handler: async (ctx, { token, entries }) => {
    const user = await requireUser(ctx, token);
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      const share = await shareBySlug(ctx, entry.slug);
      if (!share || share.ownerId === user._id || !(await canView(ctx, share, user)).ok) continue;
      const existing = await followRow(ctx, user._id, share._id);
      const lastViewedAt = Math.min(entry.lastViewedAt, Date.now());
      if (!existing) {
        await ctx.db.insert("follows", {
          userId: user._id,
          shareId: share._id,
          following: entry.following,
          lastViewedAt,
          seenEventCount: entry.seenEventCount,
        });
      } else if (lastViewedAt > existing.lastViewedAt) {
        await ctx.db.patch(existing._id, { lastViewedAt, seenEventCount: entry.seenEventCount ?? existing.seenEventCount });
      }
    }
  },
});

async function shareSummary(ctx: QueryCtx, share: Doc<"shares"> | null, checker: ReturnType<typeof viewChecker>) {
  if (!share || share.deletedAt !== undefined) return null;
  if (!(await checker.decide(share)).ok) return { slug: share.slug, available: false as const };
  const owner = await ctx.db.get(share.ownerId);
  return {
    slug: share.slug,
    available: true as const,
    title: share.title,
    project: share.project,
    repo: share.repo,
    provider: share.provider,
    updatedAt: share.updatedAt,
    eventCount: share.eventCount,
    owner: owner && { login: owner.login, avatarUrl: owner.avatarUrl },
  };
}

export async function followRow(ctx: QueryCtx, userId: Id<"users">, shareId: Id<"shares">): Promise<Doc<"follows"> | null> {
  return ctx.db
    .query("follows")
    .withIndex("by_user_share", (q) => q.eq("userId", userId).eq("shareId", shareId))
    .unique();
}
