/** Convex exposes deployment environment variables on process.env; no other Node globals exist. */
declare const process: { env: Record<string, string | undefined> };
