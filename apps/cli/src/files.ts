import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;

/**
 * Runs a read-modify-write of `path` while holding `<path>.lock`, so CLI commands and the daemon
 * running at once don't lose each other's changes. The lock is a directory, since creating one
 * is atomic; one older than LOCK_STALE_MS was left by a process that died, and is taken over.
 */
export async function withFileLock<T>(path: string, update: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - ((await stat(lock).catch(() => undefined))?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS || attempt > 200) await rm(lock, { recursive: true, force: true });
      else await Bun.sleep(25);
    }
  }
  try {
    return await update();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Writes `path` whole or not at all, so a reader never sees half a file. */
export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await Bun.write(temp, data, mode === undefined ? undefined : { mode });
  await rename(temp, path);
}
