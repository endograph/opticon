import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isLocal, loadConfig } from "./config";
import { IdentityProvider } from "./identity";
import { captureSessionFromHash } from "./session";

const config = await loadConfig();
if (!isLocal()) captureSessionFromHash();
const convex = new ConvexReactClient(config.convexUrl);

createRoot(document.getElementById("root")!).render(
  <ConvexProvider client={convex}>
    <IdentityProvider>
      <App />
    </IdentityProvider>
  </ConvexProvider>,
);
