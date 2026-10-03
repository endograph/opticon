import { MAX_SHARED_TEXT, PRIVATE_ACCESS, normalizeAccess } from "@opticon/core/protocol";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, action, internalMutation, mutation, query } from "./_generated/server";
import { followRow } from "./follows";
import { decideAccess, randomToken, requireProtocol, requireUser, userForToken } from "./lib";
import { accessValidator, sharedEventValidator } from "./schema";

const MAX_BATCH = 500;
const CHANGES_PAGE = 500;
const DELETE_BATCH = 500;
const FEED_LIMIT = 30;
const PROFILE_LIMIT = 100;

const provider = v.union(v.literal("claude"), v.literal("codex"));

// --- owner (daemon) ---------------------------------------------------------

/**
 * Creates a share, or updates access on the existing share for this session. `auto` (autosync)
 * only ever creates: it leaves an existing share alone and is rejected for deleted ones. An
 * explicit share of a deleted session replaces the tombstone with a fresh share and link.
 * `discoverable` lists the share publicly; it only takes effect with link access.
 */
export const create = action({
  args: {
    token: v.string(),
    protocol: v.number(),
    provider,
    sessionId: v.string(),
    title: v.optional(v.string()),
    project: v.optional(v.string()),
    access: accessValidator,
    auto: v.optional(v.boolean()),
    discoverable: v.optional(v.boolean()),
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
    auto: v.optional(v.boolean()),
    discoverable: v.optional(v.boolean()),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.token);
    const access = normalizeAccess(args.access);
    const existing = await ctx.db
      .query("shares")
      .withIndex("by_owner_session", (q) => q.eq("ownerId", user._id).eq("provider", args.provider).eq("sessionId", args.sessionId))
      .unique();
    if (existing?.deletedAt !== undefined) {
      if (args.auto) throw new ConvexError({ code: "deleted" });
      // Its events and follows are already being purged by id; the new share starts clean.
      await ctx.db.delete(existing._id);
    } else if (existing) {
      if (!args.auto) {
        const discoverable = access.anyone && (args.discoverable ?? existing.discoverable ?? false);
        await ctx.db.patch(existing._id, { access, discoverable, title: args.title, project: args.project, updatedAt: Date.now() });
      }
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
      auto: args.auto,
      discoverable: access.anyone && !!args.discoverable,
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
    const normalized = normalizeAccess(access);
    // Narrowing access also unlists the share.
    await ctx.db.patch(share._id, { access: normalized, discoverable: normalized.anyone && !!share.discoverable, updatedAt: Date.now() });
  },
});

/** Lists or unlists a share on the owner's profile and the public feed. Needs link access. */
export const setDiscoverable = mutation({
  args: { token: v.string(), shareId: v.id("shares"), discoverable: v.boolean() },
  handler: async (ctx, { token, shareId, discoverable }) => {
    const share = await ownShare(ctx, token, shareId);
    if (discoverable && !share.access.anyone) throw new ConvexError({ code: "not_public" });
    await ctx.db.patch(share._id, { discoverable });
  },
});

/**
 * Deletes the server copy and remembers that, so autosync leaves the session alone. The share
 * disappears immediately; events are purged in batches. (Unsharing is `setAccess` to private.)
 */
export const remove = mutation({
  args: { token: v.string(), shareId: v.id("shares") },
  handler: async (ctx, { token, shareId }) => {
    const share = await ownShare(ctx, token, shareId);
    const now = Date.now();
    await ctx.db.patch(share._id, { deletedAt: now, access: PRIVATE_ACCESS, discoverable: false, eventCount: 0, updatedAt: now });
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
    const follows = await ctx.db
      .query("follows")
      .withIndex("by_share", (q) => q.eq("shareId", shareId))
      .take(DELETE_BATCH);
    for (const f of follows) await ctx.db.delete(f._id);
    if (events.length === DELETE_BATCH || follows.length === DELETE_BATCH) await ctx.scheduler.runAfter(0, internal.shares.purge, { shareId });
  },
});

