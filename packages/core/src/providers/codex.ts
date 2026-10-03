import { firstLine, parseJson, truncate } from "../text";
import type { SessionEvent, SessionMeta, SessionParser, ToolEvent, ToolStatus } from "../types";

const MAX_OUTPUT = 20_000;

/**
 * Parses a Codex rollout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl.
 * Reads only `event_msg:item_completed` items, Codex's normalized view of the thread.
 * The raw `response_item` records duplicate them and include injected context, so they're ignored.
 */
export function createCodexParser(path: string, title?: string): SessionParser {
  const id = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? path;
  const meta: SessionMeta = { provider: "codex", id, path, title };

  function push(line: string): SessionEvent[] {
    const record = parseJson(line);
    if (!record) return [];
    const timestamp: string | undefined = record.timestamp;
    if (timestamp) {
      meta.startedAt ??= timestamp;
      meta.updatedAt = timestamp;
    }
    const payload = record.payload ?? {};

    if (record.type === "session_meta") {
      meta.id = payload.id ?? meta.id;
      meta.cwd = payload.cwd;
      meta.gitBranch = payload.git?.branch;
      return [];
    }
    if (record.type !== "event_msg") return [];
    if (payload.type === "turn_aborted") {
      const text = payload.reason === "interrupted" ? "Interrupted by user" : `Turn aborted (${payload.reason})`;
      return [{ kind: "notice", id: `abort:${payload.turn_id}`, timestamp, level: "info", text }];
    }
    if (payload.type !== "item_completed" || !payload.item) return [];
    const event = itemEvent(payload.item, timestamp);
    if (event?.kind === "message" && event.role === "user" && !meta.title) meta.title = firstLine(event.text);
    return event ? [event] : [];
  }

  return { meta, push };
}

function itemEvent(item: Record<string, any>, timestamp?: string): SessionEvent | undefined {
  const id: string = item.id;
  switch (item.type) {
    case "UserMessage": {
      const text = joinContent(item.content);
      return text ? { kind: "message", id, timestamp, role: "user", text } : undefined;
    }
    case "AgentMessage": {
      const text = joinContent(item.content);
      return text ? { kind: "message", id, timestamp, role: "assistant", text } : undefined;
    }
    case "Reasoning": {
      const text = (item.summary_text ?? []).join("\n\n").trim();
      return text ? { kind: "thinking", id, timestamp, text } : undefined;
    }
    case "ContextCompaction":
      return { kind: "notice", id, timestamp, level: "info", text: "Context compacted" };
    case "CommandExecution": {
      const command = Array.isArray(item.command) ? item.command.at(-1) : item.command;
      return tool(id, timestamp, {
        category: "tool",
        name: "shell",
        status: statusOf(item.status),
        summary: firstLine(String(command ?? "")),
        input: item.command,
        output: item.aggregated_output ?? item.stdout,
      });
    }
    case "FileChange": {
      const paths = Object.keys(item.changes ?? {});
      return tool(id, timestamp, {
        category: "tool",
        name: "edit",
        status: statusOf(item.status),
        summary: paths.length === 1 ? paths[0] : `${paths.length} files`,
        input: item.changes,
      });
    }
    case "McpToolCall":
      return tool(id, timestamp, {
        category: item.pluginId ? "plugin" : "mcp",
        name: `${item.server}/${item.tool}`,
        status: item.result?.isError ? "error" : statusOf(item.status),
        input: item.arguments,
        output: joinContent(item.result?.content),
      });
    case "DynamicToolCall":
      return tool(id, timestamp, {
        category: "tool",
        name: item.tool,
        status: item.success === false ? "error" : statusOf(item.status),
        input: item.arguments,
        output: joinContent(item.content_items),
      });
    case "Extension":
      return tool(id, timestamp, { category: "tool", name: item.kind ?? "extension", status: "ok", summary: item.query });
    case "ImageView":
      return tool(id, timestamp, { category: "tool", name: "view_image", status: "ok", summary: item.path });
    case "CollabAgentToolCall":
      return tool(id, timestamp, { category: "subagent", name: `agent:${item.tool}`, status: statusOf(item.status) });
    default:
      return undefined;
  }
}

function tool(id: string, timestamp: string | undefined, fields: Omit<ToolEvent, "kind" | "id" | "timestamp">): ToolEvent {
  return { kind: "tool", id, timestamp, ...fields, output: fields.output && truncate(fields.output, MAX_OUTPUT) };
}

function statusOf(status: unknown): ToolStatus {
  if (status === "failed" || status === "declined") return "error";
  if (status === "in_progress") return "running";
  return "ok";
}

function joinContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Record<string, any>) => part.text ?? "")
    .join("")
    .trim();
}
