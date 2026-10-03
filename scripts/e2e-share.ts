#!/usr/bin/env bun
/**
 * End-to-end test of sharing, in a real browser against an isolated local stack: Convex backend
 * (scripts/convex-local.ts), hosted web dev server, and a daemon whose session stores are temp
 * directories. Covers CLI login, sharing, redaction, live sync, access rules, and unsharing.
 *
 *   bun scripts/e2e-share.ts      needs Google Chrome (or set CHROME=/path/to/chrome)
 */
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, chromium } from "playwright-core";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "apps/cli/src/main.ts");
const DAEMON_PORT = 4391;
const RUN = Date.now().toString(36);
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const KEY = `claude/${SESSION_ID}`;

const dir = await mkdtemp(join(tmpdir(), "opticon-e2e-"));
const sessionFile = join(dir, "claude/projects/-tmp-demo", `${SESSION_ID}.jsonl`);
const line = (record: object) => appendFile(sessionFile, `${JSON.stringify(record)}\n`);
await mkdir(join(dir, "claude/projects/-tmp-demo"), { recursive: true });
await mkdir(join(dir, "codex/sessions"), { recursive: true });
await mkdir(join(dir, "bin"), { recursive: true });
await line({ type: "user", uuid: "u1", cwd: "/tmp/demo", message: { content: "first message" } });
await line({ type: "assistant", uuid: "a0", message: { content: [{ type: "text", text: "my key is sk-ant-api03-abcdefghijklmnopqrstuv ok" }] } });
// Records URLs the CLI would open instead of launching a browser.
await writeFile(join(dir, "bin/open"), `#!/bin/sh\necho "$1" >> ${join(dir, "opened")}\n`);
await chmod(join(dir, "bin/open"), 0o755);

const env = {
  ...process.env,
  OPTICON_DEV: "1",
  CLAUDE_CONFIG_DIR: join(dir, "claude"),
  CODEX_HOME: join(dir, "codex"),
  OPTICON_HOME: join(dir, "home"),
  OPTICON_PORT: String(DAEMON_PORT),
  PATH: `${join(dir, "bin")}:${process.env.PATH}`,
};
const spawned: Bun.Subprocess[] = [];
const results: Record<string, string> = {};
let failed = false;

