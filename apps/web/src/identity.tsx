import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { config, isLocal } from "./config";
import { type Daemon, useDaemonState } from "./local/api";
import { type SessionUser, cacheUser, getSession, getSessionUser, signIn, signOut, useSessionToken } from "./session";

/**
 * Who the page acts as when talking to Convex.
 *
 * On opticon.tv that's the browser's GitHub sign-in. In the local app it's the CLI's login
 * (`opticon login`), which the daemon hands to its own cookie-gated page. The two are separate
 * on purpose; neither is ever copied into the other.
 */
interface Identity {
  token?: string;
  /** Undefined while checking auth; null when signed out. May initially be cached for display. */
  me: SessionUser | null | undefined;
  /** The local daemon's state. Undefined on opticon.tv. */
  daemon?: Daemon;
}

const IdentityContext = createContext<Identity>({ me: undefined });

export const useIdentity = () => useContext(IdentityContext);
export const useToken = () => useContext(IdentityContext).token;

export function IdentityProvider({ children }: { children: ReactNode }) {
  return isLocal() ? <LocalIdentity>{children}</LocalIdentity> : <HostedIdentity>{children}</HostedIdentity>;
}

function HostedIdentity({ children }: { children: ReactNode }) {
  const token = useSessionToken();
  const confirmed = useQuery(api.auth.me, token ? { token } : "skip");
  const me = useMemo(() => getSessionUser(token, config.convexUrl, confirmed), [token, confirmed]);

  useEffect(() => {
    if (!token || confirmed === undefined || getSession() !== token) return;
    if (confirmed === null) signOut();
    else cacheUser(token, config.convexUrl, confirmed);
  }, [token, confirmed]);

  return <IdentityContext.Provider value={{ token: me === null ? undefined : token, me }}>{children}</IdentityContext.Provider>;
}

function LocalIdentity({ children }: { children: ReactNode }) {
  const daemon = useDaemonState();
  const [session, setSession] = useState<{ login: string; token?: string }>();
  const login = daemon.account?.signedIn ? daemon.account.login : undefined;
  const token = login && session?.login === login ? session.token : undefined;
  const confirmed = useQuery(api.auth.me, token ? { token } : "skip");
  const me = daemon.account?.signedIn === false ? null : confirmed;

  // Re-fetch whenever the CLI signs in, out, or as someone else.
  useEffect(() => {
    if (!login) return setSession(undefined);
    let cancelled = false;
    void fetch("/api/convex-token")
      .then((r) => (r.ok ? (r.json() as Promise<{ token: string | null }>) : { token: null }))
      .then(({ token }) => !cancelled && setSession({ login, token: token ?? undefined }));
    return () => {
      cancelled = true;
    };
  }, [login]);

  return <IdentityContext.Provider value={{ token, daemon, me }}>{children}</IdentityContext.Provider>;
}

export function SignInButton({ primary, large }: { primary?: boolean; large?: boolean }) {
  const { me } = useIdentity();
  if (me !== null) return null;
  if (isLocal()) {
    return (
      <span className="hint">
        Run <code>opticon login</code> in a terminal to sign in.
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`button${primary ? " primary" : ""}${large ? " large" : ""}`}
      onClick={() => signIn(config.devAuth ? (prompt("Dev sign-in as which GitHub user?", "dev") ?? undefined) : undefined)}
    >
      Sign in with GitHub
    </button>
  );
}
