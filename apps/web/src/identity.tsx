import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { config, isLocal } from "./config";
import { type Daemon, useDaemonState } from "./local/api";
import { signIn, useSessionToken } from "./session";

/**
 * Who the page acts as when talking to Convex.
 *
 * On opticon.tv that's the browser's GitHub sign-in. In the local app it's the CLI's login
 * (`opticon login`), which the daemon hands to its own cookie-gated page. The two are separate
 * on purpose; neither is ever copied into the other.
 */
interface Identity {
  token?: string;
  /** The local daemon's state. Undefined on opticon.tv. */
  daemon?: Daemon;
}

const IdentityContext = createContext<Identity>({});

export const useIdentity = () => useContext(IdentityContext);
export const useToken = () => useContext(IdentityContext).token;

export function IdentityProvider({ children }: { children: ReactNode }) {
  return isLocal() ? <LocalIdentity>{children}</LocalIdentity> : <HostedIdentity>{children}</HostedIdentity>;
}

function HostedIdentity({ children }: { children: ReactNode }) {
  const token = useSessionToken();
  return <IdentityContext.Provider value={{ token }}>{children}</IdentityContext.Provider>;
}

function LocalIdentity({ children }: { children: ReactNode }) {
  const daemon = useDaemonState();
  const [token, setToken] = useState<string>();
  const login = daemon.account?.signedIn ? daemon.account.login : undefined;

  // Re-fetch whenever the CLI signs in, out, or as someone else.
  useEffect(() => {
    if (!login) return setToken(undefined);
    let cancelled = false;
    void fetch("/api/convex-token")
      .then((r) => (r.ok ? (r.json() as Promise<{ token: string | null }>) : { token: null }))
      .then(({ token }) => !cancelled && setToken(token ?? undefined));
    return () => {
      cancelled = true;
    };
  }, [login]);

  return <IdentityContext.Provider value={{ token, daemon }}>{children}</IdentityContext.Provider>;
}

export function SignInButton({ primary }: { primary?: boolean }) {
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
      className={`button ${primary ? "primary" : ""}`}
      onClick={() => signIn(config.devAuth ? (prompt("Dev sign-in as which GitHub user?", "dev") ?? undefined) : undefined)}
    >
      Sign in with GitHub
    </button>
  );
}
