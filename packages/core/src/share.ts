import { type RedactionFinding, redact } from "./redact";
import type { SessionEvent, ToolCategory, ToolStatus } from "./types";

/**
 * What a shared session contains. Built on the daemon so that anything not listed here
 * (thinking, tool inputs and outputs, local summaries) never leaves the machine.
 */
export type SharedEvent =
  | { kind: "message"; id: string; timestamp?: string; role: "user" | "assistant"; text: string }
  | { kind: "tool"; id: string; timestamp?: string; category: ToolCategory; name: string; status: ToolStatus }
  | { kind: "notice"; id: string; timestamp?: string; level: "info" | "error"; text: string };

export interface ShareProjection {
  events: SharedEvent[];
  findings: RedactionFinding[];
}

export function projectForShare(events: Iterable<SessionEvent>): ShareProjection {
  const out: SharedEvent[] = [];
  const totals = new Map<string, number>();
  for (const event of events) {
    const shared = toShared(event);
    if (!shared) continue;
    if (shared.kind !== "tool") {
      const { text, findings } = redact(shared.text);
      shared.text = text;
      for (const f of findings) totals.set(f.rule, (totals.get(f.rule) ?? 0) + f.count);
    }
    out.push(shared);
  }
  return { events: out, findings: [...totals].map(([rule, count]) => ({ rule, count })) };
}

function toShared(event: SessionEvent): SharedEvent | undefined {
  const { id, timestamp } = event;
  switch (event.kind) {
    case "message":
      return { kind: "message", id, timestamp, role: event.role, text: event.text };
    case "tool": {
      // MCP and plugin tool names can embed server names; keep them, they're what the chip shows.
      return { kind: "tool", id, timestamp, category: event.category, name: event.name, status: event.status };
    }
    case "notice":
      return { kind: "notice", id, timestamp, level: event.level, text: event.text };
    case "thinking":
      return undefined;
  }
}
