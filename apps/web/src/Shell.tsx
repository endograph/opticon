import { api } from "@opticon/server/api";
import { useMutation, useQuery } from "convex/react";
import { type ReactNode, useEffect, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { isLocal } from "./config";
import { SignInButton, useIdentity } from "./identity";
import { Link, type Route } from "./router";
import { signOut } from "./session";
import { nextTheme, setTheme, useTheme } from "./theme";
import { FollowingSidebar } from "./shares/Following";

/** The one layout for both modes: navigation, optional page sidebar content, account. */
export function Shell(props: { route: Route; sidebar?: ReactNode; children: ReactNode }) {
  const active = props.route.name;
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-nav">
          <div className="brand-row">
            <Link href="/" className="brand">
              Opticon
            </Link>
            <ThemeButton />
          </div>
          <Link href="/local" className="nav-item" aria-current={active === "local"}>
            Local sessions
          </Link>
          <Link href="/shares" className="nav-item" aria-current={active === "shares"}>
            My shares
          </Link>
          <Link href="/following" className="nav-item" aria-current={active === "following"}>
            Following
          </Link>
        </div>
        <div className="sidebar-content">
          <ErrorBoundary fallback={null}>
            {props.sidebar ??
              (active !== "following" && <FollowingSidebar current={props.route.name === "share" ? props.route.slug : undefined} />)}
          </ErrorBoundary>
        </div>
        <div className="sidebar-footer">
          <AccountFooter />
        </div>
      </nav>
      <main className="main">
        {/* Keyed by URL so navigating away from a failed page retries. */}
        <ErrorBoundary key={location.pathname} fallback={<PageError />}>
          {props.children}
        </ErrorBoundary>
      </main>
    </div>
  );
}

function PageError() {
  return (
    <div className="empty">
      <h2>Something went wrong</h2>
      <p>This page couldn't load. If you run Opticon locally, the server may not support this version yet.</p>
    </div>
  );
}

/**
 * Cycles system → light → dark. A fixed-size box: the Opticon mark slides aside on hover to
 * uncover the current mode's icon, so the control never changes the space it takes.
 */
function ThemeButton() {
  const theme = useTheme();
  const label = `Theme: ${theme}`;
  return (
    <button type="button" className="theme" data-mode={theme} aria-label={label} title={label} onClick={() => setTheme(nextTheme(theme))}>
      <svg className="i-system" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
        <path d="M5.5 14h5" />
      </svg>
      <svg className="i-light" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.1" />
        <path d="M8 .9v1.8M8 13.3v1.8M15.1 8h-1.8M2.7 8H.9M13 3l-1.3 1.3M4.3 11.7 3 13M13 13l-1.3-1.3M4.3 4.3 3 3" />
      </svg>
      <svg className="i-dark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.5 9.6A6 6 0 1 1 6.4 2.5a4.8 4.8 0 0 0 7.1 7.1Z" />
      </svg>
      {/* The favicon's panopticon: a ring of six cells. */}
      <svg className="i-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M9.90 2.30A15 15 0 0 1 22.10 2.30L19.99 7.05A9.8 9.8 0 0 0 12.01 7.05ZM24.82 3.86A15 15 0 0 1 30.92 14.43L25.75 14.98A9.8 9.8 0 0 0 21.76 8.07ZM30.92 17.57A15 15 0 0 1 24.82 28.14L21.76 23.93A9.8 9.8 0 0 0 25.75 17.02ZM22.10 29.70A15 15 0 0 1 9.90 29.70L12.01 24.95A9.8 9.8 0 0 0 19.99 24.95ZM7.18 28.14A15 15 0 0 1 1.08 17.57L6.25 17.02A9.8 9.8 0 0 0 10.24 23.93ZM1.08 14.43A15 15 0 0 1 7.18 3.86L10.24 8.07A9.8 9.8 0 0 0 6.25 14.98Z" />
      </svg>
    </button>
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
