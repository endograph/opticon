#!/usr/bin/env bun
/**
 * Runs an isolated, self-hosted Convex backend for development and pushes apps/server/convex to it.
 *
 * Never use `convex dev` anonymous/agent mode here: it targets a deployment shared by every
 * project on the machine and will replace their functions.
 *
 *   bun scripts/convex-local.ts          start backend, push once, keep backend running
 *   bun scripts/convex-local.ts --watch  start backend and keep pushing on change
 *   bun scripts/convex-local.ts --env    print env vars for clients
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STATE = join(ROOT, ".convex-local");
const PORT = Number(process.env.OPTICON_CONVEX_PORT ?? 3310);
const SITE_PORT = PORT + 1;
const INSTANCE = "opticon-dev";
const URL = `http://127.0.0.1:${PORT}`;
const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;

await mkdir(STATE, { recursive: true });
const secretPath = join(STATE, "instance-secret");
if (!(await Bun.file(secretPath).exists())) await Bun.write(secretPath, randomBytes(32).toString("hex"));
const secret = (await Bun.file(secretPath).text()).trim();
const binary = await findBackend();
const adminKey = (
  await new Response(
    Bun.spawn([binary, "keygen", "admin-key", "--instance-name", INSTANCE, "--instance-secret", secret]).stdout,
  ).text()
).trim();

if (process.argv.includes("--env")) {
  console.log(`OPTICON_CONVEX_URL=${URL}\nOPTICON_CONVEX_SITE_URL=${SITE_URL}\nCONVEX_SELF_HOSTED_URL=${URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`);
  process.exit(0);
}

if (!(await healthy())) {
  const log = Bun.file(join(STATE, "backend.log"));
  Bun.spawn(
    [
      binary,
      join(STATE, "db.sqlite3"),
      "--interface", "127.0.0.1",
      "--port", String(PORT),
      "--site-proxy-port", String(SITE_PORT),
      "--instance-name", INSTANCE,
      "--instance-secret", secret,
      "--local-storage", join(STATE, "storage"),
      "--disable-beacon",
    ],
    { stdout: log, stderr: log, cwd: STATE },
  ).unref();
  for (let i = 0; i < 100 && !(await healthy()); i++) await Bun.sleep(100);
  if (!(await healthy())) throw new Error(`Backend failed to start, see ${join(STATE, "backend.log")}`);
  console.log(`Convex backend running at ${URL} (HTTP actions ${SITE_URL})`);
}

// Self-hosted mode: CONVEX_DEPLOYMENT must be unset or the CLI targets that deployment instead.
const env = { ...process.env, CONVEX_SELF_HOSTED_URL: URL, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey };
delete env.CONVEX_DEPLOYMENT;
delete env.CONVEX_AGENT_MODE;
// Dev-only backend settings. OPTICON_DEV_AUTH enables passwordless /auth/dev logins.
const devEnv = { OPTICON_DEV_AUTH: "1", OPTICON_WEB_URL: process.env.OPTICON_WEB_URL ?? "http://127.0.0.1:4747" };
for (const [name, value] of Object.entries(devEnv)) {
  await Bun.spawn(["bunx", "convex", "env", "set", name, value], { cwd: join(ROOT, "apps/server"), env, stdout: "ignore" }).exited;
}
const watch = process.argv.includes("--watch");
const push = Bun.spawn(["bunx", "convex", "dev", ...(watch ? [] : ["--once"]), "--typecheck", "disable"], {
  cwd: join(ROOT, "apps/server"),
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await push.exited);

async function healthy(): Promise<boolean> {
  return fetch(`${URL}/version`, { signal: AbortSignal.timeout(500) }).then(
    (r) => r.ok,
    () => false,
  );
}

/** The Convex CLI caches backend binaries here; take the newest. */
async function findBackend(): Promise<string> {
  const dir = join(homedir(), ".cache/convex/binaries");
  const versions = (await readdir(dir).catch(() => [])).sort();
  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(
      "No Convex backend binary cached. Download convex-local-backend from https://github.com/get-convex/convex-backend/releases into ~/.cache/convex/binaries/<version>/",
    );
  }
  return join(dir, latest, "convex-local-backend");
}
