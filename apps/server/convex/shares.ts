import { MAX_SHARED_TEXT, normalizeAccess } from "@opticon/core/protocol";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, action, internalMutation, mutation, query } from "./_generated/server";
import { decideAccess, randomToken, requireProtocol, requireUser, userForToken } from "./lib";
import { accessValidator, sharedEventValidator } from "./schema";

const MAX_BATCH = 500;
const CHANGES_PAGE = 500;
const DELETE_BATCH = 500;

const provider = v.union(v.literal("claude"), v.literal("codex"));

// --- owner (daemon) ---------------------------------------------------------

/** Creates a share, or updates access on the existing share for this session. */
export const create = action({
  args: {
    token: v.string(),
    protocol: v.number(),
    provider,
    sessionId: v.string(),
    title: v.optional(v.string()),
    project: v.optional(v.string()),
    access: accessValidator,
  },
  handler: async (ctx, { protocol, ...args }): Promise<{ shareId: Id<"shares">; slug: string }> => {
    requireProtocol(protocol);
    // Slugs are generated here because only actions get unpredictable randomness.
    return ctx.runMutation(internal.shares.upsert, { ...args, slug: randomToken(16) });
  },
});

export const upsert = internalMutation({
  args: {
    token: v.string(),
    provider,
    sessionId: v.string(),
    title: v.optional(v.string()),
    project: v.optional(v.string()),
    access: accessValidator,
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.token);
    const access = normalizeAccess(args.access);
    const existing = await ctx.db
      .query("shares")
      .withIndex("by_owner_session", (q) => q.eq("ownerId", user._id).eq("provider", args.provider).eq("sessionId", args.sessionId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { access, title: args.title, project: args.project, updatedAt: Date.now() });
      return { shareId: existing._id, slug: existing.slug };
    }
    const shareId = await ctx.db.insert("shares", {
      slug: args.slug,
      ownerId: user._id,
      provider: args.provider,
      sessionId: args.sessionId,
      title: args.title,
      project: args.project,
      access,
      eventCount: 0,
      nextSeq: 0,
      rev: 0,
      updatedAt: Date.now(),
    });
    return { shareId, slug: args.slug };
  },
});

/** Inserts or replaces events by id. Unchanged events are skipped, so re-sending a snapshot is cheap. */
export const append = mutation({
  args: {
    token: v.string(),
    protocol: v.number(),
    shareId: v.id("shares"),
    title: v.optional(v.string()),
    events: v.array(sharedEventValidator),
  },
  handler: async (ctx, args) => {
    requireProtocol(args.protocol);
    const share = await ownShare(ctx, args.token, args.shareId);
    if (args.events.length > MAX_BATCH) throw new ConvexError({ code: "batch_too_large", max: MAX_BATCH });
    let { nextSeq, rev, eventCount } = share;
    let changed = 0;
    for (const event of args.events) {
      if (event.kind !== "tool" && event.text.length > MAX_SHARED_TEXT) throw new ConvexError({ code: "event_too_large" });
      const existing = await ctx.db
        .query("shareEvents")
        .withIndex("by_share_event", (q) => q.eq("shareId", share._id).eq("eventId", event.id))
        .unique();
      if (existing && sameEvent(existing.event, event)) continue;
      rev += 1;
      changed += 1;
      if (existing) {
        await ctx.db.patch(existing._id, { event, rev });
      } else {
        await ctx.db.insert("shareEvents", { shareId: share._id, eventId: event.id, seq: nextSeq++, rev, event });
        eventCount += 1;
      }
    }
    const titleChanged = args.title !== undefined && args.title !== share.title;
    if (changed || titleChanged) {
      await ctx.db.patch(share._id, { nextSeq, rev, eventCount, updatedAt: Date.now(), ...(titleChanged ? { title: args.title } : {}) });
    }
    return { changed };
  },
});

export const setAccess = mutation({
  args: { token: v.string(), shareId: v.id("shares"), access: accessValidator },
  handler: async (ctx, { token, shareId, access }) => {
    const share = await ownShare(ctx, token, shareId);
    await ctx.db.patch(share._id, { access: normalizeAccess(access), updatedAt: Date.now() });
  },
});

/** Unsharing deletes the server copy. The share disappears immediately; events are purged in batches. */
export const remove = mutation({
  args: { token: v.string(), shareId: v.id("shares") },
  handler: async (ctx, { token, shareId }) => {
    const share = await ownShare(ctx, token, shareId);
    await ctx.db.delete(share._id);
    await ctx.scheduler.runAfter(0, internal.shares.purge, { shareId: share._id });
  },
});

