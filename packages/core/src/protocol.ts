/**
 * The daemon <-> server <-> viewer contract. Dependency-free so the Convex runtime can import it.
 *
 * Bump PROTOCOL_VERSION on any incompatible change. Mismatches are rejected, never negotiated.
 */
export const PROTOCOL_VERSION = 1;

/** Longest text a shared event may carry; longer text is cut on the daemon. */
export const MAX_SHARED_TEXT = 100_000;

export type ToolCategory = "tool" | "mcp" | "skill" | "plugin" | "subagent";
export type ToolStatus = "running" | "ok" | "error";

/** What a shared session contains. Anything not representable here never leaves the machine. */
export type SharedEvent =
  | { kind: "message"; id: string; timestamp?: string; role: "user" | "assistant"; text: string }
  | { kind: "tool"; id: string; timestamp?: string; category: ToolCategory; name: string; status: ToolStatus }
  | { kind: "notice"; id: string; timestamp?: string; level: "info" | "error"; text: string };

/** Who can open a share. The owner always can. Logins, orgs, and teams are lowercase GitHub slugs. */
export interface ShareAccess {
  /** Anyone with the link, signed in or not. */
  anyone: boolean;
  users: string[];
  orgs: string[];
  /** `org/team-slug` */
  teams: string[];
}

export const PRIVATE_ACCESS: ShareAccess = { anyone: false, users: [], orgs: [], teams: [] };
export const LINK_ACCESS: ShareAccess = { anyone: true, users: [], orgs: [], teams: [] };

/** Normalizes user input like "@Octocat", "Acme", "acme/Platform" into canonical slugs. */
export function normalizeAccess(access: ShareAccess): ShareAccess {
  const clean = (values: string[]) =>
    [...new Set(values.map((v) => v.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))].sort();
  return {
    anyone: access.anyone,
    users: clean(access.users),
    orgs: clean(access.orgs),
    teams: clean(access.teams).filter((t) => /^[^/]+\/[^/]+$/.test(t)),
  };
}
