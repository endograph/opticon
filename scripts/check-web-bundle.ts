// Fails if a compiled opticon binary serves a web UI that imports Node builtins. A browser can't
// load `node:` modules, so one stray import (e.g. a value from @opticon/core's index, which
// re-exports the file tailers) leaves `opticon web` blank. Running from source doesn't show it.
// Usage: bun scripts/check-web-bundle.ts <binary>
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.argv[2];
if (!binary) {
  console.error("Usage: bun scripts/check-web-bundle.ts <binary>");
  process.exit(1);
}

const home = await mkdtemp(join(tmpdir(), "opticon-check-"));
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const daemon = Bun.spawn([binary, "daemon"], {
  env: { ...process.env, OPTICON_HOME: home, OPTICON_PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});

try {
  const base = `http://127.0.0.1:${port}`;
  const html = await waitForPage(base);
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="(?:\.?\/)?([^"]+\.js)"/g)].map((m) => m[1]!);
  if (!scripts.length) throw new Error("The web UI has no scripts.");
  for (const script of scripts) {
    const code = await (await fetch(`${base}/${script}`)).text();
    const builtins = [...new Set(code.match(/["']node:[\w/]+["']/g))];
    if (builtins.length) throw new Error(`The web UI's ${script} imports ${builtins.join(", ")}; the page would render blank.`);
  }
  console.log(`Web UI bundle has no Node imports (${scripts.join(", ")}).`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  daemon.kill();
  await daemon.exited;
  await rm(home, { recursive: true, force: true });
}

async function waitForPage(base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/`).catch(() => undefined);
    if (res?.ok) return res.text();
    await Bun.sleep(100);
  }
  throw new Error(`${binary} daemon didn't serve the web UI.`);
}
