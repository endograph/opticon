import { existsSync } from "node:fs";

export const DEFAULT_TAILSCALE_PORT = 8454;

const APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function binary(): string | undefined {
  return Bun.which("tailscale") ?? (existsSync(APP_BINARY) ? APP_BINARY : undefined);
}

async function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = binary();
  if (!bin) return { ok: false, stdout: "", stderr: "Tailscale is not installed." };
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, stdout, stderr };
}

/** This machine's MagicDNS name, e.g. `fox.tailc25d5b.ts.net`, or undefined without Tailscale. */
export async function tailnetHostname(): Promise<string | undefined> {
  const { ok, stdout } = await run(["status", "--json"]);
  if (!ok) return undefined;
  try {
    const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName;
    return name?.replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

interface ServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

/**
 * Publishes the local daemon to this tailnet only, over Tailscale-issued HTTPS. Refuses to touch
 * a port that already serves something else, and never enables Funnel.
 */
export async function serveOnTailnet(daemonPort: number, httpsPort: number): Promise<string> {
  const host = await tailnetHostname();
  if (!host) throw new Error("Tailscale isn't running on this machine.");
  const target = `http://127.0.0.1:${daemonPort}`;
  const status = await run(["serve", "status", "--json"]);
  const serve = (status.ok && status.stdout.trim() ? JSON.parse(status.stdout) : {}) as ServeStatus;
  const existing = serve.Web?.[`${host}:${httpsPort}`]?.Handlers;
  const ours = existing && Object.keys(existing).length === 1 && existing["/"]?.Proxy === target;
  if (!ours && (existing || serve.TCP?.[String(httpsPort)])) {
    throw new Error(`Tailscale port ${httpsPort} already serves something else. Pick another with --tailscale-port.`);
  }
  if (serve.AllowFunnel?.[`${host}:${httpsPort}`]) {
    throw new Error(`Tailscale port ${httpsPort} has Funnel (public access) enabled. Refusing to publish opticon there.`);
  }
  if (!ours) {
    const result = await run(["serve", "--bg", `--https=${httpsPort}`, target]);
    if (!result.ok) throw new Error(`tailscale serve failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return `https://${host}:${httpsPort}`;
}

export async function stopServing(httpsPort: number): Promise<void> {
  const result = await run(["serve", `--https=${httpsPort}`, "off"]);
  if (!result.ok) throw new Error(`tailscale serve off failed: ${result.stderr.trim() || result.stdout.trim()}`);
}
