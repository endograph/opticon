import { describe, expect, test } from "bun:test";
import { LINK_ACCESS, PRIVATE_ACCESS, PROTOCOL_VERSION, type SharedEvent } from "@opticon/core/protocol";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import { decideAccess, sha256 } from "../convex/lib";
import schema from "../convex/schema";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/auth.ts": () => import("../convex/auth"),
  "../convex/shares.ts": () => import("../convex/shares"),
  "../convex/presence.ts": () => import("../convex/presence"),
  "../convex/follows.ts": () => import("../convex/follows"),
  "../convex/access.ts": () => import("../convex/access"),
  "../convex/repos.ts": () => import("../convex/repos"),
  "../convex/crons.ts": () => import("../convex/crons"),
  "../convex/badge.ts": () => import("../convex/badge"),
  "../convex/http.ts": () => import("../convex/http"),
};

type T = ReturnType<typeof convexTest>;

/** Creates a user with a token, bypassing OAuth. */
async function signIn(t: T, login: string, extra: Record<string, unknown> = {}) {
  const userId = await t.mutation(internal.auth.upsertUser, { githubId: login.length * 1000 + login.charCodeAt(0), login });
  if (Object.keys(extra).length) await t.run((ctx) => ctx.db.patch(userId, extra));
  const token = `token-${login}`;
  await t.mutation(internal.auth.storeToken, { hash: await sha256(token), userId, kind: "web" });
  return token;
}

const msg = (id: string, text: string): SharedEvent => ({ kind: "message", id, role: "assistant", text });
const tool = (id: string, status: "running" | "ok"): SharedEvent => ({ kind: "tool", id, category: "tool", name: "Bash", status });

async function setup(access = LINK_ACCESS) {
  const t = convexTest(schema, modules);
  const owner = await signIn(t, "owner");
  const { shareId, slug } = await t.action(api.shares.create, {
    token: owner,
    protocol: PROTOCOL_VERSION,
    provider: "claude",
    sessionId: "s1",
    title: "Demo",
    access,
  });
  return { t, owner, shareId, slug };
}

