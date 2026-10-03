/**
 * Dev server for the hosted web app (opticon.com in production). Serves the bundled app for
 * every route plus /config.json pointing at the local Convex backend from `bun run convex`.
 */
import hosted from "./hosted.html";

const port = Number(process.env.OPTICON_WEB_PORT ?? 4747);
const convexPort = Number(process.env.OPTICON_CONVEX_PORT ?? 3310);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: true,
  routes: {
    "/config.json": () =>
      Response.json({
        convexUrl: process.env.OPTICON_CONVEX_URL ?? `http://127.0.0.1:${convexPort}`,
        siteUrl: process.env.OPTICON_CONVEX_SITE_URL ?? `http://127.0.0.1:${convexPort + 1}`,
        devAuth: process.env.OPTICON_DEV_AUTH !== "0",
      }),
    "/*": hosted,
  },
});

console.log(`Hosted web dev server at ${server.url}`);
