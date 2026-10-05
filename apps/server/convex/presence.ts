import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation } from "./_generated/server";
import { recordView } from "./follows";
import { PRESENCE_TTL_MS, canView, userForToken } from "./lib";
import { shareBySlug } from "./shares";

/**
 * Viewers call this every ~15s while a share is open. Presence drives live sync: the owner's
 * daemon only uploads while a share is `watched`. A heartbeat only refreshes its own presence
 * row, which no query reads, so it re-runs nothing; arriving and leaving change the count. For
 * signed-in viewers it also records the view in their Following history.
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
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeen: now });
      return;
    }
    const id = await ctx.db.insert("presence", { shareId: share._id, viewerId, lastSeen: now });
    await countViewer(ctx, share, 1);
    await ctx.scheduler.runAfter(PRESENCE_TTL_MS, internal.presence.expire, { id });
  },
});

/** Also records a final view, so events seen since the last heartbeat don't show as unread. */
export const leave = mutation({
  args: { slug: v.string(), viewerId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, viewerId, token }) => {
    const share = await shareBySlug(ctx, slug);
    if (!share) return;
    const user = await userForToken(ctx, token);
    if (user && (await canView(ctx, share, user)).ok) await recordView(ctx, user, share, { final: true });
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_share_viewer", (q) => q.eq("shareId", share._id).eq("viewerId", viewerId))
      .unique();
    if (!existing) return;
    await ctx.db.delete(existing._id);
    await countViewer(ctx, share, -1);
  },
});

/** Scheduled once per viewer. Removes it once its heartbeats lapse, else checks again when they would. */
export const expire = internalMutation({
  args: { id: v.id("presence") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    const remaining = row.lastSeen + PRESENCE_TTL_MS - Date.now();
    if (remaining > 0) {
      await ctx.scheduler.runAfter(remaining, internal.presence.expire, { id });
      return;
    }
    await ctx.db.delete(id);
    const share = await ctx.db.get(row.shareId);
    if (share) await countViewer(ctx, share, -1);
  },
});

async function countViewer(ctx: MutationCtx, share: Doc<"shares">, delta: 1 | -1): Promise<void> {
  const row = await watchedRow(ctx, share._id);
  const viewers = (row?.viewers ?? 0) + delta;
  if (viewers <= 0) {
    if (row) await ctx.db.delete(row._id);
  } else if (row) {
    await ctx.db.patch(row._id, { viewers });
  } else {
    await ctx.db.insert("watched", { shareId: share._id, ownerId: share.ownerId, viewers });
  }
}

function watchedRow(ctx: MutationCtx, shareId: Id<"shares">) {
  return ctx.db
    .query("watched")
    .withIndex("by_share", (q) => q.eq("shareId", shareId))
    .unique();
}
