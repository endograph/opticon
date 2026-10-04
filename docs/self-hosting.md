# Self hosting guide

Run your own Opticon for your organization: sign-in limited to your GitHub org, sessions visible only to people who can read their repo, and nothing on opticon.tv.

An instance has three parts:

- **A Convex backend** (`apps/server`): stores shares and handles sign-in. Convex Cloud or self-hosted Convex.
- **The web app** (`apps/web`): a static site that viewers open, e.g. `https://opticon.acme.dev`.
- **A GitHub App** owned by your org: sign-in, org membership, and repo access.

Everyone uses the same `opticon` CLI as opticon.tv users. They point it at your instance with `opticon instance`.

Opticon is pre-alpha. Expect breaking changes, and keep your instance on the same release as your users' CLIs (see [Upgrading](#upgrading)).

## 1. Create the Convex backend

Clone the repo at the release you're deploying and install dependencies:

```sh
git clone https://github.com/endograph/opticon && cd opticon
git checkout v0.1.7   # the release your users run; see Releases
bun install
```

**Convex Cloud.** Create a project at [dashboard.convex.dev](https://dashboard.convex.dev), then create a production deploy key under the project's settings. Deploy:

```sh
cd apps/server
export CONVEX_DEPLOY_KEY='prod:…'
bunx convex deploy
```

**Self-hosted Convex.** Run the [open-source Convex backend](https://github.com/get-convex/convex-backend/tree/main/self-hosted) and set its public origins (`CONVEX_CLOUD_ORIGIN` and `CONVEX_SITE_ORIGIN`) to the URLs your users reach it at. Then deploy with its admin key:

```sh
cd apps/server
export CONVEX_SELF_HOSTED_URL='https://convex.acme.dev'
export CONVEX_SELF_HOSTED_ADMIN_KEY='…'
bunx convex deploy
```

Note the two URLs every later step needs:

| | Convex Cloud | Self-hosted |
|---|---|---|
| **Backend URL** | `https://<name>.convex.cloud` | `CONVEX_CLOUD_ORIGIN` |
| **Site URL** (HTTP actions: sign-in, CLI login, badges) | `https://<name>.convex.site` | `CONVEX_SITE_ORIGIN` |

## 2. Create a GitHub App

Create it under your org: **Settings → Developer settings → GitHub Apps → New GitHub App** (on GitHub Enterprise Server, the same place on your server).

| Setting | Value |
|---|---|
| Homepage URL | Your web URL, e.g. `https://opticon.acme.dev` |
| Callback URL | `<site URL>/auth/github/callback` |
| Expire user authorization tokens | On |
| Request user authorization (OAuth) during installation | Off |
| Webhook | Off (uncheck **Active**) |
| Repository permissions → Metadata | Read-only (the default) |
| Organization permissions → Members | Read-only |
| Where can this GitHub App be installed? | Only on this account |

Create it, generate a **client secret**, and note the **Client ID**. Then **Install App** on your org, for all repositories or the ones people work in. Opticon only sees repos the app is installed on.

What the permissions are for:

- **Members** lets Opticon confirm each user is in your org (the sign-in gate) and check org and team access on shares.
- **Metadata** lets Opticon check, with each user's own token, whether they can push to a repo (to link a share to it) or read it (for the "people who can read the repo" option).

Opticon never gets write access to anything on GitHub, and never sees code.

> **OAuth App instead?** An OAuth App with the `read:org` scope (what opticon.tv uses) works for sign-in and org and team access, but it can't see private repos. Sharing with "people who can read the repo" then only works for public repos. A GitHub App is the right choice for an org.

## 3. Configure the backend

Set these on the Convex deployment with `bunx convex env set NAME value` (same credentials as the deploy):

| Variable | Example | |
|---|---|---|
| `GITHUB_CLIENT_ID` | `Iv23…` | From the GitHub App. Required. |
| `GITHUB_CLIENT_SECRET` | | From the GitHub App. Required. |
| `OPTICON_WEB_URL` | `https://opticon.acme.dev` | Your web app's origin. Sign-in only ever redirects here, and CLI login links point here. Required. |
| `OPTICON_ALLOWED_ORGS` | `acme` | Only active members of these orgs can sign in. Comma-separated. |
| `OPTICON_ANONYMOUS` | `0` | Signed-out visitors can't open anything, including link shares, and badges are off. |
| `OPTICON_SHARE_GRANTS` | `repo,people` | Which kinds of access shares may use: `link`, `people` (users, orgs, teams), `repo`. Default: all. |
| `OPTICON_GITHUB_URL` | `https://github.acme.com` | GitHub Enterprise Server. Default: github.com. |

Never set `OPTICON_DEV_AUTH`: it enables passwordless sign-in for development.

A typical locked-down org instance:

```sh
bunx convex env set GITHUB_CLIENT_ID Iv23…
bunx convex env set GITHUB_CLIENT_SECRET …
bunx convex env set OPTICON_WEB_URL https://opticon.acme.dev
bunx convex env set OPTICON_ALLOWED_ORGS acme
bunx convex env set OPTICON_ANONYMOUS 0
bunx convex env set OPTICON_SHARE_GRANTS repo,people
```

The instance settings only narrow what shares allow; they never change what a share's settings mean. A share's access is its owner plus anyone matching any of its grants:

- **Anyone with the link.** On an instance closed to signed-out visitors, that means signed-in members with the link.
- **People who can read the repo.** The repo is the session's git remote, linked once GitHub confirms the owner can push to it. Read access is what GitHub says for each viewer.
- **Specific GitHub users, orgs, and teams.**

Turning a grant off with `OPTICON_SHARE_GRANTS` also stops it working on existing shares.

## 4. Build and deploy the web app

Build it with your backend's URLs:

```sh
OPTICON_CONVEX_URL=https://<name>.convex.cloud \
OPTICON_CONVEX_SITE_URL=https://<name>.convex.site \
OPTICON_WEB_URL=https://opticon.acme.dev \
bun run --filter @opticon/web build:hosted
```

That writes a static site to `apps/web/dist-hosted`, including `/config.json` (which tells the app and the CLI where your backend is) and `/install.sh`.

**Cloudflare Pages** works as is, including the README badge proxy:

```sh
cd apps/web
bunx wrangler pages deploy dist-hosted --project-name <your-project> --branch main
```

**Any other static host** needs:

- `index.html` served for every path that isn't a file (`/s/…`, `/gh/…`, `/cli`, `/u/…`).
- `Cache-Control: no-store` on `/config.json`.
- Optional, for README badges: proxy `/badge/*` to `<site URL>/badge/*`. Instances with `OPTICON_ANONYMOUS=0` have no badges.

Serve it over HTTPS at exactly `OPTICON_WEB_URL`.

## 5. Check it works

1. Open your web URL. With `OPTICON_ANONYMOUS=0` you see a sign-in page.
2. Sign in as an org member. You get in.
3. Sign in as someone outside the org. GitHub sign-in succeeds, then Opticon refuses with "This Opticon is limited to members of acme."
4. From a terminal, connect the CLI and share a session (below). Open the link as another member who can read the repo, and as one who can't.

## Onboarding users

Your home page shows these steps too:

```sh
curl -fsSL https://opticon.acme.dev/install.sh | sh
opticon instance https://opticon.acme.dev
opticon login
opticon web
```

`opticon instance` selects your instance for every command and the local app. People can use opticon.tv and your instance side by side:

- `opticon instance` lists the instances this machine knows.
- `opticon instance opticon.tv` switches back.
- The local app has a server picker.

The background daemon keeps syncing with every instance you're signed in to, whichever one is selected. Sign-ins and autosync rules are kept per instance, so a project autosynced to your instance never goes to opticon.tv.

## Operating it

- **Leaving the org.** Membership is re-checked hourly. People GitHub says have left are signed out everywhere, including their CLIs. If GitHub can't confirm someone's membership for 6 hours, their sign-in stops working until it can.
- **Access changes.** Org, team, and repo access are cached per viewer: refreshed in the background after 10 minutes, and no longer trusted after an hour. A repo going from public to private is noticed within about a day.
- **GitHub outages and rate limits** never count as an answer. Nobody is signed out or denied because GitHub didn't respond.
- **What's stored:** each user's GitHub user token (to make these checks as them), shared message text and tool names (tool inputs, outputs, and thinking never leave users' machines), and who viewed what. Anyone with access to the Convex deployment can read all of it.

## Upgrading

Releases are versioned together: CLI, backend, and web app. The CLI and backend refuse to talk across a protocol change, and the CLI tells users to run `opticon update`.

To upgrade an instance:

1. Check out the new release tag.
2. Read its release notes for migrations. A migration is usually a one-off `bunx convex run …` between two deploys.
3. Deploy the backend (`bunx convex deploy`), then rebuild and deploy the web app.
4. Have users run `opticon update`.

## Limitations

- **Revocation isn't instant.** Opticon has no webhooks yet, so it takes up to an hour (see [Operating it](#operating-it)).
- **One GitHub per instance:** github.com or one GitHub Enterprise Server.
- **Sign-in is GitHub only.**
