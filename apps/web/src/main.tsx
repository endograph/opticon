import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isLocal, loadConfig, applyLocalFavicon } from "./config";
import { AppError, ErrorBoundary } from "./ErrorBoundary";
import { IdentityProvider } from "./identity";
import { captureSessionFromHash } from "./session";
import { ScrollThumbs } from "./ScrollThumbs";

const root = createRoot(document.getElementById("root")!);

try {
  const config = await loadConfig();
  if (!isLocal()) captureSessionFromHash();
  else applyLocalFavicon();
  const convex = new ConvexReactClient(config.convexUrl);

  root.render(
    <ErrorBoundary fallback={(error) => <AppError error={error} />}>
      <ConvexProvider client={convex}>
        <IdentityProvider>
          <App />
          <ScrollThumbs />
        </IdentityProvider>
      </ConvexProvider>
    </ErrorBoundary>,
  );
} catch (error) {
  console.error(error);
  root.render(<AppError error={error} />);
}