describe("shares", () => {
  test("append upserts by id, skips unchanged events, and tracks revs", async () => {
    const { t, owner, shareId, slug } = await setup();
    const append = (events: SharedEvent[]) => t.mutation(api.shares.append, { token: owner, protocol: PROTOCOL_VERSION, shareId, events });

    expect(await append([msg("a", "hi"), tool("t", "running")])).toEqual({ changed: 2 });
    expect(await append([msg("a", "hi"), tool("t", "running")])).toEqual({ changed: 0 });
    expect(await append([tool("t", "ok"), msg("b", "done")])).toEqual({ changed: 2 });

    const all = await t.query(api.shares.changes, { slug, afterRev: 0 });
    // Ordered by change; the tool keeps its original position (seq 1) after being updated.
    expect(all?.events.map((e) => [e.seq, e.event.id])).toEqual([
      [0, "a"],
      [1, "t"],
      [2, "b"],
    ]);
    expect(all?.rev).toBe(4);
    const live = await t.query(api.shares.changes, { slug, afterRev: 2 });
    expect(live?.events.map((e) => e.event)).toEqual([tool("t", "ok"), msg("b", "done")]);
  });

  test("re-sharing a session updates access instead of creating a second share", async () => {
    const { t, owner, slug } = await setup();
    const again = await t.action(api.shares.create, {
      token: owner,
      protocol: PROTOCOL_VERSION,
      provider: "claude",
      sessionId: "s1",
      access: { anyone: false, users: ["@Friend"], orgs: [], teams: [] },
    });
    expect(again.slug).toBe(slug);
    const mine = await t.query(api.shares.mine, { token: owner });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.access).toEqual({ anyone: false, users: ["friend"], orgs: [], teams: [] });
  });

  test("rejects protocol mismatches and other users", async () => {
    const { t, shareId } = await setup();
    const intruder = await signIn(t, "intruder");
    await expect(
      t.mutation(api.shares.append, { token: intruder, protocol: PROTOCOL_VERSION, shareId, events: [] }),
    ).rejects.toThrow();
    await expect(
      t.action(api.shares.create, { token: intruder, protocol: PROTOCOL_VERSION + 1, provider: "claude", sessionId: "x", access: LINK_ACCESS }),
    ).rejects.toThrow(/protocol_mismatch/);
  });

  test("deleting purges events and leaves a tombstone that rejects uploads", async () => {
    const { t, owner, shareId, slug } = await setup();
    await t.mutation(api.shares.append, { token: owner, protocol: PROTOCOL_VERSION, shareId, events: [msg("a", "x")] });
    await t.mutation(api.shares.remove, { token: owner, shareId });
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.query(api.shares.view, { slug })).toEqual({ status: "not_found" });
    expect(await t.run((ctx) => ctx.db.query("shareEvents").collect())).toEqual([]);
    expect(await t.query(api.shares.mine, { token: owner })).toEqual([]);
    expect(await t.query(api.shares.deleted, { token: owner })).toEqual([{ provider: "claude", sessionId: "s1" }]);
    await expect(
      t.mutation(api.shares.append, { token: owner, protocol: PROTOCOL_VERSION, shareId, events: [msg("b", "y")] }),
    ).rejects.toThrow(/deleted/);
  });

  test("autosync never revives a deleted share, but an explicit share does, with a new link", async () => {
    const { t, owner, shareId, slug } = await setup();
    await t.mutation(api.shares.remove, { token: owner, shareId });
    const create = (auto: boolean) =>
      t.action(api.shares.create, { token: owner, protocol: PROTOCOL_VERSION, provider: "claude", sessionId: "s1", access: LINK_ACCESS, auto });
    await expect(create(true)).rejects.toThrow(/deleted/);

    const revived = await create(false);
    expect(revived.slug).not.toBe(slug);
    expect(await t.query(api.shares.deleted, { token: owner })).toEqual([]);
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.query(api.shares.view, { slug: revived.slug })).toMatchObject({ status: "ok" });
  });

  test("autosync creates once and leaves an existing share's access alone", async () => {
    const { t, owner } = await setup(PRIVATE_ACCESS);
    const created = await t.action(api.shares.create, {
      token: owner, protocol: PROTOCOL_VERSION, provider: "claude", sessionId: "s2", access: PRIVATE_ACCESS, auto: true,
    });
    await t.action(api.shares.create, {
      token: owner, protocol: PROTOCOL_VERSION, provider: "claude", sessionId: "s1", access: LINK_ACCESS, auto: true,
    });
    const mine = await t.query(api.shares.mine, { token: owner });
    expect(mine.find((s) => s.sessionId === "s1")).toMatchObject({ access: PRIVATE_ACCESS, auto: false });
    expect(mine.find((s) => s.slug === created.slug)).toMatchObject({ auto: true });
  });
});

describe("discovery", () => {
  const share = (t: T, token: string, sessionId: string, access = LINK_ACCESS, discoverable = true) =>
    t.action(api.shares.create, { token, protocol: PROTOCOL_VERSION, provider: "claude", sessionId, title: sessionId, access, discoverable });

  test("discoverable link shares appear on the feed and the owner's profile", async () => {
    const { t, owner } = await setup();
    await share(t, owner, "listed");
    await share(t, owner, "restricted", { anyone: false, users: ["friend"], orgs: [], teams: [] });
    await share(t, owner, "unlisted", LINK_ACCESS, false);
    expect((await t.query(api.shares.feed, {})).map((s) => s.title)).toEqual(["listed"]);
    const profile = await t.query(api.shares.profile, { login: "Owner" });
    expect(profile?.user.login).toBe("owner");
    expect(profile?.shares.map((s) => s.title)).toEqual(["listed"]);
    expect(await t.query(api.shares.profile, { login: "nobody" })).toBeNull();
  });

  test("narrowing access, unsharing, or deleting unlists; listing needs link access", async () => {
    const { t, owner } = await setup();
    const a = await share(t, owner, "a");
    const b = await share(t, owner, "b");
    await t.mutation(api.shares.setAccess, { token: owner, shareId: a.shareId, access: PRIVATE_ACCESS });
    await t.mutation(api.shares.remove, { token: owner, shareId: b.shareId });
    expect(await t.query(api.shares.feed, {})).toEqual([]);

    await t.mutation(api.shares.setAccess, { token: owner, shareId: a.shareId, access: LINK_ACCESS });
    expect(await t.query(api.shares.feed, {})).toEqual([]);
    await t.mutation(api.shares.setDiscoverable, { token: owner, shareId: a.shareId, discoverable: true });
    expect((await t.query(api.shares.feed, {})).map((s) => s.title)).toEqual(["a"]);

    await t.mutation(api.shares.setAccess, { token: owner, shareId: a.shareId, access: PRIVATE_ACCESS });
    await expect(t.mutation(api.shares.setDiscoverable, { token: owner, shareId: a.shareId, discoverable: true })).rejects.toThrow(/not_public/);
  });
});

