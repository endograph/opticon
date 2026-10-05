import { httpRouter } from "convex/server";
import { api, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { allowedOrgMembership } from "./access";
import { githubApi, githubApiHeaders, githubUrl } from "./github";
import { issueToken } from "./auth";
import { instancePolicy } from "./instance";
import { sessionsBadge } from "./badge";
import { randomToken, sha256 } from "./lib";

/**
 * Environment:
 *   OPTICON_WEB_URL        hosted web origin, e.g. https://opticon.tv. Login redirects must stay on it.
 *   GITHUB_CLIENT_ID       GitHub App (or OAuth app); see docs/self-hosting.md
 *   OPTICON_GITHUB_URL     GitHub Enterprise Server, e.g. https://github.acme.com (default github.com)
 *   GITHUB_CLIENT_SECRET
 *   OPTICON_DEV_AUTH=1     enables /auth/dev, which signs in as any login without GitHub. Never set in production.
 *
 * Instance limits (OPTICON_ALLOWED_ORGS and friends) are described in instance.ts.
 */
const http = httpRouter();

const webUrl = () => (process.env.OPTICON_WEB_URL ?? "http://127.0.0.1:4747").replace(/\/$/, "");

/** Only allow redirects back to the hosted web app, never elsewhere. */
function safeRedirect(raw: string | null): string {
  const base = webUrl();
  if (!raw) return `${base}/`;
  try {
    const url = new URL(raw, base);
    return url.origin === new URL(base).origin ? url.toString() : `${base}/`;
  } catch {
    return `${base}/`;
  }
}

/**
 * The secret the web app made for this sign-in. It comes back with the session, and the web app
 * only accepts a session carrying its own, so a link can't sign a browser into someone else's
 * account (login CSRF).
 */
function loginNonce(req: Request): string | null {
  const nonce = new URL(req.url).searchParams.get("nonce");
  return nonce && /^[\w-]{16,128}$/.test(nonce) ? nonce : null;
}

/** Sends the browser back with a web session token in the fragment, which never reaches servers. */
function withSession(redirect: string, token: string, nonce: string): Response {
  const url = new URL(redirect);
  url.hash = `session=${token}&nonce=${nonce}`;
  return Response.redirect(url.toString(), 302);
}

http.route({
  path: "/auth/github/start",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) return new Response("GitHub OAuth is not configured", { status: 503 });
    const nonce = loginNonce(req);
    if (!nonce) return new Response("Start signing in from Opticon.", { status: 400 });
    const state = randomToken(16);
    await ctx.runMutation(internal.auth.saveOauthState, { state, nonce, redirect: safeRedirect(new URL(req.url).searchParams.get("redirect")) });
    const authorize = new URL(`${githubUrl()}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", `${process.env.CONVEX_SITE_URL}/auth/github/callback`);
    // read:org lets an OAuth app check the viewer's org and team membership. GitHub Apps ignore
    // scopes and use the app's permissions instead.
    authorize.searchParams.set("scope", "read:org");
    authorize.searchParams.set("state", state);
    return Response.redirect(authorize.toString(), 302);
  }),
});

http.route({
  path: "/auth/github/callback",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const params = new URL(req.url).searchParams;
    const login = await ctx.runMutation(internal.auth.consumeOauthState, { state: params.get("state") ?? "" });
    const code = params.get("code");
    if (!login || !code) return new Response("Login expired, please try again.", { status: 400 });

    const exchange = await fetch(`${githubUrl()}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const {
      access_token: githubToken, expires_in: expiresIn,
      refresh_token: refreshToken, refresh_token_expires_in: refreshExpiresIn,
    } = (await exchange.json()) as {
      access_token?: string; expires_in?: number;
      refresh_token?: string; refresh_token_expires_in?: number;
    };
    if (!githubToken) return new Response("GitHub login failed.", { status: 400 });

    const profile = await fetch(`${githubApi()}/user`, { headers: githubApiHeaders(githubToken) });
    if (!profile.ok) return new Response("Could not read GitHub profile.", { status: 502 });
    const gh = (await profile.json()) as { id: number; login: string; name?: string; avatar_url?: string };
    const { allowedOrgs } = instancePolicy();
    let memberOf: string | undefined;
    if (allowedOrgs.length) {
      const org = await allowedOrgMembership(githubApiHeaders(githubToken), allowedOrgs).catch(() => undefined);
      if (org === undefined) return new Response("Could not check your GitHub org membership. Try again shortly.", { status: 502 });
      if (!org) return new Response(`This Opticon is limited to members of ${allowedOrgs.join(", ")}.`, { status: 403 });
      memberOf = org;
    }
    const userId = await ctx.runMutation(internal.auth.upsertUser, {
      githubId: gh.id,
      login: gh.login,
      name: gh.name ?? undefined,
      avatarUrl: gh.avatar_url,
      githubToken,
      githubTokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      githubRefreshToken: refreshToken,
      githubRefreshTokenExpiresAt: refreshExpiresIn ? Date.now() + refreshExpiresIn * 1000 : undefined,
      memberOf,
    });
    return withSession(login.redirect, await issueToken(ctx, userId, "web"), login.nonce);
  }),
});

