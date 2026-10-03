import { api } from "@opticon/server/api";
import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { createRoot } from "react-dom/client";
import { CliApprove } from "./CliApprove";
import { type HostedConfig, captureSessionFromHash, signIn, signOut, useSessionToken } from "./session";
import { ShareView } from "./ShareView";

captureSessionFromHash();
const config = (await (await fetch("/config.json")).json()) as HostedConfig;
const convex = new ConvexReactClient(config.convexUrl);

function App() {
  const path = location.pathname;
  const slug = path.match(/^\/s\/([\w-]+)$/)?.[1];
  return (
    <div className="hosted">
      <TopBar />
      {slug ? (
        <ShareView slug={slug} config={config} />
      ) : path === "/cli" ? (
        <CliApprove code={new URLSearchParams(location.search).get("code") ?? ""} config={config} />
      ) : (
        <Home />
      )}
    </div>
  );
}

function TopBar() {
  const token = useSessionToken();
  const me = useQuery(api.auth.me, { token });
  return (
    <header className="topbar">
      <a href="/" className="brand">
        Opticon
      </a>
      <span className="spacer" />
      {me ? (
        <span className="me">
          {me.avatarUrl && <img src={me.avatarUrl} alt="" />}
          {me.login}
          <button type="button" className="button subtle" onClick={signOut}>
            Sign out
          </button>
        </span>
      ) : (
        <SignInButton />
      )}
    </header>
  );
}

export function SignInButton({ primary }: { primary?: boolean }) {
  return (
    <button
      type="button"
      className={`button ${primary ? "primary" : ""}`}
      onClick={() => signIn(config, config.devAuth ? (prompt("Dev login as which GitHub user?", "dev") ?? undefined) : undefined)}
    >
      Sign in with GitHub
    </button>
  );
}

function Home() {
  return (
    <main className="hosted-page narrow">
      <h1>Share your agent sessions</h1>
      <p>
        Opticon shows your Claude Code and Codex sessions in a browser, straight from your machine. Share the ones you
        choose with a link, with specific GitHub users, or with your org or team. Shared sessions can update live while
        someone is watching.
      </p>
      <pre>opticon web</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ConvexProvider client={convex}>
    <App />
  </ConvexProvider>,
);
