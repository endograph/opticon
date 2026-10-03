import { MAX_SHARED_TEXT, type SharedEvent } from "./protocol";
import { basename } from "node:path";
import { type RedactionFinding, redact } from "./redact";
import { truncate } from "./text";
import type { SessionEvent, SessionMeta } from "./types";

/**
 * Builds the shared copy of a session on the daemon. Thinking, tool inputs and outputs, and
 * local summaries are dropped here, so they never leave the machine.
 */
export interface ShareProjection {
  events: SharedEvent[];
  findings: RedactionFinding[];
}

export interface SharedMetadata {
  title?: string;
  project?: string;
}

export interface SharedSessionProjection extends ShareProjection {
  meta: SharedMetadata;
}

/** One upload/preview boundary, including all human-readable metadata. */
export function projectSessionForShare(session: {
  meta: Pick<SessionMeta, "title" | "cwd">;
  events: Iterable<SessionEvent>;
}): SharedSessionProjection {
  const projection = projectForShare(session.events);
  const totals = new Map(projection.findings.map((f) => [f.rule, f.count]));
  const clean = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const result = redact(value);
    for (const f of result.findings) totals.set(f.rule, (totals.get(f.rule) ?? 0) + f.count);
    return truncate(result.text, MAX_SHARED_TEXT);
  };
  return {
    meta: {
      title: clean(session.meta.title),
      project: clean(session.meta.cwd ? basename(session.meta.cwd) : undefined),
    },
    events: projection.events,
    findings: [...totals].map(([rule, count]) => ({ rule, count })),
  };
}

export function projectForShare(events: Iterable<SessionEvent>): ShareProjection {
  const out: SharedEvent[] = [];
  const totals = new Map<string, number>();
  for (const event of events) {
    const shared = toShared(event);
    if (!shared) continue;
    const { text, findings } = redact(shared.kind === "tool" ? shared.name : shared.text);
    if (shared.kind === "tool") shared.name = truncate(text, MAX_SHARED_TEXT);
    else shared.text = truncate(text, MAX_SHARED_TEXT);
    for (const f of findings) totals.set(f.rule, (totals.get(f.rule) ?? 0) + f.count);
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
      // Names are displayed, but must go through the same scrubber as messages.
      return { kind: "tool", id, timestamp, category: event.category, name: event.name, status: event.status };
    }
    case "notice":
      return { kind: "notice", id, timestamp, level: event.level, text: event.text };
    case "thinking":
      return undefined;
  }
}
