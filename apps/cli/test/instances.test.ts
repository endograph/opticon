import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/main.ts");
const DEFAULT_CONVEX = "https://bold-ostrich-850.convex.cloud";
let home: string;
let server: ReturnType<typeof Bun.serve>;

/** A stand-in self-hosted instance: just the /config.json its web app serves. */
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "opticon-instances-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/config.json": () => Response.json({ mode: "hosted", convexUrl: "https://acme.convex.cloud", siteUrl: "https://acme.convex.site" }),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
});

afterAll(async () => {
  await server.stop(true);
  await rm(home, { recursive: true, force: true });
});

/** Runs the CLI in its own process, so OPTICON_HOME applies from the start. */
async function opticon(...args: string[]): Promise<{ out: string; code: number }> {
  const env: Record<string, string | undefined> = { ...process.env, OPTICON_HOME: home };
  for (const name of ["OPTICON_DEV", "OPTICON_CONVEX_URL", "OPTICON_CONVEX_SITE_URL", "OPTICON_WEB_URL"]) delete env[name];
  const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out + err, code };
}

test("instances are added by URL, selected by name, keep their own sign-ins and rules, and can be removed", async () => {
  // A sign-in and a rule from before instances belong to opticon.tv.
  await Bun.write(join(home, "auth.json"), JSON.stringify({ token: "t1", login: "owner", convexUrl: DEFAULT_CONVEX }));
  await Bun.write(join(home, "autosync.json"), JSON.stringify({ rules: [{ path: "/work/old", sync: true, since: "2026-01-01" }] }));
  expect((await opticon("instance")).out).toMatch(/^\* opticon\.tv\s+owner$/m);

  const acme = `127.0.0.1:${server.port}`;
  const added = await opticon("instance", `http://${acme}`);
  expect(added.out).toContain(`Added and selected ${acme}`);
  expect(added.out).toContain("Not signed in there yet");
  const list = (await opticon("instance")).out;
  expect(list).toMatch(/^ {2}opticon\.tv\s+owner$/m);
  expect(list).toMatch(new RegExp(`^\\* ${acme.replace(".", "\\.")}\\s+\\(not signed in\\)$`, "m"));
  expect((await opticon("autosync", "list")).out).toContain(`No autosynced projects on ${acme}`);

  expect((await opticon("instance", "opticon.tv")).out).toContain("Selected opticon.tv");
  expect((await opticon("autosync", "list")).out).toContain("/work/old");

  const missing = await opticon("instance", "http://127.0.0.1:1");
  expect(missing.code).not.toBe(0);
  expect(missing.out).toContain("doesn't look like an Opticon instance");

  expect((await opticon("instance", "remove", acme)).out).toContain(`Removed ${acme}. Using opticon.tv.`);
  expect((await opticon("instance", "remove", "opticon.tv")).out).toContain("can't be removed");
  expect((await opticon("instance")).out.trim()).toMatch(/^\* opticon\.tv\s+owner$/);
});
