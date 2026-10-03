import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@opticon/core";
import { DAEMON_FILE, DEFAULT_PORT, LOG_FILE, OPTICON_HOME, TOKEN_FILE, selfCommand } from "../paths";
import { startServer } from "./server";

export const VERSION = "0.0.1";

interface DaemonInfo {
  pid: number;
  port: number;
  protocol: number;
}

/** Runs the daemon in the foreground. */
export async function runDaemon(port = DEFAULT_PORT): Promise<void> {
  const running = await healthyDaemon();
  if (running) {
    console.error(`Daemon already running (pid ${running.pid}, port ${running.port}).`);
    process.exit(1);
  }
  const token = await localToken();
  const started = await startServer({ port, token, version: VERSION }).catch((error: { code?: string }) => {
    if (error.code !== "EADDRINUSE") throw error;
    console.error(`Port ${port} is in use by another program. Set OPTICON_PORT to use a different port.`);
    process.exit(1);
  });
  const { server, store, sync } = started;
  await Bun.write(DAEMON_FILE, JSON.stringify({ pid: process.pid, port, protocol: PROTOCOL_VERSION } satisfies DaemonInfo));
  console.log(`opticon daemon ${VERSION} listening on ${server.url}`);
  const shutdown = async () => {
    store.stop();
    sync.stop();
    server.stop(true);
    const info = await readInfo();
    if (info?.pid === process.pid) await rm(DAEMON_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Returns a healthy daemon, starting one if needed. Replaces a daemon from an incompatible
 * build rather than talking to it: we don't support version skew.
 */
export async function ensureDaemon(): Promise<DaemonInfo> {
  const info = await readInfo();
  if (info) {
    const health = await fetchHealth(info.port);
    if (health?.protocol === PROTOCOL_VERSION && health.version === VERSION) return info;
    if (health) {
      console.log(`Restarting daemon (running ${health.version}, this CLI is ${VERSION}).`);
      await stopDaemon();
    }
  }
  await mkdir(OPTICON_HOME, { recursive: true });
  const log = await open(LOG_FILE, "a");
  const [cmd, ...args] = selfCommand();
  const child = spawn(cmd!, [...args, "daemon"], { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
  child.unref();
  await log.close();
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    const started = await healthyDaemon();
    if (started) return started;
  }
  throw new Error(`Daemon failed to start. See ${LOG_FILE}`);
}

export async function stopDaemon(): Promise<boolean> {
  const info = await readInfo();
  if (!info) return false;
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 30 && (await fetchHealth(info.port)); i++) await Bun.sleep(100);
  await rm(DAEMON_FILE, { force: true });
  return true;
}

export async function healthyDaemon(): Promise<DaemonInfo | undefined> {
  const info = await readInfo();
  if (!info) return undefined;
  const health = await fetchHealth(info.port);
  return health?.pid === info.pid ? info : undefined;
}

/** Persistent across daemon restarts so the browser's cookie stays valid. */
export async function localToken(): Promise<string> {
  const file = Bun.file(TOKEN_FILE);
  if (await file.exists()) return (await file.text()).trim();
  await mkdir(OPTICON_HOME, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  await Bun.write(TOKEN_FILE, token);
  await chmod(TOKEN_FILE, 0o600);
  return token;
}

async function readInfo(): Promise<DaemonInfo | undefined> {
  const file = Bun.file(DAEMON_FILE);
  return (await file.exists()) ? file.json().catch(() => undefined) : undefined;
}

async function fetchHealth(port: number): Promise<{ protocol: number; version: string; pid: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? ((await res.json()) as { protocol: number; version: string; pid: number }) : undefined;
  } catch {
    return undefined;
  }
}
