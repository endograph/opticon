import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const accessValidator = v.object({
  link: v.boolean(),
  users: v.array(v.string()),
  orgs: v.array(v.string()),
  teams: v.array(v.string()),
  repo: v.boolean(),
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
    /** Cached membership, refreshed by access.refresh. */
    orgs: v.optional(v.array(v.string())),
    teams: v.optional(v.array(v.string())),
    membershipCheckedAt: v.optional(v.number()),
    /**
     * On instances limited to some orgs (OPTICON_ALLOWED_ORGS): the allowed org GitHub last
     * confirmed this user belongs to, and when. Sign-in lapses once the confirmation is too old.
     */
    memberOf: v.optional(v.string()),
    memberVerifiedAt: v.optional(v.number()),
    /** When membership was last checked, whatever the answer. Drives the recheck cron. */
    memberCheckedAt: v.optional(v.number()),
    /** "Live sync shared sessions". Defaults to on. */
    liveSync: v.optional(v.boolean()),
  })
    .index("by_github_id", ["githubId"])
    .index("by_login", ["login"])
    .index("by_member_checked", ["memberCheckedAt"]),

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
    /** The signing-in browser's secret, returned with the session so it accepts only its own login. Rows from before it never complete. */
    nonce: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_expires", ["expiresAt"]),

  /** Pending `opticon login` requests, approved from the web. */
  cliLogins: defineTable({
    userCode: v.string(),
    pollHash: v.string(),
    label: v.string(),
    expiresAt: v.number(),
    approvedBy: v.optional(v.id("users")),
  })
    .index("by_user_code", ["userCode"])
    .index("by_poll_hash", ["pollHash"])
    .index("by_expires", ["expiresAt"]),

  shares: defineTable({
    /** Unguessable link id; for `link` shares, possession of the link is the credential. */
    slug: v.string(),
    ownerId: v.id("users"),
    provider: v.union(v.literal("claude"), v.literal("codex")),
    sessionId: v.string(),
    title: v.optional(v.string()),
    /** Display name: the repo name, or the directory name outside a repo. Never a full path. */
    project: v.optional(v.string()),
    /**
     * GitHub repo as lowercase `owner/name`. Only set once the server has confirmed, with the
     * owner's own GitHub token, that the owner can push to it. The `repo` grant and repo pages use it.
     */
    repo: v.optional(v.string()),
    access: accessValidator,
    /**
     * Activity as of the share's last flush from its head (see shareHeads), at most once per
     * ACTIVITY_MS. Lists read these; the head has the live values.
     */
    eventCount: v.number(),
    updatedAt: v.number(),
    /** Legacy: moved to shareHeads. Read once to seed a share's head, then removed. */
    nextSeq: v.optional(v.number()),
    rev: v.optional(v.number()),
    /** Created by an autosync rule rather than by hand. */
    auto: v.optional(v.boolean()),
    /** Shown on the owner's profile, repo pages, and the feed, to viewers who can open it. */
    listed: v.boolean(),
    /**
     * Set when the owner deletes the share. The row stays as a tombstone (events are purged) so
     * autosync never re-creates or re-uploads it; only an explicit share replaces it.
     */
    deletedAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_owner", ["ownerId"])
    /** Live shares (no deletedAt) by recent activity. */
    .index("by_owner_active", ["ownerId", "deletedAt", "updatedAt"])
    .index("by_owner_session", ["ownerId", "provider", "sessionId"])
    .index("by_listed", ["listed", "updatedAt"])
    .index("by_owner_listed", ["ownerId", "listed", "updatedAt"])
    .index("by_owner_project_listed", ["ownerId", "project", "listed", "updatedAt"])
    .index("by_repo_listed", ["repo", "listed", "updatedAt"]),

  /** Verified push access to a GitHub repo, re-checked by a daily cron. Only grants are stored. */
  repoAccess: defineTable({
    userId: v.id("users"),
    /** Lowercase `owner/name`, canonical after renames. */
    repo: v.string(),
    checkedAt: v.number(),
  })
    .index("by_user_repo", ["userId", "repo"])
    .index("by_checked", ["checkedAt"]),

  /** Whether a linked repo is public, as GitHub last said. Public repos grant `repo` access to everyone. */
  repoVisibility: defineTable({
    repo: v.string(),
    private: v.boolean(),
    checkedAt: v.number(),
  }).index("by_repo", ["repo"]),

  /** Whether a viewer can read a repo, as GitHub last said, for the `repo` grant. Denials are stored too. */
  repoReads: defineTable({
    userId: v.id("users"),
    repo: v.string(),
    canRead: v.boolean(),
    checkedAt: v.number(),
  }).index("by_user_repo", ["userId", "repo"]),

  /**
   * A share's upload state, written on every upload. Kept off `shares` so the lists that read
   * shares don't re-run on each one; only the share page and the uploader read it.
   */
  shareHeads: defineTable({
    shareId: v.id("shares"),
    /** Position counter: an event's seq is fixed when it first appears. */
    nextSeq: v.number(),
    /** Change counter: bumped on every insert or update, so viewers can follow changes. */
    rev: v.number(),
    eventCount: v.number(),
    updatedAt: v.number(),
    /** When uploads last reached the share; the next may not until ACTIVITY_MS later. */
    flushedAt: v.optional(v.number()),
    /** A flush to the share is scheduled. */
    flushPending: v.optional(v.boolean()),
  }).index("by_share", ["shareId"]),

  shareEvents: defineTable({
    shareId: v.id("shares"),
    eventId: v.string(),
    seq: v.number(),
    rev: v.number(),
    event: sharedEventValidator,
  })
    .index("by_share_event", ["shareId", "eventId"])
    .index("by_share_rev", ["shareId", "rev"]),

  /**
   * One row per connected viewer, removed when its heartbeat lapses. Heartbeats only touch their
   * own row, and no query reads these, so a heartbeat re-runs nothing; counts live in `watched`.
   */
  presence: defineTable({
    shareId: v.id("shares"),
    viewerId: v.string(),
    lastSeen: v.number(),
  })
    .index("by_share", ["shareId"])
    .index("by_share_viewer", ["shareId", "viewerId"]),

  /** Shares with connected viewers, and how many. Changes only when a viewer arrives or leaves. */
  watched: defineTable({
    shareId: v.id("shares"),
    ownerId: v.id("users"),
    viewers: v.number(),
  })
    .index("by_share", ["shareId"])
    .index("by_owner", ["ownerId"]),

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
