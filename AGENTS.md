# Opticon

This is pre-alpha. Make breaking changes aggressively and never add backwards compatibility unless requested.

## Restart the daemon after changes

The local app is served by a background daemon that keeps running the code it started with. After changing anything it runs or serves (`apps/cli`, `apps/web`, `packages/*`), restart it before you finish so the user sees your change:

```sh
bun run opticon stop && bun run opticon web --no-open
```
