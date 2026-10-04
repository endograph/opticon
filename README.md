<p align="center">
  <img src="https://raw.githubusercontent.com/endograph/opticon/main/apps/web/favicon.svg" alt="opticon" width="120" />
</p>

<p align="center">
  <a href="https://opticon.tv">Website</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#sharing">Sharing</a> ·
  <a href="https://github.com/endograph/opticon/releases">Releases</a>
</p>

# opticon

[![Opticon sessions](https://opticon.tv/badge/gh/endograph/opticon.svg)](https://opticon.tv/gh/endograph/opticon)
[![release](https://img.shields.io/github/v/release/endograph/opticon)](https://github.com/endograph/opticon/releases)
[![license](https://img.shields.io/github/license/endograph/opticon)](LICENSE)

Browse and share your Claude Code and Codex sessions.

Opticon reads sessions from `~/.claude` and `~/.codex` and opens them in your browser. Follow along locally, or share a link so someone else can watch live. Sessions stay on your machine until you share them.

Pre-alpha. Things will change.

## Quickstart

```sh
curl -fsSL https://opticon.tv/install.sh | sh
opticon web
```

macOS and Linux (arm64, x64). Installs to `~/.opticon/bin`. Update with `opticon update`.

`opticon web` runs in the background. Add `--tailscale` to open it from your other devices on the tailnet. `opticon sessions`, `opticon show <id>` and `opticon watch <id>` work in the terminal.

## Sharing

Sign in with GitHub:

```sh
opticon login
```

Then open a session and click Share. You get a preview before uploading: message text and tool names and statuses, with credentials redacted. Thinking, tool inputs and tool outputs stay local.

Choose who can open the link: anyone, specific GitHub users, or orgs and teams. Shares only appear on your profile and the public feed if you check the box. They update live while someone is watching; `opticon live-sync off` keeps them at the last shared or resynced version.

Run `opticon autosync` in a project directory to share its sessions as you work. After confirmation, sessions active from then on are uploaded about every 30 seconds without a preview and listed publicly. It matches by git remote, so clones and worktrees count too. Stop with `opticon autosync off`.

Unshare makes the uploaded copy private. Delete removes it and keeps autosync from uploading it again.

## Development

```sh
bun install
bun test
bun run typecheck
bun opticon sessions
```

## License

MIT
