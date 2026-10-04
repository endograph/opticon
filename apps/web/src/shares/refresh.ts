import { api } from "@opticon/server/api";
import { useAction } from "convex/react";
import { useEffect } from "react";

/** GitHub answers the server wants refreshed before (or while) deciding what the viewer can open. */
export interface Stale {
  memberships: boolean;
  repos: string[];
}

/**
 * Asks the server to re-check the viewer's GitHub membership and repo access when a query
 * reports `stale`. The query then updates by itself. Each distinct request is made once.
 */
export function useAccessRefresh(token: string | undefined, stale: Stale | undefined): void {
  const refresh = useAction(api.access.refresh);
  const needed = !!token && !!stale && (stale.memberships || stale.repos.length > 0);
  const key = needed ? JSON.stringify({ memberships: stale!.memberships, repos: [...stale!.repos].sort() }) : undefined;
  useEffect(() => {
    if (token && key) void refresh({ token, ...(JSON.parse(key) as Stale) }).catch(() => {});
  }, [token, key, refresh]);
}
