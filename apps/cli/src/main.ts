#!/usr/bin/env bun
import { watch } from "node:fs";
import {
  PROTOCOL_VERSION,
  type SessionEvent,
  SessionTail,
  listSessionFiles,
  projectForShare,
  readCodexTitles,
  readSessionMeta,
} from "@opticon/core";
import { api } from "@opticon/server/api";
import { ConvexHttpClient } from "convex/browser";
import { clearAuth, endpoints, login, readAuth } from "./account";
import { VERSION, ensureDaemon, localToken, runDaemon, stopDaemon } from "./daemon/lifecycle";
import { DEFAULT_TAILSCALE_PORT, serveOnTailnet, stopServing } from "./tailscale";
import { update } from "./update";

const HELP = `opticon ${VERSION} (protocol v${PROTOCOL_VERSION})

Usage:
  opticon web                      Open your sessions in the browser (starts the daemon if needed)
  opticon web --tailscale          Serve them to your other tailnet devices over HTTPS instead
                                   [--tailscale-port N] (default ${DEFAULT_TAILSCALE_PORT}); --tailscale off to stop
  opticon web --no-open            Print the link instead of opening a browser
  opticon login                    Sign in with GitHub to share sessions
  opticon logout                   Sign out on this machine
  opticon whoami                   Show who you're signed in as
  opticon daemon                   Run the daemon in the foreground
  opticon stop                     Stop the background daemon
  opticon sessions [--limit N]     List local Claude Code and Codex sessions, newest first
  opticon show <id> [--shared]     Print a transcript (--shared: exactly what sharing would upload)
  opticon watch <id>               Print a transcript, then follow it live
  opticon update [version]         Update to the latest release (or the given version)
  opticon version                  Print the version
`;

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "web":
    await web();
    break;
  case "login": {
    const auth = await login(openUrl);
    console.log(`Signed in as ${auth.login}.`);
    break;
  }
  case "logout": {
    const auth = await readAuth();
    const ep = endpoints();
    if (auth && ep) await new ConvexHttpClient(ep.convexUrl).mutation(api.auth.logout, { token: auth.token }).catch(() => {});
    await clearAuth();
    console.log(auth ? "Signed out." : "Not signed in.");
    break;
  }
  case "whoami": {
    const auth = await readAuth();
    const ep = endpoints();
    const me = auth && ep ? await new ConvexHttpClient(ep.convexUrl).query(api.auth.me, { token: auth.token }).catch(() => null) : null;
    console.log(me ? `${me.login}${me.liveSync ? "" : " (live sync off)"}` : "Not signed in. Run `opticon login`.");
    break;
  }
  case "daemon":
    await runDaemon(flag("--port") ? Number(flag("--port")) : undefined);
    break;
  case "stop":
    console.log((await stopDaemon()) ? "Daemon stopped." : "Daemon not running.");
    break;
  case "sessions":
    await sessions(Number(flag("--limit") ?? 20));
    break;
  case "show":
    await show(requireArg(args[0]), args.includes("--shared"));
    break;
  case "watch":
    await follow(requireArg(args[0]));
    break;
  case "update":
    await update(args[0]).catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
    break;
  case "version":
  case "--version":
    console.log(VERSION);
    break;
  default:
    process.stdout.write(HELP);
    process.exit(command && command !== "help" ? 1 : 0);
}

async function web() {
  const tailscale = args.includes("--tailscale");
  const tailscalePort = Number(flag("--tailscale-port") ?? DEFAULT_TAILSCALE_PORT);
  if (tailscale && args[args.indexOf("--tailscale") + 1] === "off") {
    await stopServing(tailscalePort);
    console.log(`Stopped serving opticon on the tailnet (port ${tailscalePort}).`);
    return;
  }
  const { port } = await ensureDaemon();
  const base = tailscale ? await serveOnTailnet(port, tailscalePort) : `http://127.0.0.1:${port}`;
  const url = `${base}/auth?token=${encodeURIComponent(await localToken())}`;
  if (tailscale) {
    console.log(`Serving on your tailnet only (not public). Open this on any of your devices:\n${url}`);
    console.log(`\nThe link contains this machine's access token; don't share it. Stop with: opticon web --tailscale off`);
    return;
  }
  if (!args.includes("--no-open") && (await openUrl(url))) console.log(`Opened ${base}`);
  else console.log(`Open this URL in your browser:\n${url}`);
}

