import { copyFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Finishes the hosted web build in apps/web/dist-hosted: its /config.json, the installer, and
 * headers. The config says which backend this instance uses:
 *
 *   OPTICON_CONVEX_URL=https://xyz.convex.cloud \
 *   OPTICON_CONVEX_SITE_URL=https://xyz.convex.site \
 *   OPTICON_WEB_URL=https://opticon.acme.dev \
 *   bun run --filter @opticon/web build:hosted
 *
 * Without them it's opticon.tv's (config.production.json).
 */
const web = join(import.meta.dir, "../apps/web");
const output = join(web, "dist-hosted");
const env = {
  convexUrl: process.env.OPTICON_CONVEX_URL,
  siteUrl: process.env.OPTICON_CONVEX_SITE_URL,
  webUrl: process.env.OPTICON_WEB_URL?.replace(/\/$/, ""),
};
const given = Object.values(env).filter(Boolean).length;
if (given > 0 && given < 3) {
  console.error("Set all of OPTICON_CONVEX_URL, OPTICON_CONVEX_SITE_URL, and OPTICON_WEB_URL, or none for opticon.tv.");
  process.exit(1);
}
const config = given ? { mode: "hosted", ...env } : await Bun.file(join(web, "config.production.json")).json();
await Bun.write(join(output, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`Hosted build for ${config.webUrl} (backend ${config.convexUrl})`);

await copyFile(join(import.meta.dir, "../install.sh"), join(output, "install.sh"));
// Cloudflare Pages reads _headers and serves index.html for SPA routes such as /cli and /s/<slug>.
// On other hosts, set the same headers and fallback yourself (see docs/self-hosting.md).
await Bun.write(
  join(output, "_headers"),
  "/config.json\n  Cache-Control: no-store\n/install.sh\n  Content-Type: text/plain; charset=utf-8\n  Cache-Control: no-cache\n",
);
