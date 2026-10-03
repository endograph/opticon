import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { issueToken } from "./auth";
import { randomToken, sha256 } from "./lib";

/**
 * Environment:
 *   OPTICON_WEB_URL        hosted web origin, e.g. https://opticon.com. Login redirects must stay on it.
 *   GITHUB_CLIENT_ID       GitHub OAuth app
 *   GITHUB_CLIENT_SECRET
 *   OPTICON_DEV_AUTH=1     enables /auth/dev, which signs in as any login without GitHub. Never set in production.
 */
const http = httpRouter();

const webUrl = () => (process.env.OPTICON_WEB_URL ?? "http://127.0.0.1:4320").replace(/\/$/, "");

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

/** Sends the browser back with a web session token in the fragment, which never reaches servers. */
function withSession(redirect: string, token: string): Response {
  const url = new URL(redirect);
  url.hash = `session=${token}`;
  return Response.redirect(url.toString(), 302);
}

http.route({
  path: "/auth/github/start",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) return new Response("GitHub OAuth is not configured", { status: 503 });
    const state = randomToken(16);
    await ctx.runMutation(internal.auth.saveOauthState, { state, redirect: safeRedirect(new URL(req.url).searchParams.get("redirect")) });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", `${process.env.CONVEX_SITE_URL}/auth/github/callback`);
    // read:org lets us check the viewer's own org and team membership for org/team shares.
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
    const redirect = await ctx.runMutation(internal.auth.consumeOauthState, { state: params.get("state") ?? "" });
    const code = params.get("code");
    if (!redirect || !code) return new Response("Login expired, please try again.", { status: 400 });

    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const { access_token: githubToken } = (await exchange.json()) as { access_token?: string };
    if (!githubToken) return new Response("GitHub login failed.", { status: 400 });

    const profile = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json", "user-agent": "opticon" },
    });
    if (!profile.ok) return new Response("Could not read GitHub profile.", { status: 502 });
    const gh = (await profile.json()) as { id: number; login: string; name?: string; avatar_url?: string };
    const userId = await ctx.runMutation(internal.auth.upsertUser, {
      githubId: gh.id,
      login: gh.login,
      name: gh.name ?? undefined,
      avatarUrl: gh.avatar_url,
      githubToken,
    });
    return withSession(redirect, await issueToken(ctx, userId, "web"));
  }),
});

http.route({
  path: "/auth/dev",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    if (process.env.OPTICON_DEV_AUTH !== "1") return new Response("Not found", { status: 404 });
    const params = new URL(req.url).searchParams;
    const login = (params.get("login") ?? "dev").toLowerCase();
    // Fake, negative GitHub ids can never collide with real accounts.
    const githubId = -Number.parseInt((await sha256(login)).slice(0, 12), 16);
    const userId = await ctx.runMutation(internal.auth.upsertUser, { githubId, login, name: `${login} (dev)` });
    return withSession(safeRedirect(params.get("redirect")), await issueToken(ctx, userId, "web"));
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

export default http;
