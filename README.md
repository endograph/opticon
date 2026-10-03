# Opticon

https://opticon.tv

- Reads Claude Code sessions from `~/.claude` and Codex sessions from `~/.codex` on your machine.
- `opticon web` runs a local daemon and opens your sessions in the browser, updating live as they're written.
- `opticon web --tailscale` serves the same view to your other devices on your tailnet.
- Sessions stay on your machine unless you share them.
- Sharing uploads a copy of a session to opticon.tv. Unsharing deletes it.
- Shared sessions include message text and tool names and statuses. Thinking, tool inputs and tool outputs are not uploaded.
- Shared text is scanned and redacted for credentials before upload.
- Access to a share can be anyone with the link, specific GitHub users, or GitHub orgs and teams.
- Shared sessions can update live while someone is viewing them.
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
