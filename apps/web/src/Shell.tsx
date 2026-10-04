import { type ReactNode, useEffect, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { isLocal, placeLabel } from "./config";
import { SignInButton, useIdentity } from "./identity";
import { Link, type Route } from "./router";
import { signOut } from "./session";
import { nextTheme, setTheme, useTheme } from "./theme";
import { FollowingSidebar } from "./shares/Following";

/** The one layout for both modes: navigation, optional page sidebar content, account. */
export function Shell(props: { route: Route; sidebar?: ReactNode; children: ReactNode }) {
  const active = props.route.name;
  // On narrow screens the sidebar is a drawer. Any navigation closes it.
  const [drawer, setDrawer] = useState(false);
  const url = location.pathname + location.search;
  useEffect(() => setDrawer(false), [url]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="app" data-drawer={drawer || undefined}>
      <header className="topbar">
        <button type="button" className="menu-button" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        </button>
        <Link href="/" className="brand">
          Opticon
        </Link>
      </header>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <nav className="sidebar">
        <div className="sidebar-nav">
          <div className="brand-row">
            <Link href="/" className="brand">
              Opticon
            </Link>
            <ThemeButton />
          </div>
          {/* Where you are: this machine's local app, or opticon.tv. Same app either way. */}
          <div className={`place ${isLocal() ? "local" : "hosted"}`} title={isLocal() ? "Sessions on this machine" : undefined}>
            {isLocal() && <span className="place-dot" />}
            {placeLabel()}
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
          <Link href="/repos" className="nav-item" aria-current={active === "repos" || active === "repo"}>
            Repos
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
 * Cycles system → light → dark. A fixed-size box: the ink drop slides aside on hover to
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
      <svg className="i-drop" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.6c2.7 3 4.4 5.2 4.4 7.1a4.4 4.4 0 0 1-8.8 0c0-1.9 1.7-4.1 4.4-7.1Z" />
      </svg>
    </button>
  );
}

function AccountFooter() {
  const { me, daemon } = useIdentity();

  if (isLocal() && daemon?.account?.error && !daemon.account.signedIn) {
    return <p className="hint">{daemon.account.error}</p>;
  }
  if (me === undefined) return null;
  if (me === null) return <SignInButton />;
  return (
    <div className="account">
      <span className="me truncate">
        <Link href={`/u/${me.login}`} className="me-link truncate" title="Your public profile">
          {me.avatarUrl && <img src={me.avatarUrl} alt="" />}
          <span className="truncate">
            <strong>{me.login}</strong>
            {isLocal() && <span className="dim"> · via opticon login</span>}
          </span>
        </Link>
        {!isLocal() && (
          <button type="button" className="button subtle small" onClick={signOut}>
            Sign out
          </button>
        )}
      </span>
    </div>
  );
}
