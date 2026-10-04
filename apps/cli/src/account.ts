import type { ShareAccess } from "@opticon/core";
import { api } from "@opticon/server/api";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { OPTICON_HOME } from "./paths";

export const AUTH_FILE = join(OPTICON_HOME, "auth.json");
export const INSTANCES_FILE = join(OPTICON_HOME, "instances.json");

/** Where sharing lives: an Opticon server, i.e. its Convex backend and web app. */
export interface Endpoints {
  convexUrl: string;
  siteUrl: string;
  webUrl: string;
}

/** A server this machine knows, named by its web host. Every command uses the selected one. */
export interface Instance extends Endpoints {
  name: string;
}

export const DEFAULT_INSTANCE: Instance = {
  name: "opticon.tv",
  convexUrl: "https://bold-ostrich-850.convex.cloud",
  siteUrl: "https://bold-ostrich-850.convex.site",
  webUrl: "https://opticon.tv",
};

/** The isolated local stack from `bun run convex` and the hosted web dev server. */
const DEV_INSTANCE: Instance = {
  name: "dev",
  convexUrl: "http://127.0.0.1:3310",
  siteUrl: "http://127.0.0.1:3311",
  webUrl: "http://127.0.0.1:4747",
};

interface InstancesFile {
  current?: string;
  instances?: Instance[];
}

/** Read synchronously: it's tiny, and the selected instance is needed everywhere. */
function readInstancesFile(): InstancesFile {
  try {
    return JSON.parse(readFileSync(INSTANCES_FILE, "utf8")) as InstancesFile;
  } catch {
    return {};
  }
}

