/**
 * Where GitHub is. OPTICON_GITHUB_URL points an instance at GitHub Enterprise Server, e.g.
 * https://github.acme.com; its API is under /api/v3. Defaults to github.com.
 */
export function githubUrl(): string {
  return (process.env.OPTICON_GITHUB_URL ?? "https://github.com").replace(/\/$/, "");
}

export function githubApi(): string {
  const web = githubUrl();
  return web === "https://github.com" ? "https://api.github.com" : `${web}/api/v3`;
}

/** The host daemons see in remotes, e.g. `github.com`. */
export const githubHost = () => new URL(githubUrl()).host.toLowerCase();

export function githubApiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "opticon" };
}
