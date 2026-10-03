import { chmod, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { OPTICON_HOME } from "./paths";

export const AUTH_FILE = join(OPTICON_HOME, "auth.json");

/**
 * Where sharing lives. `OPTICON_DEV=1` targets the isolated local stack from
 * `bun run convex` and the hosted web dev server.
 */
export interface Endpoints {
  convexUrl: string;
  siteUrl: string;
  webUrl: string;
}

export function endpoints(): Endpoints | undefined {
  const dev = !!process.env.OPTICON_DEV;
  const convexUrl = process.env.OPTICON_CONVEX_URL ?? (dev ? "http://127.0.0.1:3310" : undefined);
  const siteUrl = process.env.OPTICON_CONVEX_SITE_URL ?? (dev ? "http://127.0.0.1:3311" : undefined);
  const webUrl = process.env.OPTICON_WEB_URL ?? (dev ? "http://127.0.0.1:4747" : "https://opticon.com");
  return convexUrl && siteUrl ? { convexUrl, siteUrl, webUrl } : undefined;
}

export interface Auth {
  token: string;
  login: string;
  /** The backend this token belongs to. A token for another backend is ignored. */
  convexUrl: string;
}

export async function readAuth(): Promise<Auth | undefined> {
  const file = Bun.file(AUTH_FILE);
  if (!(await file.exists())) return undefined;
  const auth = (await file.json().catch(() => undefined)) as Auth | undefined;
  return auth && auth.convexUrl === endpoints()?.convexUrl ? auth : undefined;
}

export async function writeAuth(auth: Auth): Promise<void> {
  await Bun.write(AUTH_FILE, JSON.stringify(auth));
  await chmod(AUTH_FILE, 0o600);
}

export async function clearAuth(): Promise<void> {
  await rm(AUTH_FILE, { force: true });
}

/** Device-style login: show a code, the user approves it on the web, we poll for a token. */
export async function login(open: (url: string) => Promise<boolean>): Promise<Auth> {
  const ep = endpoints();
  if (!ep) throw new Error("Sharing isn't configured for this build. Set OPTICON_CONVEX_URL and OPTICON_CONVEX_SITE_URL.");
  const start = await fetch(`${ep.siteUrl}/cli/start`, {
    method: "POST",
    body: JSON.stringify({ label: `opticon on ${hostname()}` }),
  });
  if (!start.ok) throw new Error(`Login failed to start (${start.status}).`);
  const { userCode, pollSecret, verifyUrl } = (await start.json()) as { userCode: string; pollSecret: string; verifyUrl: string };

  console.log(`\nYour code: ${userCode}\n`);
  const opened = await open(verifyUrl);
  console.log(opened ? `Confirm it in the browser window that just opened.` : `Open ${verifyUrl} and confirm the code.`);

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
