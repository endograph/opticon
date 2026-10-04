import type { SessionEvent, SessionMeta, ShareAccess, SharedSessionProjection } from "@opticon/core";
import { useEffect, useRef, useState } from "react";

export type Status = "loading" | "ready" | "unauthorized" | "offline" | "missing";

export const sessionKey = (m: Pick<SessionMeta, "provider" | "id">) => `${m.provider}/${m.id}`;

export interface Account {
  configured: boolean;
  signedIn: boolean;
  login?: string;
  liveSync: boolean;
  webUrl?: string;
  error?: string;
}

export interface MyShare {
  shareId: string;
  slug: string;
  url: string;
  provider: SessionMeta["provider"];
  sessionId: string;
  title?: string;
  project?: string;
  /** Verified public GitHub repo, `owner/name`. */
  repo?: string;
  access: ShareAccess;
  /** Created by autosync. */
  auto: boolean;
  /** Listed on the owner's profile and the public feed. */
  discoverable: boolean;
  eventCount: number;
  viewers: number;
}

/** The autosync rule covering a session, and what a new rule would match. */
export interface AutosyncState {
  rule: { repo?: string; path?: string } | null;
  /** A git remote like `github.com/owner/repo`, or a directory. */
  target: string;
}

type ListMessage =
  | { type: "list"; sessions: SessionMeta[] }
  | { type: "change"; upserted: SessionMeta[]; removed: string[] }
  | { type: "shares"; account: Account; shares: MyShare[] };

export interface Daemon {
  sessions: SessionMeta[];
  status: Status;
  account?: Account;
  shares: MyShare[];
}

/** Live list of local sessions (newest first), plus sharing state from the daemon. One per app. */
export function useDaemonState(): Daemon {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [sharing, setSharing] = useState<{ account?: Account; shares: MyShare[] }>({ shares: [] });

  useEffect(() => {
    return subscribe<ListMessage>("/api/sessions/stream", "/api/sessions", setStatus, (message) => {
      if (message.type === "list") return setSessions(message.sessions);
      if (message.type === "shares") return setSharing({ account: message.account, shares: message.shares });
      setSessions((current) => {
        const byKey = new Map(current.map((s) => [sessionKey(s), s]));
        for (const s of message.upserted) byKey.set(sessionKey(s), s);
        for (const key of message.removed) byKey.delete(key);
        return [...byKey.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      });
    });
  }, []);

  return { sessions, status, ...sharing };
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

/** The session's GitHub repo (`owner/name`) from its git remote; null when it has none. */
export function useSessionRepo(key: string | undefined): string | null {
  const [repo, setRepo] = useState<{ key: string; repo: string | null }>();
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetch(`/api/sessions/${key}/repo`)
      .then((res) => (res.ok ? res.json() : { repo: null }))
      .then((data: { repo: string | null }) => !cancelled && setRepo({ key, repo: data.repo }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);
  return repo && repo.key === key ? repo.repo : null;
}

export type SharePreview = SharedSessionProjection;

export async function fetchSharePreview(key: string): Promise<SharePreview> {
  const res = await fetch(`/api/sessions/${key}/share-preview`);
  if (!res.ok) throw new Error(`Preview failed (${res.status})`);
  return res.json();
}

/** `discoverable` lists the share on your profile and the public feed; link shares only. */
export const createShare = (key: string, access: ShareAccess, discoverable: boolean) =>
  send<{ slug: string; url: string }>("POST", `/api/sessions/${key}/share`, { access, discoverable });
/** Deletes the server copy. Auto sync won't re-create it. */
export const deleteShare = (shareId: string) => send("DELETE", `/api/shares/${shareId}`);
/** Makes the share private; the copy stays and keeps syncing. */
export const unshare = (shareId: string) => send("POST", `/api/shares/${shareId}/unshare`);

export async function fetchAutosync(key: string): Promise<AutosyncState> {
  const res = await fetch(`/api/sessions/${key}/autosync`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as AutosyncState;
}
/** Syncs every session in this one's project, public and discoverable. */
export const enableAutosync = (key: string) => send<AutosyncState>("POST", `/api/sessions/${key}/autosync`);
export const disableAutosync = (key: string) => send<AutosyncState>("DELETE", `/api/sessions/${key}/autosync`);

async function send<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-opticon": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
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
