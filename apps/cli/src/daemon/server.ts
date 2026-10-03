import { PROTOCOL_VERSION, projectForShare } from "@opticon/core";
import index from "@opticon/web/index.html";
import { type SessionKey, SessionStore } from "./store";

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
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);

  const guard =
    (handler: (req: Bun.BunRequest<any>) => Response | Promise<Response>) =>
    (req: Bun.BunRequest<any>): Response | Promise<Response> => {
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Bad host", { status: 421 });
      if (req.cookies.get(COOKIE) !== options.token) return Response.json({ error: "unauthorized" }, { status: 401 });
      return handler(req);
    };

  const sessionKey = (req: Bun.BunRequest<"/api/sessions/:provider/:id">) =>
    `${req.params.provider}/${req.params.id}` as SessionKey;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    development: !!process.env.OPTICON_DEV,
    // SSE connections idle between events; heartbeats keep them under this.
    idleTimeout: 60,
    routes: {
      "/*": index,

      "/api/health": () => Response.json({ protocol: PROTOCOL_VERSION, version: options.version, pid: process.pid }),

      /** `opticon web` opens /auth?token=…; the cookie is then sent on every same-origin API call. */
      "/auth": (req) => {
        const url = new URL(req.url);
        if (url.searchParams.get("token") !== options.token) return new Response("Invalid token", { status: 401 });
        req.cookies.set(COOKIE, options.token, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 365 });
        return Response.redirect(url.searchParams.get("next")?.startsWith("/") ? url.searchParams.get("next")! : "/", 302);
      },

      "/api/sessions": guard(() => Response.json(store.list())),

      "/api/sessions/stream": guard((req) =>
        sse(req.signal, (send) => {
          send({ type: "list", sessions: store.list() });
          return store.onList((change) => send({ type: "change", ...change }));
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

      "/api/sessions/:provider/:id/share-preview": guard(async (req) => {
        const result = await store.events(sessionKey(req));
        if (!result) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ meta: result.meta, ...projectForShare(result.events) });
      }),
    },
  });

  return { server, store };
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
