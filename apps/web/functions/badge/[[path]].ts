/**
 * Cloudflare Pages Function: serves README badges from <web>/badge/* by proxying to the
 * instance's Convex HTTP route, so badge URLs embedded in READMEs don't depend on the backend.
 * The backend comes from the deployed /config.json, so every instance's build works unchanged.
 */
interface Env {
  ASSETS: { fetch: (request: Request | string) => Promise<Response> };
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const url = new URL(request.url);
  const config = (await (await env.ASSETS.fetch(new URL("/config.json", url).toString())).json()) as { siteUrl: string };
  const upstream = await fetch(`${config.siteUrl}${url.pathname}`);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
      "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
    },
  });
}
