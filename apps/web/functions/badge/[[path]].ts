import config from "../../config.production.json";

/**
 * Cloudflare Pages Function: serves README badges from opticon.tv/badge/* by proxying to the
 * Convex HTTP route, so badge URLs embedded in READMEs don't depend on the Convex deployment.
 */
export async function onRequestGet({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const upstream = await fetch(`${config.siteUrl}${url.pathname}`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
      "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
    },
  });
}
