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
  "../convex/access.ts": () => import("../convex/access"),
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

  test("unsharing deletes the share and its events", async () => {
    const { t, owner, shareId, slug } = await setup();
    await t.mutation(api.shares.append, { token: owner, protocol: PROTOCOL_VERSION, shareId, events: [msg("a", "x")] });
    await t.mutation(api.shares.remove, { token: owner, shareId });
    await t.finishAllScheduledFunctions(() => {});
    expect(await t.query(api.shares.view, { slug })).toEqual({ status: "not_found" });
    expect(await t.run((ctx) => ctx.db.query("shareEvents").collect())).toEqual([]);
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
