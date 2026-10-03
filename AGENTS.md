# Opticon

View your local Claude Code and Codex sessions in a browser, and share chosen sessions via public or access-controlled links that can update live.

## Architecture

- **Local first.** The CLI daemon reads session files straight from `~/.claude` and `~/.codex`. Private sessions never leave the machine.
- **No agent hooks.** Everything comes from watching the file system. Both providers write append-only JSONL, which we tail by byte offset (`packages/core/src/tail.ts`).
- **`opticon web`** serves the web UI from the local daemon at `localhost`, so the browser never makes a cross-origin call to a local server. The same web app is deployed to opticon.com for shared views.
- **Sharing** uploads a server-side copy to Convex. Unsharing deletes it. Live sync pushes new events only while a shared session has connected viewers.
- **Local only.** The CLI sees only its own machine: no per-user or cross-machine view.

## Layout

```
packages/core   session discovery, provider parsers, file tailer, redaction, share projection
                (`@opticon/core/protocol` is the dependency-free wire contract the server imports)
apps/cli        `opticon` binary (Bun): commands, daemon (session store, share sync, local server)
apps/web        React UIs: index.html is the local app embedded in the binary;
                hosted.html is opticon.com (share viewer, sign-in, CLI login approval)
apps/server     Convex backend: auth, shares, presence
scripts/        isolated local Convex backend, end-to-end test
```

## Daemon

- `apps/cli/src/daemon/store.ts` keeps a metadata index for every session file, persisted to `~/.opticon/index.json` and keyed by file size and mtime. Bump `INDEX_VERSION` whenever parser output changes, or stale cached metadata is served.
- Full transcripts are only parsed for sessions someone has open. Their tails are dropped a minute after the last viewer leaves.
- Changes arrive via recursive `fs.watch`, debounced. A 3s poll of open sessions and a 60s rescan cover events FSEvents drops.
- The local server binds to `127.0.0.1` only. `/api/*` (except `/api/health`) requires the `opticon_local` cookie, which `opticon web` sets through `/auth?token=…` (token in `~/.opticon/local-token`). Requests with a non-loopback `Host` header are rejected to block DNS rebinding.
- `opticon web` heals the daemon: it starts one if none is healthy, and replaces one running a different version.

## Sharing backend (`apps/server/convex`)

- **Auth.** The web signs in with GitHub OAuth (`read:org`) via HTTP actions and gets a session token in the URL fragment. `opticon login` is device-style: the CLI shows a code, the user approves it at `/cli` on the web, and the CLI polls for a token. Only SHA-256 token hashes are stored. Functions take the token as an argument; there's no Convex Auth.
- **Shares.** `shares.append` upserts events by id. `seq` (position) is fixed on first insert; `rev` bumps on every change. Viewers page through `shares.changes` from rev 0, then subscribe at their latest rev.
- **Live sync.** Viewers heartbeat `presence`; rows expire through scheduled functions, so queries never filter by time. The daemon subscribes to `shares.liveDemand` and streams only demanded sessions.
- **Access.** Checked by `decideAccess` (`lib.ts`) against the viewer's cached GitHub orgs and teams. `access.refreshMemberships` refreshes the cache with the viewer's own token when a decision is stale.
- Generate secrets (slugs, tokens, login codes) only in actions or HTTP actions; queries and mutations get deterministic randomness.

**Never run `convex dev` in anonymous/agent mode.** On a shared machine it pushes to a deployment other projects use and replaces their functions. Use `scripts/convex-local.ts`, which runs its own backend in `.convex-local/` on port 3310.

## Session formats

These formats are undocumented and change often. Keep each parser in `packages/core/src/providers/`, tolerate unknown fields, and drop unrecognized records instead of throwing.

- **Claude Code:** `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
  - One record per assistant content block. Tool results arrive later, in `user` records.
  - Drop `isMeta` records and harness tags such as `<system-reminder>` and `<task-notification>`.
  - Titles come from `ai-title` records.
  - Subagent transcripts in `<session>/subagents/` are not read yet.
- **Codex:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/`.
  - Read only `event_msg:item_completed` items. The raw `response_item` records duplicate them and include injected context.
  - Titles come from `~/.codex/session_index.jsonl`.

Events have a stable `id`. A later event with the same id replaces the earlier one, for example a tool call going from `running` to `ok`. Emit new objects; never mutate an event that has already been emitted.

## Sharing rules

- Only `projectForShare` (`packages/core/src/share.ts`) decides what leaves the machine. It runs on the daemon, never the server.
- Shared content is message text, notices, and tool status chips: category, name and status. Thinking, tool inputs and outputs, and local summaries are never uploaded.
- Every shared text field goes through `redact`. Keep redaction aggressive: a false positive costs a mangled snippet, a false negative leaks a credential. Users get a redaction report and warning before sharing.
- Visibility is an access list: anyone with the link, GitHub users, GitHub orgs and teams. Membership is checked with the viewer's own GitHub token (`read:org`).

## Breaking changes

We make breaking changes aggressively and do not support mismatched versions.

- `PROTOCOL_VERSION` (`packages/core/src/types.ts`) covers the daemon <-> server wire format. Bump it on any incompatible change. The server rejects other versions, and the CLI tells the user to run `opticon update`. Do not write compatibility shims or migrations for old protocol versions.
- The same applies to provider formats: support what current Claude Code and Codex write, not historical formats.

## Development

```sh
bun install
bun test               # all tests
bun run typecheck
bun opticon sessions   # run the CLI from source
cd apps/cli && bun link   # global `opticon` pointing at source
bun run e2e            # full sharing flow in Chrome against an isolated local stack
```

Local sharing stack, each in its own terminal:

```sh
bun run convex                             # isolated Convex backend :3310, pushes on change
bun --hot apps/web/hosted-server.ts        # hosted web :4747 (dev sign-in, no GitHub needed)
OPTICON_DEV=1 bun run dev                  # daemon from source; then `OPTICON_DEV=1 bun opticon web`
OPTICON_DEV=1 bun opticon login
```

`OPTICON_DEV=1` points the CLI at the local stack. The local backend sets `OPTICON_DEV_AUTH=1`, which enables passwordless `/auth/dev` sign-in; never set it on a production deployment.

Production needs a Convex deployment with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OPTICON_WEB_URL` set, the hosted build (`bun run --filter @opticon/web build:hosted`) served with a `/config.json`, and the production endpoints filled in as the defaults in `apps/cli/src/account.ts` (today they come only from `OPTICON_CONVEX_URL` / `OPTICON_CONVEX_SITE_URL` or `OPTICON_DEV`).

Distribution is a compiled Bun binary (`bun run --filter @opticon/cli build`) installed via `curl | sh`. No npm distribution.
