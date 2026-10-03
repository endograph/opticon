import { api } from "@opticon/server/api";
import { useMutation, useQuery } from "convex/react";
import { type ReactNode, useEffect, useState } from "react";
import { isLocal } from "./config";
import { SignInButton, useIdentity } from "./identity";
import { Link, type Route } from "./router";
import { signOut } from "./session";

/** The one layout for both modes: navigation, optional page sidebar content, account. */
export function Shell(props: { route: Route; sidebar?: ReactNode; children: ReactNode }) {
  const active = props.route.name;
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-nav">
          <Link href="/" className="brand">
            Opticon
          </Link>
          <Link href="/local" className="nav-item" aria-current={active === "local"}>
            Local sessions
          </Link>
          <Link href="/shares" className="nav-item" aria-current={active === "shares"}>
            My shares
          </Link>
        </div>
        <div className="sidebar-content">{props.sidebar}</div>
        <div className="sidebar-footer">
          <AccountFooter />
        </div>
      </nav>
      <main className="main">{props.children}</main>
    </div>
  );
}

function AccountFooter() {
  const { token, daemon } = useIdentity();
  const me = useQuery(api.auth.me, token ? { token } : "skip");
  const setLiveSync = useMutation(api.auth.setLiveSync);
  // Optimistic: show the new value at once; the server's value wins when it arrives.
  const [liveSync, setLocalLiveSync] = useState(me?.liveSync ?? true);
  useEffect(() => setLocalLiveSync(me?.liveSync ?? true), [me?.liveSync]);

  if (isLocal() && daemon?.account?.error && !daemon.account.signedIn) {
    return <p className="hint">{daemon.account.error}</p>;
  }
  if (!token || !me) return <SignInButton />;
  return (
    <div className="account">
      <span className="me truncate">
        {me.avatarUrl && <img src={me.avatarUrl} alt="" />}
        <span className="truncate">
          <strong>{me.login}</strong>
          {isLocal() && <span className="dim"> · via opticon login</span>}
        </span>
        {!isLocal() && (
          <button type="button" className="button subtle small" onClick={signOut}>
            Sign out
          </button>
        )}
      </span>
      <label className="toggle" title="Stream new messages to shared sessions while someone is viewing">
        <input
          type="checkbox"
          checked={liveSync}
          onChange={(e) => {
            setLocalLiveSync(e.target.checked);
            void setLiveSync({ token, liveSync: e.target.checked });
          }}
        />
        Live sync shared sessions
      </label>
    </div>
  );
}
