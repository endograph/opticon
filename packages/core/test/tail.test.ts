import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTail } from "../src/tail";

let dir: string;
afterEach(() => rm(dir, { recursive: true, force: true }));

const line = (uuid: string, text: string) =>
  `${JSON.stringify({ type: "user", uuid, message: { content: text } })}\n`;

test("holds partial lines, upserts by id, and restarts on truncation", async () => {
  dir = await mkdtemp(join(tmpdir(), "opticon-"));
  const path = join(dir, "s.jsonl");
  const first = line("u1", "héllo");
  // Split mid-way through a multibyte character.
  const cut = Buffer.from(first).indexOf(0xa9);
  await writeFile(path, Buffer.from(first).subarray(0, cut));
  const tail = new SessionTail("claude", path);

  expect((await tail.read()).changed).toEqual([]);
  await appendFile(path, Buffer.from(first).subarray(cut));
  expect((await tail.read()).changed.map((e) => e.kind === "message" && e.text)).toEqual(["héllo"]);

  await appendFile(path, line("u2", "second"));
  expect((await tail.read()).changed.map((e) => e.id)).toEqual(["u2"]);
  expect((await tail.read()).changed).toEqual([]);

  await writeFile(path, line("u9", "new"));
  const after = await tail.read();
  expect(after.reset).toBe(true);
  expect([...tail.events.keys()]).toEqual(["u9"]);
});
