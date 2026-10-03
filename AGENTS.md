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
apps/cli        `opticon` binary (Bun): daemon, local API, commands
```

Planned: `apps/web` (Vite + React, runs locally and on opticon.com) and `convex/` (shares, ACLs, presence, CLI auth).

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
```

Distribution is a compiled Bun binary (`bun run --filter @opticon/cli build`) installed via `curl | sh`. No npm distribution.
