import { type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { config, isLocal, placeLabel } from "./config";
import { selectInstance } from "./local/api";
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
  const sidebar = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const url = location.pathname + location.search;
  useEffect(() => setDrawer(false), [url]);
  useEffect(() => {
    if (!drawer) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
      if (e.key !== "Tab") return;
      const controls = Array.from(sidebar.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ) ?? []).filter((el) => el.getClientRects().length && getComputedStyle(el).visibility === "visible");
      const first = controls[0];
      const last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const mobile = matchMedia("(max-width: 760px)");
    const onResize = () => { if (!mobile.matches) setDrawer(false); };
    mobile.addEventListener("change", onResize);
    addEventListener("keydown", onKey);
    return () => {
      mobile.removeEventListener("change", onResize);
      removeEventListener("keydown", onKey);
      menu.current?.focus();
    };
  }, [drawer]);

  return (
    <div className="app" data-drawer={drawer || undefined}>
      <header className="topbar" inert={drawer}>
        <button ref={menu} type="button" className="menu-button" aria-label="Open navigation" aria-controls="navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        </button>
        <Link href="/" className="brand">
          Opticon
        </Link>
      </header>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <nav ref={sidebar} id="navigation" className="sidebar" aria-label="Navigation">
        <div className="sidebar-nav">
          <div className="brand-row">
            <Link href="/" className="brand">
              Opticon
            </Link>
            <ThemeButton />
            <button ref={close} type="button" className="menu-button drawer-close" aria-label="Close navigation" onClick={() => setDrawer(false)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          {/* Where you are: this machine's local app, or opticon.tv. Same app either way. */}
          <div className={`place ${isLocal() ? "local" : "hosted"}`} title={isLocal() ? "Sessions on this machine" : undefined}>
            {isLocal() && <span className="place-dot" />}
            {placeLabel()}
          </div>
          <InstancePicker />
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
      <main className="main" inert={drawer}>
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

/**
 * The local app's server: where its shares go. Choosing one selects it for this machine, as
 * `opticon instance` does; every server keeps syncing either way. Hidden with only one server.
 */
function InstancePicker() {
  const { daemon } = useIdentity();
  const [busy, setBusy] = useState(false);
  const instances = daemon?.instances ?? [];
  if (!isLocal() || instances.length < 2) return null;
  return (
    <label className="instance-picker" title="Where shares from this app go. Every server keeps syncing.">
      <span>Server</span>
      <select
        value={config.convexUrl}
        disabled={busy}
        onChange={(e) => {
          const next = instances.find((i) => i.convexUrl === e.target.value);
          if (!next) return;
          setBusy(true);
          // The daemon then reports the new selection and the page reloads onto it.
          void selectInstance(next.name).catch(() => setBusy(false));
        }}
      >
        {instances.map((i) => (
          <option key={i.convexUrl} value={i.convexUrl}>
            {i.name} · {i.login ?? "not signed in"}
          </option>
        ))}
      </select>
    </label>
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