describe("access", () => {
  test("private shares require login and a matching rule", async () => {
    const { t, slug } = await setup({ ...PRIVATE_ACCESS, users: ["friend"], teams: ["acme/platform"] });
    expect((await t.query(api.shares.view, { slug })).status).toBe("login_required");

    const friend = await signIn(t, "friend");
    expect((await t.query(api.shares.view, { slug, token: friend })).status).toBe("ok");

    const stranger = await signIn(t, "stranger");
    expect(await t.query(api.shares.view, { slug, token: stranger })).toMatchObject({ status: "forbidden", stale: true });
    expect(await t.query(api.shares.changes, { slug, token: stranger, afterRev: 0 })).toBeNull();

    const member = await signIn(t, "member", { teams: ["acme/platform"], membershipCheckedAt: Date.now() });
    expect((await t.query(api.shares.view, { slug, token: member })).status).toBe("ok");
  });

  test("decideAccess marks membership stale only when org or team rules exist", () => {
    const viewer = { _id: "v", login: "v", orgs: [], teams: [], membershipCheckedAt: 0 } as never;
    expect(decideAccess({ ...PRIVATE_ACCESS, users: ["x"] }, "o", viewer)).toEqual({ ok: false, reason: "forbidden", stale: false });
    expect(decideAccess({ ...PRIVATE_ACCESS, orgs: ["acme"] }, "o", viewer)).toEqual({ ok: false, reason: "forbidden", stale: true });
  });
});

describe("presence and live demand", () => {
  test("a viewer's heartbeat creates demand, which expires without further heartbeats", async () => {
    const { t, owner, slug } = await setup();
    expect(await t.query(api.shares.liveDemand, { token: owner })).toEqual([]);
    await t.mutation(api.presence.heartbeat, { slug, viewerId: "viewer-1" });
    expect(await t.query(api.shares.liveDemand, { token: owner })).toHaveLength(1);

    await t.mutation(api.auth.setLiveSync, { token: owner, liveSync: false });
    expect(await t.query(api.shares.liveDemand, { token: owner })).toEqual([]);
    await t.mutation(api.auth.setLiveSync, { token: owner, liveSync: true });

    await t.mutation(api.presence.leave, { slug, viewerId: "viewer-1" });
    expect(await t.query(api.shares.liveDemand, { token: owner })).toEqual([]);
  });

  test("expiry removes a row only if no newer heartbeat refreshed it", async () => {
    const { t, owner, slug } = await setup();
    await t.mutation(api.presence.heartbeat, { slug, viewerId: "v" });
    const row = (await t.run((ctx) => ctx.db.query("presence").first()))!;
    await t.mutation(internal.presence.expire, { id: row._id, lastSeen: row.lastSeen - 1 });
    expect(await t.query(api.shares.liveDemand, { token: owner })).toHaveLength(1);
    await t.mutation(internal.presence.expire, { id: row._id, lastSeen: row.lastSeen });
    expect(await t.query(api.shares.liveDemand, { token: owner })).toEqual([]);
  });

  test("heartbeats are rejected for viewers without access", async () => {
    const { t, slug } = await setup(PRIVATE_ACCESS);
    await expect(t.mutation(api.presence.heartbeat, { slug, viewerId: "v" })).rejects.toThrow(/forbidden/);
  });
});

