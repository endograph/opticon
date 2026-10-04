/**
 * Runtime config from /config.json. The daemon serves `mode: "local"`; opticon.tv serves a static
 * file (no mode, so hosted) and the hosted dev server serves `mode: "hosted"`.
 */
export interface AppConfig {
  mode: "local" | "hosted";
  convexUrl: string;
  /** Convex HTTP actions origin (sign-in, CLI login). */
  siteUrl: string;
  /** Public origin share links point at. Defaults to this page's origin. */
  webUrl: string;
  /** Show the passwordless dev sign-in instead of GitHub. Only true against a dev backend. */
  devAuth?: boolean;
  /** The local app's machine name, e.g. "fox". Local mode only. */
  machine?: string;
}

export let config: AppConfig;

export async function loadConfig(): Promise<AppConfig> {
  const raw = (await (await fetch("/config.json")).json()) as Partial<AppConfig>;
  config = { mode: "hosted", webUrl: location.origin, ...raw } as AppConfig;
  return config;
}

export const isLocal = () => config.mode === "local";

/** "Opticon on fox" in the local app, "opticon.tv" when hosted. */
export const placeLabel = () => (isLocal() ? `Local · ${config.machine ?? "this machine"}` : location.host);

/**
 * Tab titles. The local app ends with its machine instead of "Opticon", so a tab says where it
 * lives: "Fix build · fox" versus "Fix build · Opticon".
 */
export function setPageTitle(title?: string): void {
  const suffix = isLocal() ? (config.machine ?? "local") : "Opticon";
  document.title = title ? `${title} · ${suffix}` : isLocal() ? `Opticon · ${suffix}` : "Opticon";
}

/** The local app draws its favicon in the "local" green, so its tabs stand apart from opticon.tv. */
export function applyLocalFavicon(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const prefix = "data:image/svg+xml,";
  if (!link?.href.startsWith(prefix)) return;
  const svg = decodeURIComponent(link.href.slice(prefix.length))
    .replace(/#1d1d1b/gi, LOCAL_GREEN.light)
    .replace(/#e9e9e6/gi, LOCAL_GREEN.dark);
  link.href = prefix + encodeURIComponent(svg);
}

export const LOCAL_GREEN = { light: "#4f7a5c", dark: "#8fb39a" };

/** The address of the local app, for links from opticon.tv. */
export const LOCAL_APP_URL = "http://127.0.0.1:4317";

export const GITHUB_URL = "https://github.com/endograph/opticon";
/** Every hosted instance serves the installer; it downloads the same release from GitHub. */
export const installCommand = () => `curl -fsSL ${config.webUrl}/install.sh | sh`;

/** True on opticon.tv (or its local app), which the CLI uses unless told otherwise. */
export const isDefaultInstance = () => new URL(config.webUrl).host === "opticon.tv";

/** Signs the CLI in to this instance, selecting it first unless it's opticon.tv. */
export const loginCommand = () => (isDefaultInstance() ? "opticon login" : `opticon instance ${config.webUrl} && opticon login`);
