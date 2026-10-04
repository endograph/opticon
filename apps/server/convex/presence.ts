import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { recordView } from "./follows";
import { PRESENCE_TTL_MS, canView, userForToken } from "./lib";
import { shareBySlug } from "./shares";

/**
 * Viewers call this every ~15s while a share is open. Presence drives live sync: the owner's
 * daemon only uploads while at least one presence row exists. Rows expire on a timer instead
 * of being filtered by time in queries, so `liveDemand` stays purely reactive. For signed-in
 * viewers it also records the view in their Following history.
 */
export const heartbeat = mutation({
  args: { slug: v.string(), viewerId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, viewerId, token }) => {
    const share = await shareBySlug(ctx, slug);
    if (!share) throw new ConvexError({ code: "not_found" });
    const user = await userForToken(ctx, token);
    if (!(await canView(ctx, share, user)).ok) throw new ConvexError({ code: "forbidden" });
    if (user) await recordView(ctx, user, share);
    const now = Date.now();
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_share_viewer", (q) => q.eq("shareId", share._id).eq("viewerId", viewerId))
      .unique();
    const id = existing ? existing._id : await ctx.db.insert("presence", { shareId: share._id, viewerId, lastSeen: now });
    if (existing) await ctx.db.patch(id, { lastSeen: now });
    await ctx.scheduler.runAfter(PRESENCE_TTL_MS, internal.presence.expire, { id, lastSeen: now });
  },
});

/** Also records a final view, so events seen since the last heartbeat don't show as unread. */
export const leave = mutation({
  args: { slug: v.string(), viewerId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, viewerId, token }) => {
    const share = await shareBySlug(ctx, slug);
    if (!share) return;
    const user = await userForToken(ctx, token);
    if (user && (await canView(ctx, share, user)).ok) await recordView(ctx, user, share);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_share_viewer", (q) => q.eq("shareId", share._id).eq("viewerId", viewerId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Scheduled by each heartbeat; a no-op if a later heartbeat refreshed the row. */
export const expire = internalMutation({
  args: { id: v.id("presence"), lastSeen: v.number() },
  handler: async (ctx, { id, lastSeen }) => {
    const row = await ctx.db.get(id);
    if (row && row.lastSeen === lastSeen) await ctx.db.delete(id);
  },
});
