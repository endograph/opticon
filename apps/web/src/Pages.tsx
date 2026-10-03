import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";
import { GITHUB_URL, INSTALL_COMMAND, LOCAL_APP_URL, isLocal } from "./config";
import { SignInButton, useIdentity } from "./identity";
import { Link } from "./router";
import { Feed } from "./shares/Discover";

/** The home page, on opticon.tv and in the local app (which skips the install steps). */
export function Home() {
  const [installing, setInstalling] = useState(false);
  const { token, daemon } = useIdentity();
  const me = useQuery(api.auth.me, token ? { token } : "skip");
  // Wait for an answer before offering sign-in, so signed-in users never see it flash. The
  // local app signs in through the CLI, so the daemon knows; opticon.tv asks Convex.
  const signedOut = isLocal() ? daemon?.account?.signedIn === false : !token || me === null;

  return (
    <div className="page home">
      <section className="hero">
        <Mark className="hero-mark" size={120} />
        <h1>Opticon</h1>
        <p className="lede">Share your agent sessions</p>
        <div className="hero-actions">
          {!isLocal() && (
            <button type="button" className="button primary large" onClick={() => setInstalling(true)}>
              Install opticon
            </button>
          )}
          {signedOut && !isLocal() && <SignInButton large />}
          <a className="button large" href={GITHUB_URL}>
            <GitHubIcon />
            View on GitHub
          </a>
          <Link className="button large" href="/local">
            Open local sessions
          </Link>
        </div>
        {signedOut && isLocal() && (
          <p className="hero-note">
            <SignInButton />
          </p>
        )}
      </section>

      {!isLocal() && (
        <section className="install">
          <h2>Get started</h2>
          <CopyCommand command={INSTALL_COMMAND} />
          <CopyCommand command="opticon web" />
          <p className="dim">
            macOS and Linux. <code>opticon web</code> runs in the background and opens your sessions in the browser.
            Update with <code>opticon update</code>.
          </p>
        </section>
      )}

      <Feed />

      <footer className="home-footer">
        <a href={GITHUB_URL}>
          <GitHubIcon />
          endograph/opticon
        </a>
        <span>MIT licensed</span>
        <Link href="/shares">My shares</Link>
      </footer>

      {installing && <InstallDialog onClose={() => setInstalling(false)} />}
    </div>
  );
}

/** Install steps and a short account of what Opticon does with your sessions. */
function InstallDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog ref={dialog} className="install-dialog" onClose={onClose}>
      <header>
        <h2>Install Opticon</h2>
        <button type="button" className="button subtle" onClick={() => dialog.current?.close()} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="install-body">
        <ol className="install-steps">
          <li>
            <strong>Install</strong> on the computer where you run Claude Code or Codex:
            <CopyCommand command={INSTALL_COMMAND} />
            <span className="dim">macOS and Linux. Installs to ~/.opticon/bin.</span>
          </li>
          <li>
            <strong>Open your sessions</strong> in the browser:
            <CopyCommand command="opticon web" />
          </li>
          <li>
            <strong>To share,</strong> sign in with GitHub, then use Share… on any session:
            <CopyCommand command="opticon login" />
          </li>
        </ol>
        <h3>How it works</h3>
        <ul className="how">
          <li>
            Opticon runs a small background service that reads sessions from <code>~/.claude</code> and{" "}
            <code>~/.codex</code>. They stay on your machine.
          </li>
          <li>
            Sharing uploads a copy with message text and tool names. Thinking and tool output stay local, and
            credentials are redacted. You see exactly what will be uploaded first.
          </li>
          <li>Choose who can open it: anyone with the link, or specific GitHub users, orgs or teams.</li>
          <li>Viewers see new messages live while they watch. Unsharing deletes the copy.</li>
        </ul>
      </div>
      <footer>
        <a className="button subtle" href={GITHUB_URL}>
          <GitHubIcon />
          Source on GitHub
        </a>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Done
        </button>
      </footer>
    </dialog>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>
        <span className="prompt">$ </span>
        {command}
      </code>
      <button
        type="button"
        className="button subtle small"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg className="gh-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * "Local sessions" on opticon.tv. Session files never leave your machine, so this site can't
 * list them; the local app does. A plain link, never a request to localhost: browsers block or
 * prompt for those, and a page probing your machine would be the wrong default.
 */
export function LocalExplainer() {
  return (
    <div className="page narrow">
      <h1>Local sessions live on your machine</h1>
      <p>
        Your Claude Code and Codex sessions are read straight from your computer and never uploaded, so opticon.tv can't
        show them. Only the sessions you share are copied here.
      </p>
      <h2>To see them</h2>
      <ol className="steps">
        <li>
          On the computer where you run Claude Code or Codex, install the CLI:
          <CopyCommand command={INSTALL_COMMAND} />
        </li>
        <li>
          Run <code>opticon web</code>. It starts Opticon in the background and opens your sessions in the browser.
        </li>
      </ol>
      <p>
        If it's already running, <a href={LOCAL_APP_URL}>open the local app</a>. That link only works on the computer
        running Opticon.
      </p>
      <p className="dim">
        On another device? Run <code>opticon web --tailscale</code> on the machine with your sessions to reach them over
        your tailnet.
      </p>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="empty">
      <h2>Page not found</h2>
      <p>
        <Link href="/">Go home</Link>
      </p>
    </div>
  );
}
