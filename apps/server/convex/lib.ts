import { PROTOCOL_VERSION, type ShareAccess } from "@opticon/core/protocol";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

export const MEMBERSHIP_TTL_MS = 10 * 60_000;
export const PRESENCE_TTL_MS = 45_000;

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Only call from actions: queries and mutations get deterministic randomness. */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function userForToken(ctx: QueryCtx, token: string | undefined): Promise<Doc<"users"> | null> {
  if (!token) return null;
  const hash = await sha256(token);
  const found = await ctx.db
    .query("tokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
  if (!found || (found.expiresAt && found.expiresAt < Date.now())) return null;
  return ctx.db.get(found.userId);
}

export async function requireUser(ctx: QueryCtx, token: string | undefined): Promise<Doc<"users">> {
  const user = await userForToken(ctx, token);
  if (!user) throw new ConvexError({ code: "unauthenticated" });
  return user;
}

export function requireProtocol(protocol: number): void {
  if (protocol !== PROTOCOL_VERSION) {
    throw new ConvexError({ code: "protocol_mismatch", expected: PROTOCOL_VERSION, message: "Run `opticon update`." });
  }
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; reason: "login_required" }
  /** `stale` means membership may have changed since it was last checked; refresh and retry. */
  | { ok: false; reason: "forbidden"; stale: boolean };

/** Pure access check against the viewer's cached GitHub membership. */
export function decideAccess(access: ShareAccess, ownerId: string, viewer: Doc<"users"> | null, now = Date.now()): AccessDecision {
  if (access.anyone) return { ok: true };
  if (!viewer) return { ok: false, reason: "login_required" };
  if (viewer._id === ownerId || access.users.includes(viewer.login)) return { ok: true };
  const needsMembership = access.orgs.length > 0 || access.teams.length > 0;
  const orgs = viewer.orgs ?? [];
  const teams = viewer.teams ?? [];
  if (access.orgs.some((o) => orgs.includes(o)) || access.teams.some((t) => teams.includes(t))) return { ok: true };
  const stale = needsMembership && (!viewer.membershipCheckedAt || now - viewer.membershipCheckedAt > MEMBERSHIP_TTL_MS);
  return { ok: false, reason: "forbidden", stale };
}