/** The owner's shares with live viewer counts. */
export const mine = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    const shares = await ownerShares(ctx, user._id);
    return Promise.all(
      shares.map(async (s) => ({
        shareId: s._id,
        slug: s.slug,
        provider: s.provider,
        sessionId: s.sessionId,
        title: s.title,
        access: s.access,
        auto: s.auto ?? false,
        discoverable: s.discoverable ?? false,
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
    const shares = await ownerShares(ctx, user._id);
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

/** Sessions whose shares the owner deleted. The daemon skips these instead of uploading. */
export const deleted = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireUser(ctx, token);
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
    return shares.filter((s) => s.deletedAt !== undefined).map((s) => ({ provider: s.provider, sessionId: s.sessionId }));
  },
});

// --- discovery --------------------------------------------------------------

/** The most recently active discoverable shares, from everyone. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_discoverable", (q) => q.eq("discoverable", true))
      .order("desc")
      .take(FEED_LIMIT);
    return Promise.all(shares.map((s) => publicSummary(ctx, s)));
  },
});

/** A user's public profile: who they are and their discoverable shares, most recent first. */
export const profile = query({
  args: { login: v.string() },
  handler: async (ctx, { login }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_login", (q) => q.eq("login", login.toLowerCase()))
      .unique();
    if (!user) return null;
    const shares = await ctx.db
      .query("shares")
      .withIndex("by_owner_discoverable", (q) => q.eq("ownerId", user._id).eq("discoverable", true))
      .order("desc")
      .take(PROFILE_LIMIT);
    return {
      user: { login: user.login, name: user.name, avatarUrl: user.avatarUrl },
      shares: await Promise.all(shares.map((s) => publicSummary(ctx, s))),
    };
  },
});

async function publicSummary(ctx: QueryCtx, share: Doc<"shares">) {
  const owner = await ctx.db.get(share.ownerId);
  return {
    slug: share.slug,
    title: share.title,
    project: share.project,
    provider: share.provider,
    updatedAt: share.updatedAt,
    eventCount: share.eventCount,
    viewers: await viewerCount(ctx, share._id),
    owner: owner && { login: owner.login, avatarUrl: owner.avatarUrl },
  };
}

// --- viewers ----------------------------------------------------------------

export const view = query({
  args: { slug: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, token }) => {
    const share = await shareBySlug(ctx, slug);
    if (!share) return { status: "not_found" as const };
    const viewer = await userForToken(ctx, token);
    const decision = decideAccess(share.access, share.ownerId, viewer);
    if (!decision.ok) {
      if (decision.reason === "login_required") return { status: "login_required" as const };
      return { status: "forbidden" as const, stale: decision.stale, signedInAs: viewer?.login };
    }
    const owner = await ctx.db.get(share.ownerId);
    const isOwner = viewer?._id === share.ownerId;
    const follow = viewer && !isOwner ? await followRow(ctx, viewer._id, share._id) : null;
    return {
      status: "ok" as const,
      share: {
        title: share.title,
        project: share.project,
        provider: share.provider,
        eventCount: share.eventCount,
        rev: share.rev,
        updatedAt: share.updatedAt,
        isOwner,
        access: isOwner ? share.access : undefined,
        /** Undefined when signed out or the owner; otherwise whether the viewer follows this share. */
        following: viewer && !isOwner ? (follow?.following ?? false) : undefined,
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
  if (share.deletedAt !== undefined) throw new ConvexError({ code: "deleted" });
  return share;
}

async function ownerShares(ctx: QueryCtx, ownerId: Id<"users">): Promise<Doc<"shares">[]> {
  const shares = await ctx.db
    .query("shares")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .collect();
  return shares.filter((s) => s.deletedAt === undefined);
}

/** Live shares only: a deleted share's link behaves as if it never existed. */
export async function shareBySlug(ctx: QueryCtx, slug: string): Promise<Doc<"shares"> | null> {
  const share = await ctx.db
    .query("shares")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  return share?.deletedAt === undefined ? share : null;
}

export async function viewerCount(ctx: QueryCtx, shareId: Id<"shares">): Promise<number> {
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
