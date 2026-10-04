/**
 * The daemon <-> server <-> viewer contract. Dependency-free so the Convex runtime can import it.
 *
 * Bump PROTOCOL_VERSION on any incompatible change. Mismatches are rejected, never negotiated.
 */
export const PROTOCOL_VERSION = 2;

/** Longest text a shared event may carry; longer text is cut on the daemon. */
export const MAX_SHARED_TEXT = 100_000;

export type ToolCategory = "tool" | "mcp" | "skill" | "plugin" | "subagent";
export type ToolStatus = "running" | "ok" | "error";

/** What a shared session contains. Anything not representable here never leaves the machine. */
export type SharedEvent =
  | { kind: "message"; id: string; timestamp?: string; role: "user" | "assistant"; text: string }
  | { kind: "tool"; id: string; timestamp?: string; category: ToolCategory; name: string; status: ToolStatus }
  | { kind: "notice"; id: string; timestamp?: string; level: "info" | "error"; text: string };

/**
 * Who can open a share, beyond its owner. Grants add up: anyone matching any of them can open it.
 * The instance can narrow this (sign-in limited to some orgs, no signed-out viewers, or some
 * grants switched off), but never changes what a grant means.
 * Logins, orgs, and teams are lowercase GitHub slugs.
 */
export interface ShareAccess {
  /** Anyone with the link. Signed out too, if the instance allows signed-out viewers. */
  link: boolean;
  users: string[];
  orgs: string[];
  /** `org/team-slug` */
  teams: string[];
  /** Anyone GitHub lets read the share's verified repo. Grants nothing until a repo is verified. */
  repo: boolean;
}

/** The kinds of grant an instance can allow. `people` covers users, orgs, and teams. */
export type ShareGrant = "link" | "people" | "repo";
export const SHARE_GRANTS: readonly ShareGrant[] = ["link", "people", "repo"];

export const PRIVATE_ACCESS: ShareAccess = { link: false, users: [], orgs: [], teams: [], repo: false };
export const LINK_ACCESS: ShareAccess = { ...PRIVATE_ACCESS, link: true };

/** Normalizes user input like "@Octocat", "Acme", "acme/Platform" into canonical slugs. */
export function normalizeAccess(access: ShareAccess): ShareAccess {
  const clean = (values: string[]) =>
    [...new Set(values.map((v) => v.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))].sort();
  return {
    link: access.link,
    users: clean(access.users),
    orgs: clean(access.orgs),
    teams: clean(access.teams).filter((t) => /^[^/]+\/[^/]+$/.test(t)),
    repo: access.repo,
  };
}

/** Which grants `access` uses. */
export function grantsOf(access: ShareAccess): ShareGrant[] {
  const people = access.users.length > 0 || access.orgs.length > 0 || access.teams.length > 0;
  return SHARE_GRANTS.filter((g) => (g === "link" ? access.link : g === "repo" ? access.repo : people));
}

/** Only the owner can open it. */
export const isPrivate = (access: ShareAccess) => grantsOf(access).length === 0;

/** "Anyone with the link, people who can read the repo, @octocat, acme/platform", or "Only you". */
export function describeAccess(access: ShareAccess): string {
  const parts = [
    ...(access.link ? ["anyone with the link"] : []),
    ...(access.repo ? ["people who can read the repo"] : []),
    ...access.users.map((u) => `@${u}`),
    ...access.orgs,
    ...access.teams,
  ];
  const text = parts.length ? parts.join(", ") : "only you";
  return text[0]!.toUpperCase() + text.slice(1);
}