export const purge = internalMutation({
  args: { shareId: v.id("shares") },
  handler: async (ctx, { shareId }) => {
    const events = await ctx.db
      .query("shareEvents")
      .withIndex("by_share_rev", (q) => q.eq("shareId", shareId))
      .take(DELETE_BATCH);
    for (const e of events) await ctx.db.delete(e._id);
    const viewers = await ctx.db
      .query("presence")
      .withIndex("by_share", (q) => q.eq("shareId", shareId))
      .collect();
    for (const p of viewers) await ctx.db.delete(p._id);
    if (events.length === DELETE_BATCH) await ctx.scheduler.runAfter(0, internal.shares.purge, { shareId });
  },
});

/** The owner's shares with live viewer counts. */
export const mine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
    return Promise.all(
      shares.map(async (s) => ({
        shareId: s._id,
        slug: s.slug,
        provider: s.provider,
        sessionId: s.sessionId,
        title: s.title,
        access: s.access,
        eventCount: s.eventCount,
        updatedAt: s.updatedAt,
        viewers: await viewerCount(ctx, s._id),
      })),
    );
  },
});

/**
 * Shares the daemon should keep in sync right now: those with at least one connected viewer,
 * unless the owner turned live sync off. The daemon subscribes to this.
 */
export const liveDemand = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    if (user.liveSync === false) return [];
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
    const demanded = [];
    for (const s of shares) {
      const viewer = await ctx.db
        .query("presence")
        .withIndex("by_share", (q) => q.eq("shareId", s._id))
        .first();
      if (viewer) demanded.push({ shareId: s._id, provider: s.provider, sessionId: s.sessionId });
    }
    return demanded;
  },
});

// --- viewers ----------------------------------------------------------------

export const view = query({
  args: { slug: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, token }) => {
    const share = await shareBySlug(ctx, slug);
    if (!share) return { status: "not_found" as const };
    const viewer = await userForToken(ctx, token);
    const decision = decideAccess(share.access, share.ownerId, viewer);
    if (!decision.ok) {
      return { status: decision.reason, stale: decision.reason === "forbidden" && decision.stale, signedInAs: viewer?.login };
    }
    const owner = await ctx.db.get(share.ownerId);
    return {
      status: "ok" as const,
      share: {
        title: share.title,
        project: share.project,
        provider: share.provider,
        eventCount: share.eventCount,
        rev: share.rev,
        updatedAt: share.updatedAt,
        isOwner: viewer?._id === share.ownerId,
        access: viewer?._id === share.ownerId ? share.access : undefined,
      },
      owner: owner && { login: owner.login, name: owner.name, avatarUrl: owner.avatarUrl },
      viewers: await viewerCount(ctx, share._id),
    };
  },
});

/**
 * Events changed after `afterRev`, oldest change first. Viewers page through from 0 to load the
 * share, then keep a subscription open at their latest rev to receive live changes.
 */
export const changes = query({
  args: { slug: v.string(), token: v.optional(v.string()), afterRev: v.number() },
  handler: async (ctx, { slug, token, afterRev }) => {
    const share = await shareBySlug(ctx, slug);
    if (!share) return null;
    if (!decideAccess(share.access, share.ownerId, await userForToken(ctx, token)).ok) return null;
    const rows = await ctx.db
      .query("shareEvents")
      .withIndex("by_share_rev", (q) => q.eq("shareId", share._id).gt("rev", afterRev))
      .take(CHANGES_PAGE);
    return {
      events: rows.map((r) => ({ seq: r.seq, event: r.event })),
      rev: rows.at(-1)?.rev ?? afterRev,
      more: rows.length === CHANGES_PAGE,
    };
  },
});

// --- helpers ----------------------------------------------------------------

async function ownShare(ctx: QueryCtx, token: string, shareId: Id<"shares">): Promise<Doc<"shares">> {
  const user = await requireUser(ctx, token);
  const share = await ctx.db.get(shareId);
  if (!share || share.ownerId !== user._id) throw new ConvexError({ code: "not_found" });
  return share;
}

export async function shareBySlug(ctx: QueryCtx, slug: string): Promise<Doc<"shares"> | null> {
  return ctx.db
    .query("shares")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

async function viewerCount(ctx: QueryCtx, shareId: Id<"shares">): Promise<number> {
  return (
    await ctx.db
      .query("presence")
      .withIndex("by_share", (q) => q.eq("shareId", shareId))
      .collect()
  ).length;
}

/** Key-order independent: stored documents don't promise to keep field order. */
function sameEvent(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
