import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isLocal, loadConfig, applyLocalFavicon } from "./config";
import { IdentityProvider } from "./identity";
import { captureSessionFromHash } from "./session";
import { ScrollThumbs } from "./ScrollThumbs";

const config = await loadConfig();
if (!isLocal()) captureSessionFromHash();
else applyLocalFavicon();
const convex = new ConvexReactClient(config.convexUrl);

createRoot(document.getElementById("root")!).render(
  <ConvexProvider client={convex}>
    <IdentityProvider>
      <App />
      <ScrollThumbs />
    </IdentityProvider>
  </ConvexProvider>,
);
