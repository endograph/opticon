import { type AnchorHTMLAttributes, useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  /** Sessions on this machine; `key` is `<provider>/<id>`. */
  | { name: "local"; key?: string }
  | { name: "share"; slug: string }
  | { name: "shares" }
  | { name: "following" }
  /** A user's public profile. */
  | { name: "user"; login: string }
  /** One user's public sessions in one project. */
  | { name: "userProject"; login: string; project: string }
  /** Public sessions in a GitHub repo from everyone who can push to it; `repo` is `owner/name`. */
  | { name: "repo"; repo: string }
  | { name: "cli"; code: string }
  | { name: "not_found" };

export function parseRoute(path: string, search: string): Route {
  if (path === "/") return { name: "home" };
  if (path === "/local") return { name: "local" };
  const local = path.match(/^\/local\/(\w+\/[\w-]+)$/);
  if (local?.[1]) return { name: "local", key: local[1] };
  const share = path.match(/^\/s\/([\w-]+)$/);
  if (share?.[1]) return { name: "share", slug: share[1] };
  if (path === "/shares") return { name: "shares" };
  if (path === "/following") return { name: "following" };
  const user = path.match(/^\/u\/([\w-]+)$/);
  if (user?.[1]) return { name: "user", login: user[1] };
  const userProject = path.match(/^\/u\/([\w-]+)\/p\/([^/]+)$/);
  if (userProject?.[1] && userProject[2]) return { name: "userProject", login: userProject[1], project: decodeURIComponent(userProject[2]) };
  const repo = path.match(/^\/gh\/([\w.-]+\/[\w.-]+)$/);
  if (repo?.[1]) return { name: "repo", repo: repo[1].toLowerCase() };
  if (path === "/cli") return { name: "cli", code: new URLSearchParams(search).get("code") ?? "" };
  return { name: "not_found" };
}

const listeners = new Set<() => void>();

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const url = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      addEventListener("popstate", listener);
      return () => {
        listeners.delete(listener);
        removeEventListener("popstate", listener);
      };
    },
    () => location.pathname + location.search,
  );
  const [path = "/", search = ""] = url.split(/(?=\?)/);
  return parseRoute(path, search);
}

/** An in-app link: client-side navigation, but modifier clicks still open a new tab. */
export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
      {...props}
    />
  );
}
