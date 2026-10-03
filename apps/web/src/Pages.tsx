import { LOCAL_APP_URL } from "./config";
import { Link } from "./router";

/** opticon.tv's home page. The local app goes straight to its sessions instead. */
export function Home() {
  return (
    <div className="page narrow">
      <h1>Share your agent sessions</h1>
      <p>
        Opticon shows your Claude Code and Codex sessions in a browser, straight from your machine. Share the ones you
        choose with a link, with specific GitHub users, or with your org or team. Shared sessions can update live while
        someone is watching.
      </p>
      <p>
        <Link href="/local">Open your local sessions</Link> · <Link href="/shares">See what you've shared</Link>
      </p>
    </div>
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
          Install the <code>opticon</code> CLI on the computer where you run Claude Code or Codex.
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
