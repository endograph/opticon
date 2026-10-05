import { api } from "@opticon/server/api";
import { useAction } from "convex/react";
import { useEffect } from "react";

/** GitHub answers the server wants refreshed before (or while) deciding what the viewer can open. */
export interface Stale {
  /** Orgs, and teams as `org/team`. */
  groups: string[];
  repos: string[];
}

/**
 * Asks the server to re-check the viewer's GitHub org, team, and repo access when a query
 * reports `stale`. The query then updates by itself. Each distinct request is made once.
 */
export function useAccessRefresh(token: string | undefined, stale: Stale | undefined): void {
  const refresh = useAction(api.access.refresh);
  const needed = !!token && !!stale && (stale.groups.length > 0 || stale.repos.length > 0);
  const key = needed ? JSON.stringify({ groups: [...stale!.groups].sort(), repos: [...stale!.repos].sort() }) : undefined;
  useEffect(() => {
    if (token && key) void refresh({ token, ...(JSON.parse(key) as Stale) }).catch(() => {});
  }, [token, key, refresh]);
}
