import { basename } from "node:path";
import { firstLine, parseJson, stripInjected, truncate } from "../text";
import type { SessionEvent, SessionMeta, SessionParser, ToolCategory, ToolEvent } from "../types";

const MAX_OUTPUT = 20_000;

/**
 * Parses a Claude Code transcript: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl.
 * Assistant turns are written one content block per record; tool results arrive as later user records.
 */
export function createClaudeParser(path: string): SessionParser {
  const meta: SessionMeta = { provider: "claude", id: basename(path, ".jsonl"), path };
  const tools = new Map<string, ToolEvent>();
  let fallbackTitle: string | undefined;
  let aiTitle: string | undefined;

  function push(line: string): SessionEvent[] {
    const record = parseJson(line);
    if (!record) return [];
    const timestamp: string | undefined = record.timestamp;
    if (timestamp) {
      meta.startedAt ??= timestamp;
      meta.updatedAt = timestamp;
    }
    meta.cwd ??= record.cwd;
    if (record.gitBranch && record.gitBranch !== "HEAD") meta.gitBranch = record.gitBranch;

    switch (record.type) {
      case "ai-title":
        aiTitle = record.aiTitle;
        meta.title = aiTitle;
        return [];
      case "summary":
        meta.title = aiTitle ?? record.summary;
        return [];
      case "system":
        return systemEvents(record, timestamp);
      case "assistant":
        return assistantEvents(record, timestamp);
      case "user":
        return userEvents(record, timestamp);
      default:
        return [];
    }
  }

  function assistantEvents(record: Record<string, any>, timestamp?: string): SessionEvent[] {
    const blocks = record.message?.content;
    if (!Array.isArray(blocks)) return [];
    const events: SessionEvent[] = [];
    blocks.forEach((block: Record<string, any>, i: number) => {
      const id = `${record.uuid}:${i}`;
      if (block.type === "text" && block.text?.trim()) {
        events.push({ kind: "message", id, timestamp, role: "assistant", text: block.text });
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        events.push({ kind: "thinking", id, timestamp, text: block.thinking });
      } else if (block.type === "tool_use") {
        const tool: ToolEvent = {
          kind: "tool",
          id: block.id,
          timestamp,
          status: "running",
          input: block.input,
          ...describeTool(block.name, block.input ?? {}),
        };
        tools.set(tool.id, tool);
        events.push(tool);
      }
    });
    return events;
  }

  function userEvents(record: Record<string, any>, timestamp?: string): SessionEvent[] {
    if (record.isMeta) return [];
    if (record.isCompactSummary) {
      return [{ kind: "notice", id: record.uuid, timestamp, level: "info", text: "Context compacted" }];
    }
    const content = record.message?.content;
    const blocks: Record<string, any>[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
    const events: SessionEvent[] = [];
    const texts: string[] = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        const done: ToolEvent = {
          ...tool,
          status: block.is_error ? "error" : "ok",
          output: truncate(resultText(block.content), MAX_OUTPUT),
        };
        tools.delete(tool.id);
        events.push(done);
      } else if (block.type === "text") {
        texts.push(block.text ?? "");
      } else if (block.type === "image") {
        texts.push("[image]");
      }
    }
    const text = userText(texts.join("\n"));
    if (text === INTERRUPTED) {
      events.push({ kind: "notice", id: record.uuid, timestamp, level: "info", text: "Interrupted by user" });
    } else if (text) {
      fallbackTitle ??= firstLine(text);
      meta.title ??= fallbackTitle;
      events.push({ kind: "message", id: record.uuid, timestamp, role: "user", text });
    }
    return events;
  }

  return { meta, push };
}

const INTERRUPTED = Symbol("interrupted");

/** Normalizes a user text record: drops harness noise, renders slash commands, flags interrupts. */
function userText(raw: string): string | typeof INTERRUPTED | undefined {
  if (raw.startsWith("[Request interrupted")) return INTERRUPTED;
  if (raw.trimStart().startsWith("<task-notification>")) return undefined;
  const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return [command[1], args].filter(Boolean).join(" ");
  }
  return stripInjected(raw) || undefined;
}

function systemEvents(record: Record<string, any>, timestamp?: string): SessionEvent[] {
  if (record.subtype === "api_error") {
    const text = record.error?.formatted ?? record.error?.message ?? "API error";
    return [{ kind: "notice", id: record.uuid, timestamp, level: "error", text }];
  }
  if (record.subtype === "compact_boundary") {
    return [{ kind: "notice", id: record.uuid, timestamp, level: "info", text: "Context compacted" }];
  }
  return [];
}

function describeTool(name: string, input: Record<string, any>): Pick<ToolEvent, "category" | "name" | "summary"> {
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    const tool = rest.join("__");
    if (server.startsWith("plugin_")) return { category: "plugin", name: `${server.slice(7)}/${tool}` };
    return { category: "mcp", name: `${server}/${tool}` };
  }
  if (name === "Skill") {
    const skill = String(input.skill ?? "unknown");
    return { category: skill.includes(":") ? "plugin" : "skill", name: `skill:${skill}`, summary: input.args };
  }
  if (name === "Agent" || name === "Task") {
    return { category: "subagent", name: `agent:${input.subagent_type ?? "general"}`, summary: input.description };
  }
  const summary = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return { category: "tool", name, summary: typeof summary === "string" ? firstLine(summary) : undefined };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Record<string, any>) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}