describe("follows", () => {
  const view = (t: T, slug: string, token: string) => t.mutation(api.presence.heartbeat, { slug, viewerId: token, token });

  test("viewing follows a share; unfollowing sticks across later views", async () => {
    const { t, owner, slug } = await setup();
    const viewer = await signIn(t, "viewer");

    await view(t, slug, owner);
    expect(await t.run((ctx) => ctx.db.query("follows").collect())).toEqual([]);

    await view(t, slug, viewer);
    expect((await t.query(api.follows.list, { token: viewer })).map((f) => f.slug)).toEqual([slug]);
    expect(await t.query(api.shares.view, { slug, token: viewer })).toMatchObject({ share: { following: true } });

    await t.mutation(api.follows.setFollowing, { token: viewer, slug, following: false });
    await view(t, slug, viewer);
    expect(await t.query(api.follows.list, { token: viewer })).toEqual([]);
    expect(await t.query(api.shares.view, { slug, token: viewer })).toMatchObject({ share: { following: false } });
  });

  test("events added since the last view count as unread until the viewer leaves", async () => {
    const { t, owner, shareId, slug } = await setup();
    const viewer = await signIn(t, "viewer");
    const append = (events: SharedEvent[]) => t.mutation(api.shares.append, { token: owner, protocol: PROTOCOL_VERSION, shareId, events });
    await append([msg("a", "hi")]);
    await view(t, slug, viewer);
    await append([msg("b", "more"), tool("t", "running")]);
    expect(await t.query(api.follows.list, { token: viewer })).toMatchObject([{ unread: 2, eventCount: 3, viewers: 1 }]);

    await t.mutation(api.presence.leave, { slug, viewerId: viewer, token: viewer });
    expect(await t.query(api.follows.list, { token: viewer })).toMatchObject([{ unread: 0, viewers: 0 }]);
  });

  test("lost access leaves an unavailable entry, and unsharing deletes it", async () => {
    const { t, owner, shareId, slug } = await setup();
    const viewer = await signIn(t, "viewer");
    await view(t, slug, viewer);

    await t.mutation(api.shares.setAccess, { token: owner, shareId, access: PRIVATE_ACCESS });
    const [entry] = await t.query(api.follows.list, { token: viewer });
    expect(entry).toEqual({ slug, available: false, lastViewedAt: expect.any(Number), unread: 0 });
    await expect(view(t, slug, viewer)).rejects.toThrow(/forbidden/);

    await t.mutation(api.shares.remove, { token: owner, shareId });
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.run((ctx) => ctx.db.query("follows").collect())).toEqual([]);
  });
});

describe("browser history", () => {
  test("resolve returns details for link shares and marks others unavailable", async () => {
    const { t, owner, shareId, slug } = await setup();
    expect(await t.query(api.follows.resolve, { slugs: [slug, "missing"] })).toMatchObject([{ slug, available: true, title: "Demo" }]);
    await t.mutation(api.shares.setAccess, { token: owner, shareId, access: PRIVATE_ACCESS });
    expect(await t.query(api.follows.resolve, { slugs: [slug] })).toEqual([{ slug, available: false }]);
  });

  test("importLocal adds new follows and keeps the account's choice for existing ones", async () => {
    const { t, slug } = await setup();
    const other = await t.action(api.shares.create, {
      token: await signIn(t, "other"),
      protocol: PROTOCOL_VERSION,
      provider: "codex",
      sessionId: "s2",
      access: LINK_ACCESS,
    });
    const viewer = await signIn(t, "viewer");
    await t.mutation(api.follows.setFollowing, { token: viewer, slug, following: false });

    await t.mutation(api.follows.importLocal, {
      token: viewer,
      entries: [
        { slug, lastViewedAt: Date.now(), following: true },
        { slug: other.slug, lastViewedAt: 1, following: true },
        { slug: "missing", lastViewedAt: 1, following: true },
      ],
    });
    expect((await t.query(api.follows.list, { token: viewer })).map((f) => f.slug)).toEqual([other.slug]);
  });
});