http.route({
  path: "/auth/dev",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    if (process.env.OPTICON_DEV_AUTH !== "1") return new Response("Not found", { status: 404 });
    const params = new URL(req.url).searchParams;
    const nonce = loginNonce(req);
    if (!nonce) return new Response("Start signing in from Opticon.", { status: 400 });
    const login = (params.get("login") ?? "dev").toLowerCase();
    // Fake, negative GitHub ids can never collide with real accounts.
    const githubId = -Number.parseInt((await sha256(login)).slice(0, 12), 16);
    // Dev users count as members of the first allowed org, if the instance is limited to some.
    const memberOf = instancePolicy().allowedOrgs[0];
    const userId = await ctx.runMutation(internal.auth.upsertUser, { githubId, login, name: `${login} (dev)`, memberOf });
    return withSession(safeRedirect(params.get("redirect")), await issueToken(ctx, userId, "web"), nonce);
  }),
});

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** `opticon login` step 1: returns a code to show the user and a secret to poll with. */
http.route({
  path: "/cli/start",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { label } = (await req.json().catch(() => ({}))) as { label?: string };
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const raw = [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const pollSecret = randomToken();
    await ctx.runMutation(internal.auth.createCliLogin, {
      userCode,
      pollHash: await sha256(pollSecret),
      label: (label ?? "CLI").slice(0, 80),
    });
    return Response.json({ userCode, pollSecret, verifyUrl: `${webUrl()}/cli?code=${userCode}` });
  }),
});

/** `opticon login` step 2: polled until the user approves on the web. */
http.route({
  path: "/cli/poll",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { pollSecret } = (await req.json().catch(() => ({}))) as { pollSecret?: string };
    if (!pollSecret) return Response.json({ status: "expired" }, { status: 400 });
    const result = await ctx.runMutation(internal.auth.takeApprovedCliLogin, { pollHash: await sha256(pollSecret) });
    if (result.status !== "approved") return Response.json({ status: result.status });
    const token = await issueToken(ctx, result.userId, "cli", result.label);
    return Response.json({ status: "approved", token, login: result.login });
  }),
});

/** README badge for a repo page: `/badge/gh/<owner>/<name>.svg`. The hosted web app proxies /badge/* here. */
http.route({
  pathPrefix: "/badge/gh/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const repo = /^\/badge\/gh\/([\w.-]+\/[\w.-]+?)(?:\.svg)?$/.exec(new URL(req.url).pathname)?.[1];
    // Badges are public by nature; an instance closed to signed-out visitors has none.
    if (!repo || !instancePolicy().anonymous) return new Response("Not found", { status: 404 });
    const { count, capped } = await ctx.runQuery(api.shares.repoSessionCount, { repo });
    return new Response(sessionsBadge(count, capped), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=600" },
    });
  }),
});

export default http;
