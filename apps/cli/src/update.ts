import { createHash } from "node:crypto";
import { chmod, rename, rm } from "node:fs/promises";
import { VERSION, ensureDaemon, healthyDaemon, stopDaemon } from "./daemon/lifecycle";

const REPO = "endograph/opticon";

/** Replaces the running binary with the latest (or requested) GitHub release. */
export async function update(requested?: string): Promise<void> {
  if (VERSION === "dev") throw new Error("Running from source; update with git instead.");
  const version = requested?.replace(/^v/, "") ?? (await latestVersion());
  if (version === VERSION) {
    console.log(`opticon ${VERSION} is up to date.`);
    return;
  }

  const asset = assetName();
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  console.log(`Updating opticon ${VERSION} -> ${version}...`);
  const [binary, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/SHA256SUMS`)]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected) throw new Error(`No checksum for ${asset} in release v${version}.`);
  if (createHash("sha256").update(binary).digest("hex") !== expected) throw new Error(`Checksum mismatch for ${asset}.`);

  // Write next to the current binary, then rename over it so the swap is atomic.
  const target = process.execPath;
  const temp = `${target}.update-${process.pid}`;
  try {
    await Bun.write(temp, binary);
    await chmod(temp, 0o755);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    if ((error as { code?: string }).code === "EACCES") throw new Error(`No permission to write ${target}.`);
    throw error;
  }
  console.log(`Updated to opticon ${version}.`);

  // A running daemon is still the old build; restart it from the new binary.
  if (await healthyDaemon()) {
    await stopDaemon();
    await ensureDaemon();
    console.log("Restarted the daemon.");
  }
}

/** Reads the latest release tag from GitHub's redirect, avoiding the rate-limited API. */
async function latestVersion(): Promise<string> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" });
  const tag = res.headers.get("location")?.match(/\/releases\/tag\/v?([^/]+)$/)?.[1];
  if (!tag) throw new Error(`Couldn't find the latest release (HTTP ${res.status}).`);
  return tag;
}

function assetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!os || !arch) throw new Error(`No release build for ${process.platform}-${process.arch}.`);
  return `opticon-${os}-${arch}`;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
