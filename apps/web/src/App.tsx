import { useEffect } from "react";
import { CliApprove } from "./CliApprove";
import { Home, LocalExplainer, NotFound } from "./Pages";
import { Shell } from "./Shell";
import { isLocal } from "./config";
import { useIdentity } from "./identity";
import { LocalSessions } from "./local/LocalSessions";
import { type Route, navigate, useRoute } from "./router";
import { MyShares } from "./shares/MyShares";
import { ShareView } from "./shares/ShareView";

/**
 * One app for both places it runs. The local app (served by the daemon) and opticon.tv share
 * every route; the difference is that only the local app can list this machine's sessions.
 */
export function App() {
  const route = useRoute();
  const { daemon } = useIdentity();

  useEffect(() => {
    if (isLocal() && route.name === "home") navigate("/local", { replace: true });
  }, [route.name]);
  useEffect(() => {
    if (route.name !== "local" && route.name !== "share") document.title = "Opticon";
  }, [route.name]);

  if (daemon && (daemon.status === "unauthorized" || daemon.status === "offline")) return <Blocked status={daemon.status} />;
  if (route.name === "local" && isLocal()) return <LocalSessions route={route} selected={route.key} />;
  return <Shell route={route}>{page(route)}</Shell>;
}

function page(route: Route) {
  switch (route.name) {
    case "home":
      return isLocal() ? null : <Home />;
    case "local":
      return <LocalExplainer />;
    case "share":
      return <ShareView key={route.slug} slug={route.slug} />;
    case "shares":
      return <MyShares />;
    case "cli":
      return <CliApprove code={route.code} />;
    case "not_found":
      return <NotFound />;
  }
}

function Blocked({ status }: { status: "unauthorized" | "offline" }) {
  return (
    <div className="blocked">
      <h2>{status === "offline" ? "The Opticon daemon isn't running" : "Not connected to this machine"}</h2>
      <p>
        Run <code>opticon web</code> in a terminal to {status === "offline" ? "start it" : "connect this browser"}.
      </p>
    </div>
  );
}
