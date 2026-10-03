import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const accessValidator = v.object({
  anyone: v.boolean(),
  users: v.array(v.string()),
  orgs: v.array(v.string()),
  teams: v.array(v.string()),
});

export const sharedEventValidator = v.union(
  v.object({
    kind: v.literal("message"),
    id: v.string(),
    timestamp: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
  }),
  v.object({
    kind: v.literal("tool"),
    id: v.string(),
    timestamp: v.optional(v.string()),
    category: v.union(v.literal("tool"), v.literal("mcp"), v.literal("skill"), v.literal("plugin"), v.literal("subagent")),
    name: v.string(),
    status: v.union(v.literal("running"), v.literal("ok"), v.literal("error")),
  }),
  v.object({
    kind: v.literal("notice"),
    id: v.string(),
    timestamp: v.optional(v.string()),
    level: v.union(v.literal("info"), v.literal("error")),
    text: v.string(),
  }),
);

export default defineSchema({
  users: defineTable({
    githubId: v.number(),
    /** Lowercase GitHub login. */
    login: v.string(),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    /** OAuth token with read:org, used only to check this user's own org and team membership. */
    githubToken: v.optional(v.string()),
    /** Cached membership, refreshed by access.refreshMemberships. */
    orgs: v.optional(v.array(v.string())),
    teams: v.optional(v.array(v.string())),
    membershipCheckedAt: v.optional(v.number()),
    /** "Live sync shared sessions". Defaults to on. */
    liveSync: v.optional(v.boolean()),
  })
    .index("by_github_id", ["githubId"])
    .index("by_login", ["login"]),

  /** Bearer tokens. Only SHA-256 hashes are stored. */
  tokens: defineTable({
    hash: v.string(),
    userId: v.id("users"),
    kind: v.union(v.literal("web"), v.literal("cli")),
    label: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_user", ["userId"]),

  oauthStates: defineTable({
    state: v.string(),
    redirect: v.string(),
    expiresAt: v.number(),
  }).index("by_state", ["state"]),

  /** Pending `opticon login` requests, approved from the web. */
  cliLogins: defineTable({
    userCode: v.string(),
    pollHash: v.string(),
    label: v.string(),
    expiresAt: v.number(),
    approvedBy: v.optional(v.id("users")),
  })
    .index("by_user_code", ["userCode"])
    .index("by_poll_hash", ["pollHash"]),

  shares: defineTable({
    /** Unguessable link id; for `anyone` shares, possession of the link is the credential. */
    slug: v.string(),
    ownerId: v.id("users"),
    provider: v.union(v.literal("claude"), v.literal("codex")),
    sessionId: v.string(),
    title: v.optional(v.string()),
    /** Project directory name only, never the full path. */
    project: v.optional(v.string()),
    access: accessValidator,
    eventCount: v.number(),
    /** Position counter: an event's seq is fixed when it first appears. */
    nextSeq: v.number(),
    /** Change counter: bumped on every insert or update, so viewers can follow changes. */
    rev: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_owner", ["ownerId"])
    .index("by_owner_session", ["ownerId", "provider", "sessionId"]),

  shareEvents: defineTable({
    shareId: v.id("shares"),
    eventId: v.string(),
    seq: v.number(),
    rev: v.number(),
    event: sharedEventValidator,
  })
    .index("by_share_event", ["shareId", "eventId"])
    .index("by_share_rev", ["shareId", "rev"]),

  /** One row per connected viewer, removed when its heartbeat lapses. */
  presence: defineTable({
    shareId: v.id("shares"),
    viewerId: v.string(),
    lastSeen: v.number(),
  })
    .index("by_share", ["shareId"])
    .index("by_share_viewer", ["shareId", "viewerId"]),
});
