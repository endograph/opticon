import type { ToolCategory, ToolStatus } from "./protocol";

export type { ToolCategory, ToolStatus } from "./protocol";

export type Provider = "claude" | "codex";

export interface SessionMeta {
  provider: Provider;
  /** Provider-native session id (Claude session uuid, Codex thread id). */
  id: string;
  path: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
}

interface EventBase {
  /** Stable within a session. A later event with the same id replaces the earlier one. */
  id: string;
  timestamp?: string;
}

export interface MessageEvent extends EventBase {
  kind: "message";
  role: "user" | "assistant";
  text: string;
}

export interface ThinkingEvent extends EventBase {
  kind: "thinking";
  text: string;
}

export interface ToolEvent extends EventBase {
  kind: "tool";
  category: ToolCategory;
  /** Display name, e.g. "Bash", "github/create_issue", "skill:pdf". */
  name: string;
  status: ToolStatus;
  /** Short local-only description of the call (command, path, query). Never shared. */
  summary?: string;
  /** Local-only raw input/output. Never shared. */
  input?: unknown;
  output?: string;
}

export interface NoticeEvent extends EventBase {
  kind: "notice";
  level: "info" | "error";
  text: string;
}

export type SessionEvent = MessageEvent | ThinkingEvent | ToolEvent | NoticeEvent;

/** Incremental line parser for one session file. Fed complete JSONL lines in order. */
export interface SessionParser {
  readonly meta: SessionMeta;
  /** Returns events created or updated by this line. */
  push(line: string): SessionEvent[];
}
