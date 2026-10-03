// Builds release binaries for every supported platform into dist/release, plus SHA256SUMS.
// Usage: bun scripts/build-release.ts <version>   (e.g. 0.1.0, without the leading "v")
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist/release");

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/build-release.ts <version>");
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const sums: string[] = [];
for (const target of TARGETS) {
  const name = `opticon-${target}`;
  const outfile = join(OUT, name);
  const build = Bun.spawnSync(
    [
      "bun", "build", "--compile", "--minify",
      `--target=bun-${target}`,
      "--define", `OPTICON_VERSION=${JSON.stringify(version)}`,
      "apps/cli/src/main.ts", "--outfile", outfile,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  // macOS refuses to run unsigned arm64 binaries; an ad-hoc signature is enough.
  if (target.startsWith("darwin") && process.platform === "darwin") {
    const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", outfile], { stdout: "inherit", stderr: "inherit" });
    if (sign.exitCode !== 0) process.exit(sign.exitCode ?? 1);
  }
  sums.push(`${createHash("sha256").update(await readFile(outfile)).digest("hex")}  ${name}`);
}

await writeFile(join(OUT, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Built opticon ${version}:\n${sums.join("\n")}`);
