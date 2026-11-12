# my-bot-modules

A **module repository** for the [Guildwright](https://github.com/bool-/guildwright) engine
(the `guildwright` npm package): your own Discord bot, running
your own modules, whose `/request` command turns an idea typed in Discord into a GitHub issue, an
Approve/Reject card, and - once a human approves - a pull request into **this** repository written
by Claude Code in GitHub Actions.

The engine is an npm package in `node_modules`, pinned to one exact version in `package.json`.
This repository holds only what is yours: your modules under `src/modules/`, the CI and agent
gate files under `.github/`, and your configuration. One bot process serves one trust domain:
your requests, logs, database, Anthropic bills and GitHub App are yours, shared with nobody.

Modules run inside the bot's process, so **merging a module grants it the bot's full
authority**: its Discord token, its GitHub App key and its database. Read every pull request
before you merge it, including the ones the agent opens, and never add modules from someone you
would not hand those to.

**[AGENTS.md](AGENTS.md)** is the contract for writing a module, for humans and for the agent.
`src/modules/tags/` is the worked example.

## The afternoon, in one screen

```bash
# 1. This repository: created from the engine's template, pushed to a PRIVATE GitHub repo.
npx guildwright@<version> init my-bot-modules   # or: "Use this template" on bool-/guildwright-template
cd my-bot-modules && git init && git add . && git commit -m "From the template"
npm ci && npm run check                  # green before anything is configured

# 2. Discord Developer Portal: create an application, add a bot, copy the token and the
#    application id, then invite it with the permissions integer printed by:
npx guildwright invite-url --client-id <application id>

# 3. GitHub: register a GitHub App for this bot (below), install it on this repository
#    ONLY, and save its private key as ./secrets/app.pem

# 4. GitHub repository settings, on this repository:
#      Repository secret APPROVAL_HMAC_KEY = <32+ random characters>
#      Install the Claude GitHub App on it (the agent step mints its token through it)

# 5. Configure and start
cp .env.example .env                     # DISCORD_*, GITHUB_OWNER, GITHUB_REPO, GITHUB_APP_ID,
                                         # GITHUB_APP_PRIVATE_KEY_FILE, APPROVAL_HMAC_KEY
npx guildwright doctor    # offline checks + a few GitHub reads; every problem at once
npm start

# 6. In Discord
/credentials set                         # the operator too; there is no owner bypass
/access grant permission:builder.approve user:@someone-else
/request new
```

The rest of this page is each step in full.

## 1. Create the repository

- `npx guildwright@<version> init <dir>` writes this tree into an empty directory,
  pins the engine to the version that wrote it, and generates `package-lock.json` against it.
  (On GitHub, "Use this template" on
  [bool-/guildwright-template](https://github.com/bool-/guildwright-template) gives the same files.)
- Push it to a **private** repository. The bot refuses to start when its target repository is
  public, because every `/request` it files there would be public too.
- `npm ci && npm run check` must be green before you configure anything. `npm run check` is
  typecheck, lint and test, and the test run includes `src/conventions.test.ts`: the engine's
  convention suite, which also checks that `.github/**` and `AGENTS.md` still match the
  installed engine's template.

## 2. Discord

1. [discord.com/developers/applications](https://discord.com/developers/applications) -> New
   Application. **General Information -> Application ID** is `DISCORD_CLIENT_ID`.
2. **Bot -> Reset Token**, copy it once: `DISCORD_TOKEN`. Leave every **Privileged Gateway
   Intent** switched off; nothing in this bot needs one.
3. Your own user id (User Settings -> Advanced -> Developer Mode, then right-click your name ->
   Copy User ID) is `DISCORD_OWNER_ID`.
4. Invite the bot with the URL `npx guildwright invite-url --client-id <id>`
   prints. The permissions integer in it is computed from every `needs:` the installed modules
   declare, so when a pull request adds one, its `## Operator action required` section tells
   you to re-invite with the new integer.

## 3. The GitHub App

Each group registers its own App, so no private key that can reach your repository exists
anywhere but on your bot host.

1. GitHub -> Settings -> Developer settings -> GitHub Apps -> **New GitHub App**.
2. Name: anything unique on GitHub (for example `<your server name> Guildwright`). Homepage URL:
   this repository's URL. **Uncheck Webhook -> Active**: the bot has no inbound HTTP.
3. Repository permissions, exactly:

   | Permission | Access |
   |---|---|
   | Metadata | Read |
   | Issues | Read and write |
   | Actions | Read and write |
   | Pull requests | Read |
   | Contents | Read |
   | Environments | Read and write |
   | Administration | Read and write |
   | Secrets | Read |
   | Variables | Read |

   Everything else "No access"; no organisation or account permissions. Never grant Contents
   write or Workflows: the bot must not be able to edit its own authorization path.
4. "Where can this GitHub App be installed?" -> Only on this account. Create.
5. Copy the **App ID** into `.env` as `GITHUB_APP_ID`.
6. **Generate a private key** and move the downloaded `.pem` to `./secrets/app.pem`, then set
   `GITHUB_APP_PRIVATE_KEY_FILE=./secrets/app.pem`. `secrets/` is git-ignored, and the agent's
   settings deny reading it. For a container, `GITHUB_APP_PRIVATE_KEY` holds the PEM itself with
   `\n` for each newline.
7. **Install App** -> Only select repositories -> this repository. The bot finds the
   installation itself, and refuses to start if the install covers all repositories or lacks a
   permission above.

A fine-grained personal access token (`GITHUB_TOKEN`) still works in place of the App - see
`.env.example` - but it is bound to one person's account and expires, so the bot warns at boot.

## 4. This repository's settings

1. **Repository secret** `APPROVAL_HMAC_KEY` (Settings -> Secrets and variables -> Actions ->
   Repository secrets), with exactly the value you put in `.env`. Generate one with
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. It must be a
   **repository** secret, not an environment secret, or every build is rejected at the approval
   gate. If the two values differ, approvals look like they worked and every build fails with
   "approval token does not match this issue".
2. **Install the Claude GitHub App** on this repository:
   [github.com/apps/claude](https://github.com/apps/claude) -> Install -> Only select
   repositories -> this repository. The agent step exchanges the workflow's OIDC token for the
   App's token and opens its pull request with it; without the install, every build fails at
   the agent step.
3. Optional: the repository variable `AGENT_DAILY_RUN_CAP` (default 4 runs a day) and
   `APPROVAL_MAX_AGE_SECONDS` (default 900).

You do not create any environment by hand: each requester's `user-<discord id>` environment is
created by the bot when they run `/credentials set`. The shared `ai-agent` environment matters
only if you turn `requireOwnCredentials` off (see `.env.example`), and then it must hold a
credential before the bot will start.

## 5. Configure and start

```bash
[ -f .env ] || cp .env.example .env      # never overwrite a .env that already works
npx guildwright doctor    # every problem at once, without logging in to Discord
npm start
```

`.env.example` lists every variable the engine reads, with the GitHub App first. `doctor` checks
the configuration, the engine pin, the single copy of `zod`, module discovery, and (without
`--offline`) the App installation, the repository's privacy, the `APPROVAL_HMAC_KEY` secret and
the gate files, and prints every problem it finds in one pass.

Run exactly **one process per database file**: two bots on one SQLite file run in-flight jobs
twice. For running it long-term (a `Dockerfile` and `compose.yaml` for this repository, systemd,
backups that survive WAL mode, log filtering on `service: "guildwright"`), see the engine's
[setup guide](https://github.com/bool-/guildwright/blob/main/docs/SETUP.md), section 9.

## 6. In Discord

- `/credentials set` - every requester, **including you**, stores their own Anthropic API key or
  Claude Code OAuth token once. The bot seals it into that person's GitHub environment and cannot
  read it back. Builds run on the requester's credentials; there is no owner bypass.
- `/access grant permission:builder.approve user:@someone` - approving a build spends money, so
  nobody can approve until you grant it.
- `/request new` - the idea becomes an issue and an Approve/Reject card; on approval the agent
  opens a pull request here and the card links to it.

## Writing modules

```bash
npm run scaffold -- <module-id> --summary "One line about it." [--db]
npm run check
```

The generated module already compiles, lints and passes its own test. Read
[AGENTS.md](AGENTS.md) before changing it; `src/modules/tags/` is a finished example. A module
imports `#core/*`, its own folder and `zod`, nothing else; `#core/*` resolves into the installed
engine, whose source ships for reading at `node_modules/guildwright/src/core/`.

Every pull request here - yours, or one the agent opens - carries a `## Operator action required`
section listing what only the person running the bot can do. Read it before you merge.

## Upgrading the engine

The engine version and the gate files under `.github/` move together, in one pull request:

```bash
npm install --save-exact guildwright@<new version>
npx guildwright template apply    # rewrites .github/** and AGENTS.md; refuses a dirty tree
npm run check
```

CI's `template-sync` job and the convention suite fail a pull request whose gate files do not
match the pinned engine, and the bot refuses to build while they differ.
