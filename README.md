# Opticon

https://opticon.tv

```sh
curl -fsSL https://opticon.tv/install.sh | sh
```

macOS and Linux (arm64, x64). Installs to `~/.opticon/bin`. Update with `opticon update`.

- Reads Claude Code sessions from `~/.claude` and Codex sessions from `~/.codex` on your machine.
- `opticon web` runs a local daemon and opens your sessions in the browser, updating live as they're written.
- `opticon web --tailscale` serves the same view to your other devices on your tailnet.
- Sessions stay on your machine unless you share them.
- Sharing uploads a copy of a session to opticon.tv. Unsharing makes the copy private; deleting removes it.
- Shared sessions include message text and tool names and statuses. Thinking, tool inputs and tool outputs are not uploaded.
- Shared text is scanned and redacted for credentials before upload.
- Access to a share can be anyone with the link, specific GitHub users, or GitHub orgs and teams.
- Shared sessions update live while someone is viewing them. Turn this off with `opticon live-sync off`; viewers then see each share as it was when you last shared or resynced it.
- Shares are only listed on your profile and the public feed if you choose to; the share dialog has a checkbox for it, off by default.
- `opticon autosync` syncs every session in a project (matched by git remote) and makes them publicly discoverable on your profile and the public feed, after asking you to confirm. Sessions active from then on are uploaded about every 30 seconds without a preview. Deleted sessions are never re-uploaded.
- `opticon sessions`, `opticon show` and `opticon watch` list and print sessions in the terminal.

## Development

```sh
bun install
bun test
bun run typecheck
bun opticon sessions
```

## License

MIT
