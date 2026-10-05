import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../src/files";

test("concurrent read-modify-writes under the lock keep every change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opticon-files-"));
  const path = join(dir, "auth.json");
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withFileLock(path, async () => {
          const data = (await Bun.file(path).json().catch(() => ({}))) as Record<string, number>;
          await Bun.sleep(1);
          await writeFileAtomic(path, JSON.stringify({ ...data, [`server-${i}`]: i }), 0o600);
        }),
      ),
    );
    expect(Object.keys(await Bun.file(path).json())).toHaveLength(20);
    expect(await readdir(dir)).toEqual(["auth.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
