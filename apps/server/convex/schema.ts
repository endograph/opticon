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
    githubTokenExpiresAt: v.optional(v.number()),
    githubRefreshToken: v.optional(v.string()),
    githubRefreshTokenExpiresAt: v.optional(v.number()),
    githubRefreshUntil: v.optional(v.number()),
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
    /** Display name: the repo name, or the directory name outside a repo. Never a full path. */
    project: v.optional(v.string()),
    /**
     * Public GitHub repo as lowercase `owner/name`. Only set once the server has confirmed, with
     * the owner's own GitHub token, that the owner can push to it; lists the share on its repo page.
     */
    repo: v.optional(v.string()),
    access: accessValidator,
    eventCount: v.number(),
    /** Position counter: an event's seq is fixed when it first appears. */
    nextSeq: v.number(),
    /** Change counter: bumped on every insert or update, so viewers can follow changes. */
    rev: v.number(),
    updatedAt: v.number(),
    /** Created by an autosync rule rather than by hand. */
    auto: v.optional(v.boolean()),
    /** Listed on the owner's profile and the public feed. Only ever true while `access.anyone`. */
    discoverable: v.optional(v.boolean()),
    /**
     * Set when the owner deletes the share. The row stays as a tombstone (events are purged) so
     * autosync never re-creates or re-uploads it; only an explicit share replaces it.
     */
    deletedAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_owner", ["ownerId"])
    .index("by_owner_session", ["ownerId", "provider", "sessionId"])
    .index("by_discoverable", ["discoverable", "updatedAt"])
    .index("by_owner_discoverable", ["ownerId", "discoverable", "updatedAt"])
    .index("by_owner_project_discoverable", ["ownerId", "project", "discoverable", "updatedAt"])
    .index("by_repo_discoverable", ["repo", "discoverable", "updatedAt"]),

  /** Verified push access to a public GitHub repo, re-checked by a daily cron. Only grants are stored. */
  repoAccess: defineTable({
    userId: v.id("users"),
    /** Lowercase `owner/name`, canonical after renames. */
    repo: v.string(),
    checkedAt: v.number(),
  })
    .index("by_user_repo", ["userId", "repo"])
    .index("by_checked", ["checkedAt"]),

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

  /** Shares a user has viewed, excluding their own. Unfollowing keeps the row so later views don't re-follow. */
  follows: defineTable({
    userId: v.id("users"),
    shareId: v.id("shares"),
    following: v.boolean(),
    lastViewedAt: v.number(),
    /** The share's event count when last viewed; newer events show as unread. */
    seenEventCount: v.optional(v.number()),
  })
    .index("by_user_share", ["userId", "shareId"])
    .index("by_user_following", ["userId", "following", "lastViewedAt"])
    .index("by_share", ["shareId"]),
});