describe("cli login", () => {
  test("a poll secret yields exactly one token after approval", async () => {
    const t = convexTest(schema, modules);
    const web = await signIn(t, "owner");
    const start = (await (await t.fetch("/cli/start", { method: "POST", body: JSON.stringify({ label: "laptop" }) })).json()) as {
      userCode: string;
      pollSecret: string;
    };
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const poll = async () =>
      (await (await t.fetch("/cli/poll", { method: "POST", body: JSON.stringify({ pollSecret: start.pollSecret }) })).json()) as {
        status: string;
        token?: string;
      };
    expect(await poll()).toEqual({ status: "pending" });
    await t.mutation(api.auth.approveCliLogin, { token: web, userCode: start.userCode });
    const approved = await poll();
    expect(approved).toMatchObject({ status: "approved", login: "owner" });
    expect(await t.query(api.auth.me, { token: approved.token })).toMatchObject({ login: "owner" });
    expect(await poll()).toEqual({ status: "expired" });
  });
});

describe("GitHub token refresh", () => {
  test("refreshes an expired token and uses the rotated token for membership requests", async () => {
    const t = convexTest(schema, modules);
    const token = await signIn(t, "viewer", {
      githubToken: "expired", githubTokenExpiresAt: Date.now() - 1,
      githubRefreshToken: "refresh-old", githubRefreshTokenExpiresAt: Date.now() + 86400_000,
    });
    const original = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("access_token")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-old" });
        return Response.json({ access_token: "fresh", expires_in: 28800, refresh_token: "refresh-new", refresh_token_expires_in: 15897600 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fresh");
      return Response.json(url.includes("/teams") ? [{ slug: "platform", organization: { login: "Acme" } }] : [{ login: "Acme" }]);
    }) as typeof fetch;
    try {
      expect(await t.action(api.access.refreshMemberships, { token })).toEqual({ orgs: ["acme"], teams: ["acme/platform"] });
      const user = await t.run((ctx) => ctx.db.query("users").first());
      expect(user).toMatchObject({ githubToken: "fresh", githubRefreshToken: "refresh-new" });
      expect(user?.githubRefreshUntil).toBeUndefined();
      expect(user?.githubTokenExpiresAt).toBeGreaterThan(Date.now());
      expect(requests).toHaveLength(3);
      await t.action(api.access.refreshMemberships, { token });
      expect(requests.filter((url) => url.includes("access_token"))).toHaveLength(1);
    } finally { globalThis.fetch = original; }
  });

  test("failed refresh preserves membership and releases the refresh lock", async () => {
    const t = convexTest(schema, modules);
    const token = await signIn(t, "viewer", {
      githubToken: "expired", githubTokenExpiresAt: Date.now() - 1,
      githubRefreshToken: "refresh", orgs: ["acme"], membershipCheckedAt: 123,
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ error: "bad_refresh_token" })) as unknown as typeof fetch;
    try {
      expect(await t.action(api.access.refreshMemberships, { token })).toBeNull();
      expect(await t.run((ctx) => ctx.db.query("users").first())).toMatchObject({
        orgs: ["acme"], membershipCheckedAt: 123, githubToken: "expired",
      });
      const user = (await t.run((ctx) => ctx.db.query("users").first()))!;
      expect(await t.mutation(internal.auth.claimGithubRefresh, { userId: user._id, refreshToken: "refresh" })).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  test("only one concurrent refresh can claim a token; a new sign-in supersedes it", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.mutation(internal.auth.upsertUser, { githubId: 123, login: "viewer", githubToken: "old", githubRefreshToken: "r1" });
    expect(await t.mutation(internal.auth.claimGithubRefresh, { userId, refreshToken: "r1" })).toBe(true);
    expect(await t.mutation(internal.auth.claimGithubRefresh, { userId, refreshToken: "r1" })).toBe(false);
    await t.mutation(internal.auth.upsertUser, { githubId: 123, login: "viewer", githubToken: "new-login", githubRefreshToken: "r2" });
    expect(await t.mutation(internal.auth.finishGithubRefresh, {
      userId, previousRefreshToken: "r1", credentials: { token: "stale", expiresAt: 1000, refreshToken: "stale-r", refreshExpiresAt: 2000 },
    })).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({ githubToken: "new-login", githubRefreshToken: "r2" });
  });

  test("membership API failure never saves a partial membership list", async () => {
    const t = convexTest(schema, modules);
    const token = await signIn(t, "viewer", { githubToken: "valid", orgs: ["acme"], teams: ["acme/platform"], membershipCheckedAt: 123 });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("/teams")
      ? new Response("Unavailable", { status: 503 }) : Response.json([{ login: "Other" }])) as typeof fetch;
    try {
      await expect(t.action(api.access.refreshMemberships, { token })).rejects.toThrow(/503/);
      expect(await t.run((ctx) => ctx.db.query("users").first())).toMatchObject({ orgs: ["acme"], teams: ["acme/platform"], membershipCheckedAt: 123 });
    } finally { globalThis.fetch = original; }
  });
});