async function openUrl(url: string): Promise<boolean> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return (await Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => 1)) === 0;
}

async function sessions(limit: number) {
  const [files, titles] = await Promise.all([listSessionFiles(), readCodexTitles()]);
  const metas = await Promise.all(files.slice(0, limit).map((f) => readSessionMeta(f, titles)));
  for (const m of metas) {
    const when = m.updatedAt?.slice(0, 16).replace("T", " ") ?? "";
    console.log(`${m.provider.padEnd(6)} ${m.id.slice(0, 8)}  ${when}  ${(m.title ?? "(untitled)").slice(0, 60).padEnd(60)}  ${m.cwd ?? ""}`);
  }
}

async function open(prefix: string): Promise<SessionTail> {
  const [files, titles] = await Promise.all([listSessionFiles(), readCodexTitles()]);
  // Ids appear in both providers' filenames, so match on the path instead of reading every file.
  const matches = files.filter((f) => f.path.split("/").at(-1)?.includes(prefix));
  if (matches.length !== 1) {
    console.error(matches.length ? `"${prefix}" is ambiguous (${matches.length} matches)` : `No session matching "${prefix}"`);
    process.exit(1);
  }
  const file = matches[0]!;
  const meta = await readSessionMeta(file, titles);
  return new SessionTail(file.provider, file.path, meta.title);
}

async function show(prefix: string, shared: boolean) {
  const tail = await open(prefix);
  await tail.read();
  header(tail);
  if (!shared) {
    for (const e of tail.events.values()) print(e);
    return;
  }
  const { events, findings } = projectForShare(tail.events.values());
  for (const e of events) print(e);
  console.log(`\n${events.length} events would be shared.`);
  console.log(findings.length ? `Redacted: ${findings.map((f) => `${f.rule} ×${f.count}`).join(", ")}` : "Nothing redacted.");
}

async function follow(prefix: string) {
  const tail = await open(prefix);
  await tail.read();
  header(tail);
  for (const e of tail.events.values()) print(e);
  console.log("\n— following, ctrl-c to stop —\n");
  let pending = Promise.resolve();
  const pump = () => {
    pending = pending.then(async () => {
      const { changed, reset } = await tail.read();
      if (reset) console.log("— file rewritten, restarting —");
      for (const e of changed) print(e);
    });
  };
  watch(tail.path, pump);
  // FSEvents can coalesce or drop events; a slow poll guarantees progress.
  setInterval(pump, 2000);
}

function header(tail: SessionTail) {
  const m = tail.meta;
  console.log(`# ${m.title ?? "(untitled)"}\n${m.provider} ${m.id}  ${m.cwd ?? ""}${m.gitBranch ? ` @ ${m.gitBranch}` : ""}\n`);
}

function print(e: SessionEvent | ReturnType<typeof projectForShare>["events"][number]) {
  switch (e.kind) {
    case "message":
      console.log(`${e.role === "user" ? "▶ user" : "◀ assistant"}\n${e.text}\n`);
      break;
    case "thinking":
      console.log(`  ∴ ${e.text.split("\n", 1)[0]?.slice(0, 100)}`);
      break;
    case "tool": {
      const icon = { running: "…", ok: "✓", error: "✗" }[e.status];
      const summary = "summary" in e && e.summary ? `  ${e.summary}` : "";
      console.log(`  ${icon} [${e.category}] ${e.name}${summary}`);
      break;
    }
    case "notice":
      console.log(`  — ${e.text} —`);
      break;
  }
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function requireArg(value: string | undefined): string {
  if (!value) {
    process.stdout.write(HELP);
    process.exit(1);
  }
  return value;
}
