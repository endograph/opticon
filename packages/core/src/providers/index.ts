import type { Provider, SessionParser } from "../types";
import { createClaudeParser } from "./claude";
import { createCodexParser } from "./codex";

export function createParser(provider: Provider, path: string, title?: string): SessionParser {
  return provider === "claude" ? createClaudeParser(path) : createCodexParser(path, title);
}
