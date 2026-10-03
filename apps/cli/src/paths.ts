import { homedir } from "node:os";
import { join } from "node:path";

export const OPTICON_HOME = process.env.OPTICON_HOME ?? join(homedir(), ".opticon");
export const DAEMON_FILE = join(OPTICON_HOME, "daemon.json");
export const TOKEN_FILE = join(OPTICON_HOME, "local-token");
export const INDEX_FILE = join(OPTICON_HOME, "index.json");
export const LOG_FILE = join(OPTICON_HOME, "daemon.log");
export const DEFAULT_PORT = Number(process.env.OPTICON_PORT ?? 4317);

/** argv prefix that re-invokes this CLI, whether running from source or as a compiled binary. */
export function selfCommand(): string[] {
  const script = process.argv[1];
  return script && !script.startsWith("/$bunfs/") ? [process.execPath, script] : [process.execPath];
}
