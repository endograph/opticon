#!/usr/bin/env bun
import { watch } from "node:fs";
import {
  PRIVATE_ACCESS,
  PROTOCOL_VERSION,
  type SessionEvent,
  describeAccess,
  SessionTail,
  listSessionFiles,
  projectForShare,
  projectSessionForShare,
  readCodexTitles,
  readSessionMeta,
} from "@opticon/core";
import { api } from "@opticon/server/api";
import { ConvexHttpClient } from "convex/browser";
import {
  clearAuth,
  currentInstance,
  defaultAccess,
  endpoints,
  instanceOverridden,
  instances,
  login,
  readAuth,
  removeInstance,
  selectInstance,
} from "./account";
import { addRule, currentRules, describeRule, newRule, removeInstanceRules, removeRule, ruleTarget } from "./autosync";
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
  opticon instance                 Show the Opticon servers you use; every other command uses the selected one
  opticon instance <url|name>      Select a server, adding it if it's new (e.g. opticon.acme.dev)
  opticon instance remove <name>   Forget a server and this machine's sign-in to it
  opticon autosync [dir] [--yes]   Sync this project's sessions (matched by git remote, else by
                                   directory) and list them with the default access
  opticon autosync off [dir]       Stop autosyncing this project
  opticon autosync list            Show autosynced projects
  opticon live-sync [on|off]       Stream shared sessions while someone is watching (default on)
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
    console.log(`Signed in to ${currentInstance().name} as ${auth.login}.`);
    break;
  }
  case "instance":
    await instance().catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
    break;
  case "logout": {
    const auth = await readAuth();
    const ep = endpoints();
    if (auth && ep) await new ConvexHttpClient(ep.convexUrl).mutation(api.auth.logout, { token: auth.token }).catch(() => {});
    await clearAuth();
    console.log(auth ? `Signed out of ${currentInstance().name}.` : `Not signed in to ${currentInstance().name}.`);
    break;
  }
  case "whoami": {
    const auth = await readAuth();
    const ep = endpoints();
    const me = auth && ep ? await new ConvexHttpClient(ep.convexUrl).query(api.auth.me, { token: auth.token }).catch(() => null) : null;
    console.log(
      me
        ? `${me.login} on ${currentInstance().name}${me.liveSync ? "" : " (live sync off)"}`
        : `Not signed in to ${currentInstance().name}. Run \`opticon login\`.`,
    );
    break;
  }
  case "live-sync": {
    await liveSync(args[0]);
    break;
  }
  case "autosync":
    await autosync();
    break;
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

/**
 * Live sync streams new messages to a shared session while someone is viewing it. It's an
 * account setting on the server, so it applies to every machine you're signed in on.
 */
async function liveSync(value: string | undefined) {
  const auth = await readAuth();
  const ep = endpoints();
  if (!auth || !ep) {
    console.error("Not signed in. Run `opticon login`.");
    process.exit(1);
  }
  const client = new ConvexHttpClient(ep.convexUrl);
  if (value === "on" || value === "off") {
    await client.mutation(api.auth.setLiveSync, { token: auth.token, liveSync: value === "on" });
  } else if (value !== undefined) {
    console.error("Usage: opticon live-sync [on|off]");
    process.exit(1);
  }
  const me = await client.query(api.auth.me, { token: auth.token });
  if (!me) {
    console.error("Your login expired. Run `opticon login`.");
    process.exit(1);
  }
  console.log(
    me.liveSync
      ? "Live sync is on: shared sessions update while someone is watching."
      : "Live sync is off: viewers see each share as it was when you last shared or resynced it.",
  );
}

/**
 * Instances live in ~/.opticon/instances.json. The daemon syncs with all of them; the selection
 * only decides which one commands and the local app act on.
 */
async function instance() {
  const [sub, name] = args;
  if (sub === "remove") {
    const removed = await removeInstance(requireArg(name));
    const rules = await removeInstanceRules(removed.convexUrl);
    console.log(`Removed ${removed.name}${rules ? ` and its ${rules} autosync rule${rules === 1 ? "" : "s"}` : ""}. Using ${currentInstance().name}.`);
    return;
  }
  if (sub) {
    const { instance, added } = await selectInstance(sub);
    const auth = await readAuth(instance.convexUrl);
    console.log(`${added ? "Added and selected" : "Selected"} ${instance.name} (${instance.webUrl}).`);
    console.log(auth ? `Signed in as ${auth.login}.` : "Not signed in there yet: run `opticon login`.");
    if (instanceOverridden()) console.log("Note: OPTICON_DEV or OPTICON_*_URL is set, which overrides the selection.");
    return;
  }
  const current = currentInstance();
  for (const i of instances()) {
    const auth = await readAuth(i.convexUrl);
    console.log(`${i.name === current.name ? "*" : " "} ${i.name.padEnd(28)} ${auth ? auth.login : "(not signed in)"}`);
  }
  if (instanceOverridden()) console.log(`\nOPTICON_DEV or OPTICON_*_URL is set: using ${endpoints().webUrl}.`);
}

/** Rules live in ~/.opticon/autosync.json; the daemon watches that file. Each belongs to one instance. */
async function autosync() {
  const [sub, dir] = args[0] === "off" || args[0] === "list" ? [args[0], args[1]] : [undefined, args[0]];
  const target = dir && !dir.startsWith("--") ? dir : process.cwd();
  if (sub === "list") {
    const rules = await currentRules();
    if (!rules.length) console.log(`No autosynced projects on ${currentInstance().name}. Add one with \`opticon autosync [dir]\`.`);
    for (const r of rules) console.log(describeRule(r));
    return;
  }
  if (sub === "off") {
    const rule = await ruleTarget(target);
    console.log((await removeRule(rule)) ? `Stopped autosyncing ${describeRule(rule)}.` : `${describeRule(rule)} wasn't autosyncing.`);
    return;
  }
  const rule = await newRule(target, await defaultAccess());
  const who = describeAccess(rule.share ?? PRIVATE_ACCESS).toLowerCase();
  const question = `This will sync all of your sessions in ${describeRule(rule)} to ${currentInstance().name} and list them for ${who}.`;
  if (!args.includes("--yes")) {
    if (!process.stdin.isTTY) {
      console.error(`${question}\nRe-run with --yes to confirm.`);
      process.exit(1);
    }
    const answer = prompt(`${question} Continue? [Y/n]`)?.trim().toLowerCase() ?? "n";
    if (answer && answer !== "y" && answer !== "yes") return console.log("Cancelled.");
  }
  await addRule(rule);
  const auth = await readAuth();
  console.log(`Autosyncing ${describeRule(rule)}. Sessions active from now on are uploaded as they change.`);
  if (auth) console.log(`They'll be listed at ${endpoints().webUrl}/u/${auth.login} for ${who}. Unshare or delete any of them from My shares.`);
  const repo = rule.repo?.startsWith("github.com/") ? rule.repo.slice("github.com/".length) : undefined;
  if (auth && repo) console.log(`Once GitHub confirms you can push to ${repo}, they'll also be on ${endpoints().webUrl}/gh/${repo}.`);
  else console.log("Not signed in yet: run `opticon login`.");
  // The daemon does the syncing.
  await ensureDaemon();
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
  if (!shared) {
    header(tail);
    for (const e of tail.events.values()) print(e);
    return;
  }
  const { meta, events, findings } = projectSessionForShare({ meta: tail.meta, events: tail.events.values() });
  console.log(`# ${meta.title ?? "(untitled)"}\n${meta.project ?? ""}\n`);
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