try {
  if ((await Bun.spawn(["bun", join(ROOT, "scripts/convex-local.ts")], { stdout: "ignore", stderr: "inherit" }).exited) !== 0) {
    throw new Error("Convex push failed");
  }
  spawned.push(Bun.spawn(["bun", join(ROOT, "apps/web/hosted-server.ts")], { stdout: "ignore", stderr: "inherit" }));
  spawned.push(Bun.spawn(["bun", CLI, "daemon"], { env, stdout: "ignore", stderr: "inherit" }));
  await waitFor(`http://127.0.0.1:${DAEMON_PORT}/api/health`);
  await waitFor("http://127.0.0.1:4747/config.json");

  const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const person = async (login?: string): Promise<Page> => {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (e) => console.error(`[${login ?? "anonymous"}] ${e.message}`));
    if (login) {
      await page.goto(`http://127.0.0.1:3311/auth/dev?login=${login}&redirect=${encodeURIComponent("http://127.0.0.1:4747/")}`);
      await page.waitForSelector(`text=${login}`);
    }
    return page;
  };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      const detail = await fn();
      results[name] = typeof detail === "string" ? detail : `ok (${Math.round(performance.now() - started)}ms)`;
    } catch (error) {
      failed = true;
      results[name] = `FAIL: ${(error as Error).message.split("\n")[0]}`;
    }
  };

  const owner = await person("owner");
  await step("cli login", async () => {
    const login = Bun.spawn(["bun", CLI, "login"], { env, stdout: "pipe" });
    let verifyUrl = "";
    for (let i = 0; i < 50 && !verifyUrl; i++) {
      await Bun.sleep(100);
      verifyUrl = (await Bun.file(join(dir, "opened")).text().catch(() => "")).trim();
    }
    await owner.goto(verifyUrl);
    await owner.click("text=Approve");
    await login.exited;
    return (await new Response(login.stdout).text()).trim().split("\n").at(-1);
  });

  const local = await owner.context().newPage();
  const token = (await Bun.file(join(dir, "home/local-token")).text()).trim();
  let shareUrl = "";
  await step("share from local ui", async () => {
    await local.goto(`http://127.0.0.1:${DAEMON_PORT}/auth?token=${token}&next=/s/${KEY}`);
    await local.waitForSelector("text=Signed in as");
    await local.click("text=Share…");
    await local.waitForSelector("text=1 item redacted");
    await local.click("text=Create share link");
    await local.waitForSelector(".share-link input");
    shareUrl = await local.inputValue(".share-link input");
    return shareUrl;
  });

  const viewer = await person();
  await step("anonymous viewer sees redacted copy", async () => {
    await viewer.goto(shareUrl);
    await viewer.waitForSelector("text=first message");
    const text = (await viewer.textContent(".transcript")) ?? "";
    if (text.includes("sk-ant") || !text.includes("[REDACTED]")) throw new Error("redaction missing");
  });

  await step("live update reaches viewer", async () => {
    await Bun.sleep(1000); // heartbeat -> live demand -> daemon subscribes
    const started = performance.now();
    await line({ type: "assistant", uuid: `live-${RUN}`, message: { content: [{ type: "text", text: `live hello ${RUN}` }] } });
    await viewer.waitForSelector(`text=live hello ${RUN}`, { timeout: 15_000 });
    return `ok (${Math.round(performance.now() - started)}ms file to viewer)`;
  });

  await step("owner sees viewer count", async () => {
    await local.keyboard.press("Escape");
    await local.waitForSelector(".share-badge:has-text('1 watching')");
  });

  await step("restricting to a user locks out others", async () => {
    await local.click("text=Manage…");
    await local.click("text=Only people I choose");
    await local.fill(".access-fields label:has-text('People') input", "@Friend");
    await local.click("text=Save & resync");
    await local.waitForSelector("text=Saving…", { state: "detached" });
    await local.keyboard.press("Escape");
    await viewer.waitForSelector("text=Sign in to view this session");
    const friend = await person("friend");
    await friend.goto(shareUrl);
    await friend.waitForSelector(`text=live hello ${RUN}`);
    const stranger = await person("stranger");
    await stranger.goto(shareUrl);
    await stranger.waitForSelector("text=You don't have access");
  });

  await step("live sync off holds updates until re-enabled", async () => {
    await local.uncheck("text=Live sync shared sessions");
    const friend = await person("friend");
    await friend.goto(shareUrl);
    await friend.waitForSelector(`text=live hello ${RUN}`);
    await line({ type: "assistant", uuid: `held-${RUN}`, message: { content: [{ type: "text", text: `held ${RUN}` }] } });
    await Bun.sleep(3000);
    if (await friend.locator(`text=held ${RUN}`).count()) throw new Error("streamed while live sync was off");
    await local.check("text=Live sync shared sessions");
    await friend.waitForSelector(`text=held ${RUN}`, { timeout: 15_000 });
  });

  await step("unsharing deletes the server copy", async () => {
    local.on("dialog", (d) => d.accept());
    await local.click("text=Manage…");
    await local.click("text=Stop sharing");
    await viewer.goto(shareUrl);
    await viewer.waitForSelector("text=This share doesn't exist");
  });

  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await Bun.spawn(["bun", CLI, "stop"], { env, stdout: "ignore" }).exited;
  for (const p of spawned) p.kill();
  await rm(dir, { recursive: true, force: true });
}

for (const [name, result] of Object.entries(results)) console.log(`${result.startsWith("FAIL") ? "✗" : "✓"} ${name}: ${result}`);
// The isolated Convex backend keeps running for further development; stop it with:
//   pkill -f "convex-local-backend.*opticon-dev"
process.exit(failed ? 1 : 0);

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
