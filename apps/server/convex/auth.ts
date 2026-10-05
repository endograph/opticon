import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type ActionCtx, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { randomToken, requireUser, sha256, userForToken } from "./lib";

const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const CLI_LOGIN_TTL_MS = 10 * 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;

// --- queries and mutations used by clients ----------------------------------

export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userForToken(ctx, token);
    if (!user) return null;
    return { login: user.login, name: user.name, avatarUrl: user.avatarUrl, liveSync: user.liveSync ?? true };
  },
});

export const setLiveSync = mutation({
  args: { token: v.string(), liveSync: v.boolean() },
  handler: async (ctx, { token, liveSync }) => {
    const user = await requireUser(ctx, token);
    await ctx.db.patch(user._id, { liveSync });
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const hash = await sha256(token);
    const found = await ctx.db
      .query("tokens")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (found) await ctx.db.delete(found._id);
  },
});

/** Shown on the approval page so the user can match it against their terminal. */
export const cliLogin = query({
  args: { token: v.optional(v.string()), userCode: v.string() },
  handler: async (ctx, { token, userCode }) => {
    const login = await ctx.db
      .query("cliLogins")
      .withIndex("by_user_code", (q) => q.eq("userCode", userCode.toUpperCase()))
      .unique();
    if (!login || login.expiresAt < Date.now()) return { status: "expired" as const };
    if (login.approvedBy) return { status: "approved" as const };
    const user = await userForToken(ctx, token);
    return { status: "pending" as const, label: login.label, signedIn: !!user };
  },
});

export const approveCliLogin = mutation({
  args: { token: v.string(), userCode: v.string() },
  handler: async (ctx, { token, userCode }) => {
    const user = await requireUser(ctx, token);
    const login = await ctx.db
      .query("cliLogins")
      .withIndex("by_user_code", (q) => q.eq("userCode", userCode.toUpperCase()))
      .unique();
    if (!login || login.expiresAt < Date.now()) throw new ConvexError({ code: "expired" });
    await ctx.db.patch(login._id, { approvedBy: user._id });
  },
});

// --- internals used by HTTP actions -----------------------------------------

const SWEEP_BATCH = 500;

/** Deletes sign-ins that were started and never finished. Runs from a cron. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    let more = false;
    for (const table of ["oauthStates", "cliLogins"] as const) {
      const expired = await ctx.db
        .query(table)
        .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
        .take(SWEEP_BATCH);
      for (const row of expired) await ctx.db.delete(row._id);
      more ||= expired.length === SWEEP_BATCH;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.auth.sweepExpired, {});
  },
});

export const saveOauthState = internalMutation({
  args: { state: v.string(), redirect: v.string(), nonce: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("oauthStates", { ...args, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  },
});

export const consumeOauthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    return row.expiresAt > Date.now() && row.nonce ? { redirect: row.redirect, nonce: row.nonce } : null;
  },
});

export const upsertUser = internalMutation({
  args: {
    githubId: v.number(),
    login: v.string(),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    githubToken: v.optional(v.string()),
    githubTokenExpiresAt: v.optional(v.number()),
    githubRefreshToken: v.optional(v.string()),
    githubRefreshTokenExpiresAt: v.optional(v.number()),
    /** The allowed org sign-in just confirmed, on org-limited instances. */
    memberOf: v.optional(v.string()),
  },
  handler: async (ctx, { memberOf, ...args }) => {
    const login = args.login.toLowerCase();
    const now = Date.now();
    const member = memberOf ? { memberOf, memberVerifiedAt: now, memberCheckedAt: now } : {};
    const existing = await ctx.db
      .query("users")
      .withIndex("by_github_id", (q) => q.eq("githubId", args.githubId))
      .unique();
    if (existing) {
      // A new token may have different org grants, so cached membership is no longer trusted.
      await ctx.db.patch(existing._id, {
        ...args, login, membershipCheckedAt: undefined,
        githubTokenExpiresAt: args.githubTokenExpiresAt,
        githubRefreshToken: args.githubRefreshToken,
        githubRefreshTokenExpiresAt: args.githubRefreshTokenExpiresAt,
        githubRefreshUntil: undefined,
        ...member,
      });
      return existing._id;
    }
    return ctx.db.insert("users", { ...args, login, ...member });
  },
});