describe("repo pages", () => {
  /** Stubs GET /repos/:owner/:name; `repos` maps the requested path to GitHub's answer. */
  async function withGithub<R>(repos: Record<string, { full_name: string; private?: boolean; push?: boolean } | number>, run: (calls: string[]) => Promise<R>) {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input).replace("https://api.github.com/repos/", "");
      calls.push(path);
      const repo = repos[path];
      if (repo === undefined) return new Response("Not Found", { status: 404 });
      if (typeof repo === "number") return new Response("", { status: repo });
      return Response.json({ full_name: repo.full_name, private: repo.private ?? false, permissions: { push: repo.push ?? false } });
    }) as unknown as typeof fetch;
    try {
      return await run(calls);
    } finally {
      globalThis.fetch = original;
    }
  }

  async function share(t: T, token: string, sessionId: string, repo?: string) {
    return t.action(api.shares.create, {
      token, protocol: PROTOCOL_VERSION, provider: "claude", sessionId, title: sessionId, project: "opticon",
      repo, access: LINK_ACCESS, discoverable: true,
    });
  }

  test("lists shares only from users GitHub confirms can push to the public repo", async () => {
    const t = convexTest(schema, modules);
    const owner = await signIn(t, "owner", { githubToken: "gh-owner" });
    const outsider = await signIn(t, "outsider", { githubToken: "gh-outsider" });
    await withGithub({ "acme/app": { full_name: "Acme/App", push: true } }, async () => {
      await share(t, owner, "s1", "github.com/Acme/App");
    });
    await withGithub({ "acme/app": { full_name: "Acme/App", push: false } }, async () => {
      await share(t, outsider, "s2", "github.com/acme/app");
    });
    const listed = await t.query(api.shares.repoShares, { repo: "acme/app" });
    expect(listed.map((s) => [s.title, s.repo, s.owner?.login])).toEqual([["s1", "acme/app", "owner"]]);
  });

  test("private repos, non-GitHub remotes, and users without a token are never linked", async () => {
    const t = convexTest(schema, modules);
    const owner = await signIn(t, "owner", { githubToken: "gh-owner" });
    const tokenless = await signIn(t, "tokenless");
    await withGithub({ "acme/secret": { full_name: "acme/secret", private: true, push: true }, "acme/app": { full_name: "acme/app", push: true } }, async (calls) => {
      await share(t, owner, "s1", "github.com/acme/secret");
      await share(t, owner, "s2", "gitlab.com/acme/app");
      await share(t, tokenless, "s3", "github.com/acme/app");
      expect(calls).toEqual(["acme/secret"]);
    });
    const repos = await t.run(async (ctx) => (await ctx.db.query("shares").collect()).map((s) => s.repo ?? null));
    expect(repos).toEqual([null, null, null]);
    expect(await t.run((ctx) => ctx.db.query("repoAccess").collect())).toEqual([]);
  });

  test("grants are cached, renames resolve to the canonical repo, and GitHub outages change nothing", async () => {
    const t = convexTest(schema, modules);
    const owner = await signIn(t, "owner", { githubToken: "gh-owner" });
    await withGithub({ "old/name": { full_name: "new/name", push: true }, "new/name": { full_name: "new/name", push: true } }, async (calls) => {
      const { shareId } = await share(t, owner, "s1", "github.com/old/name");
      expect(await t.run(async (ctx) => (await ctx.db.get(shareId))?.repo)).toBe("new/name");
      await share(t, owner, "s2", "github.com/new/name");
      expect(calls).toEqual(["old/name"]);
    });
    await withGithub({ "other/repo": 502 }, async () => {
      // Re-sharing during an outage keeps the existing link (and bumps the share to the top).
      await share(t, owner, "s1", "github.com/other/repo");
    });
    expect((await t.query(api.shares.repoShares, { repo: "new/name" })).map((s) => s.title)).toEqual(["s1", "s2"]);
  });

  test("the recheck unlists shares when push access is lost and follows renames", async () => {
    const t = convexTest(schema, modules);
    const owner = await signIn(t, "owner", { githubToken: "gh-owner" });
    await withGithub({ "acme/app": { full_name: "acme/app", push: true }, "acme/lib": { full_name: "acme/lib", push: true } }, async () => {
      await share(t, owner, "s1", "github.com/acme/app");
      await share(t, owner, "s2", "github.com/acme/lib");
    });
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query("repoAccess").collect()) await ctx.db.patch(g._id, { checkedAt: 0 });
    });
    await withGithub({ "acme/app": { full_name: "acme/app", push: false }, "acme/lib": { full_name: "acme/library", push: true } }, async () => {
      await t.action(internal.repos.recheck, {});
    });
    expect(await t.query(api.shares.repoShares, { repo: "acme/app" })).toEqual([]);
    expect((await t.query(api.shares.repoShares, { repo: "acme/library" })).map((s) => s.title)).toEqual(["s2"]);
    expect((await t.run((ctx) => ctx.db.query("repoAccess").collect())).map((g) => g.repo)).toEqual(["acme/library"]);
  });

  test("active repos rank by sessions this week, and the badge counts a repo's listed sessions", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, "alice", { githubToken: "gh-alice" });
    const bob = await signIn(t, "bob", { githubToken: "gh-bob" });
    await withGithub({ "acme/app": { full_name: "acme/app", push: true }, "acme/lib": { full_name: "acme/lib", push: true } }, async () => {
      await share(t, alice, "a1", "github.com/acme/app");
      await share(t, bob, "b1", "github.com/acme/app");
      await share(t, alice, "a2", "github.com/acme/lib");
    });
    await share(t, alice, "a3");
    const active = await t.query(api.shares.activeRepos, {});
    expect(active.map((r) => [r.repo, r.sessions, r.contributors.map((c) => c.login).sort()])).toEqual([
      ["acme/app", 2, ["alice", "bob"]],
      ["acme/lib", 1, ["alice"]],
    ]);

    const svg = async (path: string) => {
      const res = await t.fetch(path);
      return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
    };
    const app = await svg("/badge/gh/Acme/App.svg");
    expect(app.status).toBe(200);
    expect(app.type).toContain("image/svg+xml");
    expect(app.body).toContain("<title>opticon: 2 sessions</title>");
    expect((await svg("/badge/gh/acme/none.svg")).body).toContain("no sessions yet");
    expect((await svg("/badge/gh/not-a-repo")).status).toBe(404);
  });

  test("a user's project page lists their discoverable shares in that project", async () => {
    const t = convexTest(schema, modules);
    const owner = await signIn(t, "owner");
    await share(t, owner, "s1");
    await t.action(api.shares.create, {
      token: owner, protocol: PROTOCOL_VERSION, provider: "claude", sessionId: "s2", project: "other", access: LINK_ACCESS, discoverable: true,
    });
    await t.action(api.shares.create, {
      token: owner, protocol: PROTOCOL_VERSION, provider: "claude", sessionId: "s3", project: "opticon", access: LINK_ACCESS,
    });
    const page = await t.query(api.shares.userProject, { login: "Owner", project: "opticon" });
    expect(page?.shares.map((s) => s.title)).toEqual(["s1"]);
    expect(await t.query(api.shares.userProject, { login: "nobody", project: "opticon" })).toBeNull();
  });
});
