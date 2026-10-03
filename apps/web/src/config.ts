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
}

export let config: AppConfig;

export async function loadConfig(): Promise<AppConfig> {
  const raw = (await (await fetch("/config.json")).json()) as Partial<AppConfig>;
  config = { mode: "hosted", webUrl: location.origin, ...raw } as AppConfig;
  return config;
}

export const isLocal = () => config.mode === "local";

/** The address of the local app, for links from opticon.tv. */
export const LOCAL_APP_URL = "http://127.0.0.1:4317";
