import type { RedactionFinding, SessionEvent, SessionMeta, SharedEvent } from "@opticon/core";
import { useEffect, useRef, useState } from "react";

export type Status = "loading" | "ready" | "unauthorized" | "offline" | "missing";

export const sessionKey = (m: Pick<SessionMeta, "provider" | "id">) => `${m.provider}/${m.id}`;

type ListMessage =
  | { type: "list"; sessions: SessionMeta[] }
  | { type: "change"; upserted: SessionMeta[]; removed: string[] };

/** Live list of local sessions, newest first. */
export function useSessionList() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    return subscribe<ListMessage>("/api/sessions/stream", "/api/sessions", setStatus, (message) => {
      if (message.type === "list") return setSessions(message.sessions);
      setSessions((current) => {
        const byKey = new Map(current.map((s) => [sessionKey(s), s]));
        for (const s of message.upserted) byKey.set(sessionKey(s), s);
        for (const key of message.removed) byKey.delete(key);
        return [...byKey.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      });
    });
  }, []);

  return { sessions, status };
}

type SessionMessage = { type: "snapshot" | "reset" | "events"; meta: SessionMeta; events: SessionEvent[] };

/** One session's events, kept live. Updates replace events by id in place. */
export function useSession(key: string | undefined) {
  const events = useRef(new Map<string, SessionEvent>());
  const [state, setState] = useState<{ meta?: SessionMeta; events: SessionEvent[]; status: Status }>({
    events: [],
    status: "loading",
  });

  useEffect(() => {
    events.current = new Map();
    setState({ events: [], status: "loading" });
    if (!key) return;
    return subscribe<SessionMessage>(
      `/api/sessions/${key}/stream`,
      `/api/sessions/${key}/meta`,
      (status) => setState((s) => ({ ...s, status })),
      (message) => {
        if (message.type !== "events") events.current = new Map();
        for (const e of message.events) events.current.set(e.id, e);
        setState({ meta: message.meta, events: [...events.current.values()], status: "ready" });
      },
    );
  }, [key]);

  return state;
}

export interface SharePreview {
  meta: SessionMeta;
  events: SharedEvent[];
  findings: RedactionFinding[];
}

export async function fetchSharePreview(key: string): Promise<SharePreview> {
  const res = await fetch(`/api/sessions/${key}/share-preview`);
  if (!res.ok) throw new Error(`Preview failed (${res.status})`);
  return res.json();
}

/**
 * EventSource with status reporting. EventSource reconnects on its own but can't tell a dead
 * daemon from a missing cookie, so on error we probe with a plain fetch.
 */
function subscribe<T>(url: string, probeUrl: string, onStatus: (s: Status) => void, onMessage: (m: T) => void): () => void {
  const source = new EventSource(url);
  source.onopen = () => onStatus("ready");
  source.onmessage = (e) => onMessage(JSON.parse(e.data));
  source.onerror = async () => {
    const res = await fetch(probeUrl).catch(() => undefined);
    if (!res) onStatus("offline");
    else if (res.status === 401) {
      source.close();
      onStatus("unauthorized");
    } else if (res.status === 404) {
      source.close();
      onStatus("missing");
    }
  };
  return () => source.close();
}
