import { PROTOCOL_VERSION, type ShareAccess, normalizeAccess, projectSessionForShare } from "@opticon/core";
import { dirname } from "node:path";
import index from "@opticon/web/index.html";
import { endpoints, readAuth } from "../account";
import { addRule, describeRule, newRule, removeRule } from "../autosync";
import { type SessionKey, SessionStore } from "./store";
import { tailnetHostname } from "../tailscale";
import { ShareSync } from "./sync";

const COOKIE = "opticon_local";

export interface DaemonOptions {
  port: number;
  token: string;
  version: string;
}

/**
 * Local API and web UI. Binds to loopback only. Every /api route except /api/health requires
 * the local token cookie, and the Host header must be loopback, which defeats DNS rebinding.
 */
export async function startServer(options: DaemonOptions) {
  const store = new SessionStore();
  await store.start();
  const sync = new ShareSync(store);
  await sync.start();
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  // `opticon web --tailscale` proxies through `tailscale serve`, which keeps the Host header.
  // This machine's MagicDNS name is controlled by Tailscale, not by an attacker, so allowing it
  // doesn't reopen DNS rebinding. Requests still need the cookie.
  const tailnetHost = await tailnetHostname();
  const hostAllowed = (host: string) =>
    allowedHosts.has(host) || (!!tailnetHost && (host === tailnetHost || host.startsWith(`${tailnetHost}:`)));

  const guard =
    (handler: (req: Bun.BunRequest<any>) => Response | Promise<Response>) =>
    (req: Bun.BunRequest<any>): Response | Promise<Response> => {
      if (!hostAllowed(req.headers.get("host") ?? "")) return new Response("Bad host", { status: 421 });
      if (req.cookies.get(COOKIE) !== options.token) return Response.json({ error: "unauthorized" }, { status: 401 });
      // A custom header can't be sent cross-origin without a CORS preflight, which we never grant.
      if (req.method !== "GET" && req.headers.get("x-opticon") !== "1") return Response.json({ error: "csrf" }, { status: 403 });
      return handler(req);
    };

  const failure = (error: unknown) => Response.json({ error: (error as Error).message }, { status: 400 });
  const shareState = () => ({
    type: "shares",
    account: sync.account,
    shares: sync.shares.map((s) => ({ ...s, url: sync.urlFor(s.slug) })),
  });

  const sessionKey = (req: Bun.BunRequest<"/api/sessions/:provider/:id">) =>
    `${req.params.provider}/${req.params.id}` as SessionKey;

  // Bun computes the bundled UI's asset URLs relative to the working directory, not the HTML
  // file, so starting the daemon from elsewhere (e.g. apps/cli) yields unloadable `/../…`
  // script paths and a blank page. Run from the web app's directory when running from source;
  // the compiled binary embeds the UI and is unaffected.
  if (!import.meta.dir.startsWith("/$bunfs")) {
    process.chdir(dirname(Bun.resolveSync("@opticon/web/index.html", import.meta.dir)));
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    development: !!process.env.OPTICON_DEV,
    // SSE connections idle between events; heartbeats keep them under this.
    idleTimeout: 60,
    routes: {
      "/*": index,

      /** Same shape opticon.tv serves statically, so one web app runs in both places. */
      "/config.json": () => {
        const ep = endpoints();
        return Response.json({ mode: "local", convexUrl: ep?.convexUrl, siteUrl: ep?.siteUrl, webUrl: ep?.webUrl });
      },

      /**
       * The CLI's login, for this cookie-gated page to talk to Convex directly (share viewer,
       * My shares). It grants nothing the local API doesn't already: that API can create and
       * delete shares with the same token.
       */
      "/api/convex-token": guard(async () => Response.json({ token: (await readAuth())?.token ?? null })),

      "/api/health": () => Response.json({ protocol: PROTOCOL_VERSION, version: options.version, pid: process.pid }),

      /** `opticon web` opens /auth?token=…; the cookie is then sent on every same-origin API call. */
      "/auth": (req) => {
        const url = new URL(req.url);
        if (url.searchParams.get("token") !== options.token) return new Response("Invalid token", { status: 401 });
        req.cookies.set(COOKIE, options.token, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 365 });
        // `opticon web` opens on your sessions; the home page stays reachable at /.
        const next = url.searchParams.get("next") ?? "/local";
        // "//host" is protocol-relative, i.e. an external redirect.
        return Response.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/local", 302);
      },

      "/api/sessions": guard(() => Response.json(store.list())),

      "/api/sessions/stream": guard((req) =>
        sse(req.signal, (send) => {
          send({ type: "list", sessions: store.list() });
          send(shareState());
          const offList = store.onList((change) => send({ type: "change", ...change }));
          const offShares = sync.onChange(() => send(shareState()));
          return () => {
            offList();
            offShares();
          };
        }),
      ),

      "/api/sessions/:provider/:id": guard(async (req) => {
        const result = await store.events(sessionKey(req));
        return result ? Response.json(result) : Response.json({ error: "not found" }, { status: 404 });
      }),

      "/api/sessions/:provider/:id/meta": guard((req) => {
        const meta = store.get(sessionKey(req));
        return meta ? Response.json(meta) : Response.json({ error: "not found" }, { status: 404 });
      }),

      "/api/sessions/:provider/:id/stream": guard(async (req) => {
        const key = sessionKey(req);
        if (!store.get(key)) return Response.json({ error: "not found" }, { status: 404 });
        return sse(req.signal, (send) => {
          const unsubscribe = store.subscribe(key, send);
          return () => void unsubscribe.then((fn) => fn?.());
        });
      }),

      "/api/sessions/:provider/:id/share": guard(async (req) => {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        const { access, discoverable } = (await req.json()) as { access: ShareAccess; discoverable?: boolean };
        // The dialog's checkbox is the source of truth, so an explicit false unlists an existing share.
        return sync
          .share(sessionKey(req), normalizeAccess(access), { discoverable: !!discoverable && access.anyone })
          .then((r) => Response.json(r), failure);
      }),

      /** DELETE deletes the server copy; autosync won't bring it back. */
      "/api/shares/:shareId": guard(async (req) => {
        if (req.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
        return sync.delete(String(req.params.shareId)).then(() => Response.json({ ok: true }), failure);
      }),

      /** Makes the share private; the copy stays and keeps syncing. */
      "/api/shares/:shareId/unshare": guard(async (req) => {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        return sync.unshare(String(req.params.shareId)).then(() => Response.json({ ok: true }), failure);
      }),

      /**
       * Autosync for this session's project. GET reports the rule covering it, if any, and what a
       * new rule would match; POST adds a public, discoverable one; DELETE removes it.
       */
      "/api/sessions/:provider/:id/autosync": guard(async (req) => {
        const cwd = store.get(sessionKey(req))?.cwd;
        if (!cwd) return Response.json({ error: "This session has no working directory" }, { status: 404 });
        if (req.method === "POST") {
          await addRule(await newRule(cwd));
        } else if (req.method === "DELETE") {
          const rule = await sync.ruleFor(cwd);
          if (rule) await removeRule(rule);
        }
        if (req.method !== "GET") await sync.reloadRules();
        const [rule, target] = await Promise.all([sync.ruleFor(cwd), newRule(cwd)]);
        return Response.json({ rule: rule ?? null, target: describeRule(target) });
      }),

      "/api/sessions/:provider/:id/share-preview": guard(async (req) => {
        const result = await store.events(sessionKey(req));
        if (!result) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(projectSessionForShare(result));
      }),
    },
  });

  return { server, store, sync };
}

/** Server-sent events with heartbeats. `subscribe` returns its cleanup. */
function sse(signal: AbortSignal, subscribe: (send: (data: unknown) => void) => () => void): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  let heartbeat: Timer | undefined;
  const stop = () => {
    clearInterval(heartbeat);
    cleanup();
  };
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      cleanup = subscribe((data) => write(`data: ${JSON.stringify(data)}\n\n`));
      heartbeat = setInterval(() => write(": ping\n\n"), 15_000);
      signal.addEventListener("abort", stop);
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
