import { MAX_SHARED_TEXT, type SharedEvent } from "./protocol";
import { type RedactionFinding, redact } from "./redact";
import { truncate } from "./text";
import type { SessionEvent } from "./types";

/**
 * Builds the shared copy of a session on the daemon. Thinking, tool inputs and outputs, and
 * local summaries are dropped here, so they never leave the machine.
 */
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
      shared.text = truncate(text, MAX_SHARED_TEXT);
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
