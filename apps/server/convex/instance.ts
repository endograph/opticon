import { PRIVATE_ACCESS, SHARE_GRANTS, type ShareAccess, type ShareGrant, grantsOf } from "@opticon/core/protocol";
import { ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { githubUrl } from "./github";

/**
 * Instance-wide limits, from the deployment's environment. They only ever narrow what a share's
 * own access allows; they never change what a setting means.
 *
 *   OPTICON_ALLOWED_ORGS=acme,beta    only members of these GitHub orgs can sign in (default: anyone)
 *   OPTICON_ANONYMOUS=0               signed-out visitors can't open anything (default: they can)
 *   OPTICON_SHARE_GRANTS=repo,people  which grants shares may use: link, people, repo (default: all)
 */
export interface InstancePolicy {
  allowedOrgs: string[];
  anonymous: boolean;
  grants: ShareGrant[];
}

export function instancePolicy(): InstancePolicy {
  const list = (name: string) =>
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const grants = process.env.OPTICON_SHARE_GRANTS === undefined
    ? [...SHARE_GRANTS]
    : SHARE_GRANTS.filter((g) => list("OPTICON_SHARE_GRANTS").includes(g));
  return { allowedOrgs: list("OPTICON_ALLOWED_ORGS"), anonymous: process.env.OPTICON_ANONYMOUS !== "0", grants };
}

/** `access` with the grants this instance doesn't allow switched off. Applied on every read. */
export function allowedAccess(access: ShareAccess, policy: InstancePolicy): ShareAccess {
  const allows = (g: ShareGrant) => policy.grants.includes(g);
  return {
    link: access.link && allows("link"),
    users: allows("people") ? access.users : [],
    orgs: allows("people") ? access.orgs : [],
    teams: allows("people") ? access.teams : [],
    repo: access.repo && allows("repo"),
  };
}

/** Rejects access that uses a grant this instance doesn't allow, so owners aren't misled. */
export function requireAllowedAccess(access: ShareAccess, policy: InstancePolicy): void {
  const refused = grantsOf(access).filter((g) => !policy.grants.includes(g));
  if (refused.length) throw new ConvexError({ code: "grant_not_allowed", grants: refused });
}

/** Where new shares and autosync rules start: the link if allowed, else the repo, else private. */
export function defaultAccess(policy: InstancePolicy): ShareAccess {
  if (policy.grants.includes("link")) return { ...PRIVATE_ACCESS, link: true };
  if (policy.grants.includes("repo")) return { ...PRIVATE_ACCESS, repo: true };
  return PRIVATE_ACCESS;
}

/** For clients: which options to offer and how to explain them, and where GitHub is. */
export const policy = query({
  args: {},
  handler: async () => {
    const policy = instancePolicy();
    return { ...policy, defaultAccess: defaultAccess(policy), githubUrl: githubUrl() };
  },
});