async function writeInstancesFile(data: InstancesFile): Promise<void> {
  await mkdir(OPTICON_HOME, { recursive: true });
  await Bun.write(INSTANCES_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/** Every known instance, opticon.tv first. */
export function instances(): Instance[] {
  const added = (readInstancesFile().instances ?? []).filter((i) => i.name !== DEFAULT_INSTANCE.name);
  return [DEFAULT_INSTANCE, ...added];
}

/** The selected instance. `OPTICON_DEV=1` selects the local dev stack instead. */
export function currentInstance(): Instance {
  if (process.env.OPTICON_DEV) return DEV_INSTANCE;
  const current = readInstancesFile().current;
  return instances().find((i) => i.name === current) ?? DEFAULT_INSTANCE;
}

/** Set when OPTICON_DEV or OPTICON_*_URL override the selected instance. */
export const instanceOverridden = () =>
  !!(process.env.OPTICON_DEV || process.env.OPTICON_CONVEX_URL || process.env.OPTICON_CONVEX_SITE_URL || process.env.OPTICON_WEB_URL);

/** The selected instance's endpoints, with any OPTICON_*_URL overrides applied. */
export function endpoints(): Endpoints {
  const instance = currentInstance();
  return {
    convexUrl: process.env.OPTICON_CONVEX_URL ?? instance.convexUrl,
    siteUrl: process.env.OPTICON_CONVEX_SITE_URL ?? instance.siteUrl,
    webUrl: process.env.OPTICON_WEB_URL ?? instance.webUrl,
  };
}

/**
 * Selects an instance by name or URL. An unknown URL is added after checking it serves an
 * Opticon web app: its /config.json says where its backend is.
 */
export async function selectInstance(target: string): Promise<{ instance: Instance; added: boolean }> {
  const url = parseInstanceUrl(target);
  const known = instances().find((i) => i.name === target.toLowerCase() || (url && new URL(i.webUrl).host === url.host));
  const instance = known ?? (await discoverInstance(target));
  const file = readInstancesFile();
  const stored = (file.instances ?? []).filter((i) => i.name !== instance.name);
  await writeInstancesFile({ current: instance.name, instances: known ? (file.instances ?? []) : [...stored, instance] });
  return { instance, added: !known };
}

/** Forgets an instance and this machine's sign-in to it. Selects opticon.tv if it was selected. */
export async function removeInstance(name: string): Promise<Instance> {
  const instance = instances().find((i) => i.name === name.toLowerCase());
  if (!instance) throw new Error(`No instance named ${name}. See \`opticon instance\`.`);
  if (instance.name === DEFAULT_INSTANCE.name) throw new Error("opticon.tv is built in and can't be removed.");
  const file = readInstancesFile();
  await writeInstancesFile({
    current: file.current === instance.name ? DEFAULT_INSTANCE.name : file.current,
    instances: (file.instances ?? []).filter((i) => i.name !== instance.name),
  });
  await clearAuth(instance.convexUrl);
  return instance;
}

function parseInstanceUrl(target: string): URL | undefined {
  try {
    return new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
  } catch {
    return undefined;
  }
}

async function discoverInstance(target: string): Promise<Instance> {
  const url = parseInstanceUrl(target);
  if (!url) throw new Error(`${target} isn't a known instance or a URL.`);
  const res = await fetch(new URL("/config.json", url.origin), { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  const config = (res?.ok ? await res.json().catch(() => undefined) : undefined) as Partial<Endpoints & { mode: string }> | undefined;
  // The daemon's own local app serves a config.json too; it isn't an instance.
  if (!config?.convexUrl || !config.siteUrl || config.mode === "local") {
    throw new Error(`${url.origin} doesn't look like an Opticon instance (no usable /config.json).`);
  }
  const webUrl = (config.webUrl ?? url.origin).replace(/\/$/, "");
  return { name: new URL(webUrl).host, convexUrl: config.convexUrl, siteUrl: config.siteUrl, webUrl };
}

/** A server's limits and where its GitHub is, by default the selected server's. */
export async function instancePolicy(convexUrl = endpoints().convexUrl) {
  return new ConvexHttpClient(convexUrl).query(api.instance.policy, {});
}

/** The access new shares and autosync rules start with on a server, by default the selected one. */
export async function defaultAccess(convexUrl = endpoints().convexUrl): Promise<ShareAccess> {
  return (await instancePolicy(convexUrl)).defaultAccess;
}

/** The servers the daemon syncs with: every known instance, or only the one env vars point at. */
export function syncedInstances(): Instance[] {
  return instanceOverridden() ? [{ ...currentInstance(), ...endpoints() }] : instances();
}

export interface Auth {
  token: string;
  login: string;
  /** The backend this token belongs to. */
  convexUrl: string;
}

/** Sign-ins by backend, so switching instances back and forth keeps each one. */
type AuthFile = Record<string, { token: string; login: string }>;

async function readAuthFile(): Promise<AuthFile> {
  const file = Bun.file(AUTH_FILE);
  if (!(await file.exists())) return {};
  const data = (await file.json().catch(() => ({}))) as AuthFile | Auth;
  // Before instances, auth.json held a single sign-in.
  if (typeof data.token === "string") {
    const { token, login, convexUrl } = data as Auth;
    return { [convexUrl]: { token, login } };
  }
  return data as AuthFile;
}

async function writeAuthFile(data: AuthFile): Promise<void> {
  await mkdir(OPTICON_HOME, { recursive: true });
  await Bun.write(AUTH_FILE, JSON.stringify(data));
  await chmod(AUTH_FILE, 0o600);
}

/** This machine's sign-in to `convexUrl`, by default the selected instance's. */
export async function readAuth(convexUrl = endpoints().convexUrl): Promise<Auth | undefined> {
  const entry = (await readAuthFile())[convexUrl];
  return entry && { ...entry, convexUrl };
}

export async function writeAuth(auth: Auth): Promise<void> {
  const { convexUrl, ...entry } = auth;
  await writeAuthFile({ ...(await readAuthFile()), [convexUrl]: entry });
}

export async function clearAuth(convexUrl = endpoints().convexUrl): Promise<void> {
  const { [convexUrl]: _, ...rest } = await readAuthFile();
  await writeAuthFile(rest);
}

/** Device-style login: show a code, the user approves it on the web, we poll for a token. */
export async function login(open: (url: string) => Promise<boolean>): Promise<Auth> {
  const ep = endpoints();
  const start = await fetch(`${ep.siteUrl}/cli/start`, {
    method: "POST",
    body: JSON.stringify({ label: `opticon on ${hostname()}` }),
  });
  if (!start.ok) throw new Error(`Login failed to start (${start.status}).`);
  const { userCode, pollSecret, verifyUrl } = (await start.json()) as { userCode: string; pollSecret: string; verifyUrl: string };

  // Sign in with GitHub first, then land on the approval page. The dev stack has no GitHub,
  // and its approval page offers its own sign-in.
  const link = process.env.OPTICON_DEV
    ? verifyUrl
    : `${ep.siteUrl}/auth/github/start?redirect=${encodeURIComponent(verifyUrl)}`;
  console.log(`\nSign in with GitHub and approve this login:\n${link}\n\nCheck that the page shows the code ${userCode}.`);
  // Over SSH a browser would open on the remote machine's screen, not yours.
  if (!process.env.SSH_CONNECTION && (await open(link))) console.log("(Opened in your browser.)");
  console.log("\nWaiting for approval…");

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2_000);
    const res = await fetch(`${ep.siteUrl}/cli/poll`, { method: "POST", body: JSON.stringify({ pollSecret }) });
    const body = (await res.json().catch(() => ({ status: "error" }))) as { status: string; token?: string; login?: string };
    if (body.status === "approved" && body.token && body.login) {
      const auth = { token: body.token, login: body.login, convexUrl: ep.convexUrl };
      await writeAuth(auth);
      return auth;
    }
    if (body.status === "expired") break;
  }
  throw new Error("Login expired. Run `opticon login` again.");
}