export const storeToken = internalMutation({
  args: {
    hash: v.string(),
    userId: v.id("users"),
    kind: v.union(v.literal("web"), v.literal("cli")),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tokens", { ...args, expiresAt: args.kind === "web" ? Date.now() + WEB_SESSION_TTL_MS : undefined });
  },
});

export const createCliLogin = internalMutation({
  args: { userCode: v.string(), pollHash: v.string(), label: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("cliLogins", { ...args, expiresAt: Date.now() + CLI_LOGIN_TTL_MS });
  },
});

/** Returns the approving user once, deleting the request so a poll secret can't mint two tokens. */
export const takeApprovedCliLogin = internalMutation({
  args: { pollHash: v.string() },
  handler: async (ctx, { pollHash }) => {
    const login = await ctx.db
      .query("cliLogins")
      .withIndex("by_poll_hash", (q) => q.eq("pollHash", pollHash))
      .unique();
    if (!login || login.expiresAt < Date.now()) return { status: "expired" as const };
    if (!login.approvedBy) return { status: "pending" as const };
    await ctx.db.delete(login._id);
    const user = await ctx.db.get(login.approvedBy);
    return user ? { status: "approved" as const, userId: user._id, login: user.login, label: login.label } : { status: "expired" as const };
  },
});

export const githubToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => githubCredentials(await userForToken(ctx, token)),
});

export const githubTokenForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => githubCredentials(await ctx.db.get(userId)),
});

function githubCredentials(user: Doc<"users"> | null) {
  return user ? {
    userId: user._id, login: user.login, githubToken: user.githubToken,
    expiresAt: user.githubTokenExpiresAt,
    refreshToken: user.githubRefreshToken,
    refreshExpiresAt: user.githubRefreshTokenExpiresAt,
  } : null;
}

/** Serialize refreshes: GitHub invalidates the old refresh token after use. */
export const claimGithubRefresh = internalMutation({
  args: { userId: v.id("users"), refreshToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, refreshToken }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.githubRefreshToken !== refreshToken || (user.githubRefreshUntil ?? 0) > Date.now()) return false;
    await ctx.db.patch(userId, { githubRefreshUntil: Date.now() + 60_000 });
    return true;
  },
});

/** A new sign-in wins over an in-flight refresh from the previous sign-in. */
export const finishGithubRefresh = internalMutation({
  args: {
    userId: v.id("users"), previousRefreshToken: v.string(),
    credentials: v.optional(v.object({
      token: v.string(), expiresAt: v.number(), refreshToken: v.string(), refreshExpiresAt: v.number(),
    })),
  },
  returns: v.boolean(),
  handler: async (ctx, { userId, previousRefreshToken, credentials }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.githubRefreshToken !== previousRefreshToken) return false;
    await ctx.db.patch(userId, {
      githubRefreshUntil: undefined,
      ...(credentials ? {
        githubToken: credentials.token, githubTokenExpiresAt: credentials.expiresAt,
        githubRefreshToken: credentials.refreshToken, githubRefreshTokenExpiresAt: credentials.refreshExpiresAt,
      } : {}),
    });
    return true;
  },
});

/** Mints a token for a user. Actions only: needs real randomness. */
export async function issueToken(ctx: ActionCtx, userId: string, kind: "web" | "cli", label?: string): Promise<string> {
  const token = randomToken();
  await ctx.runMutation(internal.auth.storeToken, { hash: await sha256(token), userId: userId as never, kind, label });
  return token;
}
