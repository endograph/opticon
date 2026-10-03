import { copyFile } from "node:fs/promises";
import { join } from "node:path";

// Cloudflare Pages serves index.html for the root and SPA routes such as /cli and /s/<slug>.
const web = join(import.meta.dir, "../apps/web");
const output = join(web, "dist-hosted");
await copyFile(join(web, "config.production.json"), join(output, "config.json"));
await Bun.write(join(output, "_headers"), "/config.json\n  Cache-Control: no-store\n");
