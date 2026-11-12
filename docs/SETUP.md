# Setup

Getting from nothing to a Guildwright bot that turns `/request new` into a pull request against
your own private repository.

Budget about an afternoon the first time. Most of it is clicking around Discord and GitHub; the
command line part is `npx guildwright init`, `npm ci`, filling in `.env`, `npx guildwright doctor`
and `npm start`.

There are exactly **two** steps people get wrong. Both fail in a confusing way, so both are called
out where they occur:

**1. `APPROVAL_HMAC_KEY` must exist twice with the same value** — in `.env` and as a GitHub
**repository** secret (not an environment secret; section 5a explains why). If they differ,
approvals look fine in Discord and every build is rejected. If the repository secret is missing
altogether, the bot now refuses to start and says so.

**2. Nothing in `.env` pays for a build.** The Anthropic credential is not an operator setting.
Every person who wants to use `/request new` — **including you** — runs `/credentials set` in
Discord first, and their own key funds their own builds. There is no owner bypass. A fresh install
where nobody has done that has a working bot that refuses every request, with a message telling the
person exactly what to run. Section 7 is the walkthrough; section 5c is what the shared `ai-agent`
environment is still for.

> The bot needs **no privileged intent**. `/request new` is a slash command, and slash commands and
> modal submissions arrive as interactions, so the bot never asks to read your server's messages.
> If you have set up a Discord bot before and are looking for the Message Content toggle: you do
> not need it.

---

## 0. How the pieces fit

| Piece | What it is | Who owns it |
|---|---|---|
| **The engine** | The npm package `guildwright`: the core, the adapters, the built-in modules (`access`, `admin`, `builder`, `credentials`, `help`, `ping`, `repos`), the CLI and the module-repository template. Public, at [bool-/guildwright](https://github.com/bool-/guildwright). | the engine maintainer |
| **Your module repository** | A **private** GitHub repository made from the template: your modules under `src/modules/`, the CI and agent gate files under `.github/`, `AGENTS.md`, and a `package.json` that pins the engine to one exact version. The bot files issues here and the agent opens pull requests here. | you |
| **Your bot process** | `npm start` (or a container) run **from a checkout of your module repository**, with your `.env`, your SQLite database under `data/` and your GitHub App key under `secrets/`. | you |
| **Your GitHub App** | Registered by you, installed on your module repository only. The bot mints its GitHub tokens from it. | you |

**One instance, one trust domain.** A bot process runs the modules in one module repository, for
one group of people who trust each other's code. Modules are in-process TypeScript: the type-level
rules in `AGENTS.md` are review aids, not a sandbox, so **merging a module grants it the bot's full
authority** — its Discord token, its GitHub App key and its database. Never run someone else's
modules in your bot, and never point your bot at someone else's repository. A group that wants its
own modules runs its own bot, from its own module repository, with its own GitHub App. That is the
whole design, and it is why nothing here offers to host other people's modules.

One process may still serve several Discord servers, and may build into several repositories you
own (section 8). That is several servers, one trust domain.

---

## 1. Prerequisites

| Need | Check |
|---|---|
| Node.js **24.12+** | `node --version` |
| A Discord account that can create applications | |
| A GitHub account that can own a **private** repository and register a GitHub App | |
| Somewhere to run the bot: a machine that stays up, with Docker or Node | section 9 |
| A Claude Pro/Max subscription **or** an Anthropic API key, per person who wants to build | handed to the bot in section 7, not put in `.env` |

<details>
<summary>What the engine pulls in, and why <code>libsodium-wrappers</code> is on the list</summary>

The engine has four runtime dependencies — `discord.js`, `octokit`, `pino` and
**`libsodium-wrappers`** — plus `zod` as a peer dependency your module repository pins at the same
exact version (two copies of `zod` make every module manifest fail to typecheck, so `doctor` and
`start` refuse to run with two).

`libsodium-wrappers` is the only one that is not obvious, so: GitHub requires environment secrets
to be encrypted with **`crypto_box_seal`** (X25519 + XSalsa20-Poly1305) before they are sent.
Node's own `node:crypto` cannot do it — measured on v24.16.0 / OpenSSL 3.5.6,
`crypto.getCiphers()` contains no salsa cipher at all, and
`createHash('blake2b512', { outputLength: 24 })` throws, because a sealed box's nonce needs the
digest length baked into BLAKE2b's parameter block rather than a truncated 64-byte digest. Node
can do the X25519 half and nothing else.

That matters more than a missing-feature note usually would, because **GitHub answers `201` to
any well-formed base64 body without ever checking that it decrypts**. A hand-rolled composition
that got one detail wrong would look like success at the API and surface half an hour later as an
opaque auth failure inside somebody else's build, with no path back to the write that caused it.
`crypto_box_seal` is a named primitive; the alternative is a protocol we could get subtly wrong.

</details>

---

## 2. Create your module repository

Either generate it with the CLI:

```bash
npx guildwright@1.0.0 init my-bot-modules     # any empty directory; pins the engine to 1.0.0
cd my-bot-modules
git init && git add . && git commit -m "From the Guildwright template"
```

or, on GitHub, open [bool-/guildwright-template](https://github.com/bool-/guildwright-template) →
**Use this template** → **Create a new repository**, and clone it. Both give the same files:
`init` writes the engine's `template/` directory (the template repository is generated from it
by the engine's release workflow) and generates `package-lock.json` against the published engine.

Then:

1. **Push it to a private repository** on GitHub. The bot refuses to start when its target
   repository is public, because every `/request` it files there would be public too
   (`ALLOW_PUBLIC_TARGET_REPO=true` overrides that, on purpose only).
2. Install and run the gate:

   ```bash
   npm ci
   npm run check     # typecheck -> lint -> test. Green before you configure anything.
   ```

   If `npm run check` is green, the code is fine and everything after this is configuration. The
   test run includes `src/conventions.test.ts`, the engine's convention suite, which also checks
   that `.github/**` and `AGENTS.md` still match the template of the engine you pinned.

What is in the repository, and what each part is for:

| Path | Purpose |
|---|---|
| `src/modules/tags/` | The worked example module (`/tag get`, `/tag set`). Keep it, change it or delete it. |
| `src/modules/<id>/` | Your modules. `npm run scaffold -- <id>` generates one. |
| `src/conventions.test.ts` | Two lines that run the installed engine's convention suite. |
| `src/engine.d.ts` | `import 'guildwright/events';` so your modules can subscribe to the built-ins' events. |
| `.github/workflows/agent-implement-request.yml`, `.github/scripts/verify_approval.py`, `.github/claude/agent-settings.json` | The build workflow and its gates. **Byte-identical to the engine's**; the bot refuses to build while they differ. |
| `.github/workflows/ci.yml` | `check`, the two pull-request body jobs, and `template-sync`. |
| `AGENTS.md` | The contract for writing a module, for humans and for the agent. |
| `.env.example` | Every variable the engine reads (section 6). |

---

## 3. Create the Discord application

1. Go to the [Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN`. It is shown once.
3. **No privileged intents needed.** Leave every toggle under **Privileged Gateway Intents**
   switched off — the bot only uses interactions.
4. **General Information** tab → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
5. Get your own Discord user ID for `DISCORD_OWNER_ID`: enable
   **Settings → Advanced → Developer Mode**, then right-click your name → **Copy User ID**.

### Invite it to your server

```bash
npx guildwright invite-url --client-id <application id>
```

It prints the permissions integer and the invite URL. The integer is computed from the union of
every `needs: [...]` that the installed modules declare — the built-ins and yours — so it is
always the minimum this bot can work with, and the bot never asks for Administrator. When a pull
request adds a permission to a `needs:` array, its `## Operator action required` section tells
you to run this again and **re-invite** the bot with the new integer.

---

## 4. Register the GitHub App

Each group registers **its own** App. The private key has to live on the bot host, because that
is where tokens are minted, so one App shared between groups would put one key that can reach
every group's repository on every group's machine.

### 4a. The App (the documented setup)

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **GitHub App name:** anything unique on GitHub. Suggested: `<your server name> Guildwright`.
   **Homepage URL:** your module repository's URL. **Uncheck Webhook → Active**: the bot has no
   inbound HTTP and never receives webhooks.
3. **Repository permissions**, exactly these, everything else "No access", and no organisation or
   account permissions:

   | Permission | Access | Why |
   |---|---|---|
   | Metadata | Read | mandatory for every App |
   | Issues | Read and write | file, label, comment on, close **and reopen** requests; read the issue body the approval is bound to |
   | Actions | Read and write | dispatch the build workflow, count today's runs for the daily cap, poll the run and **cancel** it |
   | Pull requests | Read | find the pull request the agent opened |
   | Contents | Read | resolve `GITHUB_REF` at boot, and read the three gate files at the dispatch ref before every build. **Read only, never write**: the bot must not be able to push |
   | Environments | Read and write | check which environment can pay before spending anything, and store each user's own credential (`/credentials set`) |
   | Administration | Read and write | *create* a user's `user-<discord id>` environment. GitHub gates environment creation on Administration, not on Environments |
   | Secrets | Read | check at boot that the `APPROVAL_HMAC_KEY` repository secret exists (names and dates only; a secret's value can never be read) |
   | Variables | Read | compare `AGENT_DAILY_RUN_CAP` with the bot's own cap and report drift in `/status` |

   Never grant **Contents: write** or **Workflows**: the bot must not be able to edit its own
   authorization path. The bot checks the installation's permissions at boot and refuses to start,
   naming each one, if any of the nine is missing or too weak.

   > **About Administration.** It is wider than its one use: Administration write lets a
   > compromised bot change repository settings. Two things bound that: the App is installed on
   > selected repositories only (below), and the engine's tests allow-list every GitHub route the
   > adapter calls, so a new Administration call is a red test rather than a quiet addition.

4. **Where can this GitHub App be installed?** → **Only on this account**. Create.
5. Copy the **App ID** from the App's settings page. This is `GITHUB_APP_ID`.
6. **Generate a private key.** Move the downloaded `.pem` into your module repository as
   `./secrets/app.pem` and set `GITHUB_APP_PRIVATE_KEY_FILE=./secrets/app.pem`. `secrets/` is
   git-ignored and Docker-ignored, and the agent's settings deny reading it. Where a file is
   awkward, `GITHUB_APP_PRIVATE_KEY` holds the PEM itself instead, with `\n` for each newline.
7. **Install App** → **Only select repositories** → your module repository. The bot finds the
   installation itself (`GITHUB_APP_INSTALLATION_ID` pins it and skips the lookup, never the
   checks), and **refuses to start if the installation covers all repositories**: Administration
   write across a whole account is not a blast radius this bot should hold.

At boot the bot logs `github app installation resolved` with the installation id and the granted
permissions, and `/status` shows `GitHub: app <slug> on owner/repo, installation N`.

### 4b. A personal access token instead (the fallback)

A fine-grained personal access token still works in place of the App: set `GITHUB_TOKEN` and
**none** of the `GITHUB_APP_*` variables (both modes at once refuses to start). It is the fastest
"does this work at all" path for a solo operator, and scoped to one repository it is the same
blast radius. It is bound to one person's account and expires, so the bot logs a warning at boot,
warns again 14 days before expiry, and `doctor` nudges you toward the App.

Create it at
[Settings → Developer settings → Fine-grained tokens](https://github.com/settings/tokens?type=beta),
scoped to **only** your module repository, with these **Repository permissions**:

| Permission | Access | Note |
|---|---|---|
| Issues | Read and write | as for the App |
| Actions | Read and write | as for the App |
| Pull requests | Read | as for the App |
| Contents | Read | as for the App. Without it the gate-file check cannot read the workflow, and every build is refused |
| Environments | Read and write | as for the App |
| Administration | Read and write | as for the App |
| **Secrets** | **Read** | **required.** Without it the bot cannot check the `APPROVAL_HMAC_KEY` repository secret, and refuses to start naming `Secrets: read` |
| Variables | Read | optional for a PAT: without it `/status` says the repository cap could not be read, and nothing else changes |
| Metadata | Read | mandatory for any fine-grained token |

It does **not** need `workflow` scope — the bot never pushes workflow files, and deliberately
cannot.

### Environments is not Secrets, and the bot needs both

This is the most confusing thing on this page, so it is worth thirty seconds now rather than an
afternoon later.

- **Secrets** covers only *repository-level* Actions secrets, `/repos/{owner}/{repo}/actions/secrets/*`.
  The bot reads exactly one thing there: whether `APPROVAL_HMAC_KEY` exists. Read access is
  enough, and is required.
- **Environments** governs *environment* secrets, `/repos/{owner}/{repo}/environments/{name}/secrets/*`.
  Every Anthropic credential the bot stores is one of those, in the requester's own
  `user-<discord id>` environment. Granting `Secrets: write` and trying `/credentials set` again
  gets you the identical 403.
- **Administration** creates an environment in the first place. `PUT /repos/…/environments/{name}`
  is the first call `/credentials set` makes, so a grant with Environments but not
  Administration fails on that first call, while the error still says "Environments" — true, but
  not the whole answer.

If you are reading *"check the token repository permissions (contents, issues and actions)"*, that
is a different 403, and those three really are what to look at.

---

## 5. Configure the module repository on GitHub

### 5a. `APPROVAL_HMAC_KEY`, as a repository secret

Generate the key once:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Add it under **Settings → Secrets and variables → Actions → *Repository* secrets** as
`APPROVAL_HMAC_KEY`, and put the **same value** in `.env` (section 6).

**Not** an environment secret. The approval gate runs inside whichever environment the build
selected, and once anyone brings their own credentials that is `user-<discord-id>`, not
`ai-agent`. A key stored only on an environment resolves to an empty string in every other run,
and the gate then rejects them all with a key-length error that has nothing to do with the
approval. A repository secret resolves in all of them.

If the two values differ, Discord approvals look like they worked and every build fails at the
gate with *"approval token does not match this issue"*. That is the symptom to remember. If the
repository secret is missing, the bot refuses to start and names it.

### 5b. Install the Claude GitHub App

[github.com/apps/claude](https://github.com/apps/claude) → **Install** → **Only select
repositories** → your module repository. The agent step exchanges the workflow's OIDC token for
that App's token and opens its pull request with it. Without the install every build fails at the
agent step, and the run report says `failed_step: agent`.

### 5c. Who pays, and what `ai-agent` is still for

`modules.builder.requireOwnCredentials` defaults to `true`. With it on:

- every requester funds their own build from the credential they stored with `/credentials set`;
- the shared `ai-agent` environment is **unreachable from a user request** — the bot refuses at
  `/request new` and refuses again at dispatch, so a credential cleared in between still cannot
  reach it;
- you create **no** environment by hand: each `user-<discord id>` environment is created by the
  bot the first time that person runs `/credentials set`.

Set a credential on `ai-agent` in exactly one case: you run a private server, you want to fund
every build yourself, and you have therefore set

```
MODULES_JSON={"builder":{"requireOwnCredentials":false}}
```

Then create the environment (**Settings → Environments → New environment**, named exactly
`ai-agent`) and put `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` on it. With the switch off
**the bot refuses to start** until that environment exists and holds a credential, rather than
discovering it per build. `ai-agent` then funds anyone who has not run `/credentials set` — and
"anyone" means anyone who can type `/request new` in any server the bot is in. `/status` tells you
which of the two modes is live.

#### Choosing between a subscription and an API key

The choice is the same in both modes; only *where you put the value* differs. With
`requireOwnCredentials` on (the default) each person hands theirs to the bot with
`/credentials set` (section 7); with it off you put one on `ai-agent`.

**API key** — `ANTHROPIC_API_KEY`. Create one at
[console.anthropic.com](https://console.anthropic.com) → API Keys. It starts `sk-ant-api…`.
Metered, and separate from your personal usage, which is the right choice once more than one
person can trigger builds. A spend-limited key per group is the recommendation: anyone with admin
on a repository can, in effect, read the environment secrets its workflows use.

**Claude Pro/Max subscription** — `CLAUDE_CODE_OAUTH_TOKEN`. There is **no web page** for this and
nothing can generate it for you: it comes from an interactive login against your own subscription,
so you run it yourself, in your own terminal, with the Claude Code CLI installed:

```bash
claude setup-token
```

It prints a token starting `sk-ant-oat…`. Paste it into `/credentials set` — or, with the switch
off, into the `ai-agent` environment secret. Build usage comes out of the subscription's limits,
which are **shared with your own interactive Claude Code usage**, so a long build eats into what
you have left that day. If you just want this working, use the API key.

<details>
<summary>Other providers, and why not OpenRouter</summary>

The action supports five ways to reach the model, and **all five serve Claude**:
`anthropic_api_key`, `claude_code_oauth_token`, `use_bedrock` (Amazon), `use_vertex` (Google),
`use_foundry` (Microsoft), plus OIDC workload-identity federation for orgs that want no static key
at all. Bedrock/Vertex/Foundry are worth it only if you already have credits there or need data
residency — same models, more setup.

There is no OpenAI or OpenRouter mode, and that is not an oversight. The build step is not "call an
LLM", it is **Claude Code**: an agentic harness that edits files, runs bash and loops on tools. It
is not model-agnostic, so swapping providers is not a config change — it is replacing the whole
build step with a different agent, along with its prompt-injection surface and tool allow-list.

A router like OpenRouter also has a specific cost here that it would not have elsewhere: every
prompt carries your source code, so routing through an extra party is a real disclosure for a tool
whose entire job is reading and writing your repo. Price arbitrage across models is the wrong trade
for that.

</details>

### 5d. Optional repository variables

**Settings → Secrets and variables → Actions → Variables**:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_DAILY_RUN_CAP` | 4 | Agent runs per UTC day, enforced by the workflow. Keep it equal to `modules.builder.dailyRunCap`; see "What it costs to run". |
| `APPROVAL_MAX_AGE_SECONDS` | 900 | How old a signed approval may be when its run starts. Raise it only if builds queue for longer than 15 minutes. |

### 5e. Put a human between the agent and `main`

The agent opens pull requests directly, so you want a review gate. **Branch rulesets need GitHub
Pro on a private repository** — on a free account `Settings → Rules` returns 403. Without them,
the protections that still apply are: the agent has no `workflows` permission so it cannot touch
`.github/**`, the post-hoc path gate fails the run if the diff does, CI's `template-sync` and the
convention suite fail a pull request whose gate files drift, and merging is a manual act you
perform. Read the `## Operator action required` section of every pull request before you merge it.

---

## 6. Configure and start the bot

In your module repository:

```bash
# NON-DESTRUCTIVE on purpose: never overwrite a .env that already works. Overwriting a working
# APPROVAL_HMAC_KEY with the placeholder is the fastest way to cause the failure this page opens
# by warning about.
[ -f .env ] || cp .env.example .env
```

Fill in the required values (App mode shown; for a PAT, `GITHUB_TOKEN` replaces the two App lines):

| | |
|---|---|
| `DISCORD_TOKEN` | section 3 |
| `DISCORD_CLIENT_ID` | section 3 (Application ID) |
| `DISCORD_OWNER_ID` | section 3 (your user ID) |
| `GITHUB_APP_ID` | section 4a, step 5 |
| `GITHUB_APP_PRIVATE_KEY_FILE` | section 4a, step 6: `./secrets/app.pem` |
| `GITHUB_OWNER` | the account owning your module repository, e.g. `my-group` |
| `GITHUB_REPO` | the repository name alone, no owner, e.g. `my-bot-modules` |
| `APPROVAL_HMAC_KEY` | section 5a — must equal the repository secret |

Then check everything at once, without logging in to Discord:

```bash
npx guildwright doctor
```

`doctor` parses the configuration and every module's own config, checks the engine pin and the
single copy of `zod`, discovers the modules (with the boot import scan), and then — unless you pass
`--offline` — makes the same GitHub reads the boot does: the App and its installation, the
repository's privacy, the `APPROVAL_HMAC_KEY` secret, the environments, the workflow, the ref and
the gate files. It prints **every** problem it finds in one pass and exits 1 if there is any.

```bash
npm start
```

`npm start` runs `guildwright start`, which reads `./.env` when it exists (a variable already set
in the process environment wins) and starts the bot. On a good start you see the build identity
(`guildwright: engine guildwright@1.0.0 · my-bot-modules@0.1.0 (a1b2c3d) on node v24.16.0`), the
modules load and the gateway connect. On a bad one you get a sentence telling you what is wrong —
the bot names **every** missing variable at once rather than making you fix them one restart at a
time:

```
guildwright cannot start: The bot is misconfigured.
  where: env

  ✖ Invalid input: expected string, received undefined
    → at DISCORD_TOKEN
  ...
  what to do: Set the missing environment variables and restart. See .env.example.
```

Every refusal to start begins `guildwright cannot start:`, so that is the line to grep for.

### Every environment variable

`.env.example` documents each of these in full, with the GitHub App first. This is the summary.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `production` or `test`. Affects logging defaults only. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. Secrets are redacted at every level. |
| `DISCORD_TOKEN` | **yes** | | The bot token (section 3). |
| `DISCORD_CLIENT_ID` | **yes** | | The application id (section 3). |
| `DISCORD_OWNER_ID` | **yes** | | Your user id: the one account that can always act, with no grants. |
| `DISCORD_DEV_GUILD_ID` | no | | Register commands to this one server, instantly, instead of globally. Leave it out in production; never set it empty. |
| `DISCORD_MESSAGE_CONTENT` | no | `false` | Request the privileged MessageContent intent. Only for a module with a `$prefix` message hook; with a hook and this off, the bot refuses to start. |
| `GITHUB_APP_ID` | App mode | | The App ID (section 4a). |
| `GITHUB_APP_PRIVATE_KEY_FILE` | App mode, or the next one | | Path to the App's `.pem`. |
| `GITHUB_APP_PRIVATE_KEY` | App mode, or the previous one | | The PEM itself, `\n` for each newline. Exactly one of the two. |
| `GITHUB_APP_INSTALLATION_ID` | no | looked up | Pins the installation; skips the lookup, never the checks. |
| `GITHUB_TOKEN` | PAT mode | | A fine-grained PAT (section 4b). Exactly one of `GITHUB_TOKEN` or `GITHUB_APP_ID`. |
| `GITHUB_OWNER` | **yes**, unless `GITHUB_REPOS_JSON` | | Owner of the module repository. |
| `GITHUB_REPO` | **yes**, unless `GITHUB_REPOS_JSON` | | Name of the module repository. |
| `GITHUB_WORKFLOW_FILE` | no | `agent-implement-request.yml` | The workflow dispatched on approval. |
| `GITHUB_REF` | no | `main` | The ref whose copy of the workflow runs. |
| `GITHUB_REPOS_JSON` | no | | Several repositories (section 8). Replaces the four variables above and `GITHUB_APP_INSTALLATION_ID`. |
| `APPROVAL_HMAC_KEY` | **yes** | | 32+ characters, equal to the repository secret (section 5a). |
| `ALLOW_PUBLIC_TARGET_REPO` | no | `false` | `true` lets the bot build in a public repository. |
| `DATABASE_PATH` | no | `./data/bot.sqlite` | The SQLite database. Back it up (section 9); never on a network share. |
| `MODULES_JSON` | no | `{}` | Per-module configuration, one JSON object keyed by module id. |
| `MODULES_DISABLE` | no | | Comma-separated module ids to skip, before import: the escape hatch for a broken module. |
| `MODULE_DIRS` | no | `./src/modules` | Where this repository's modules are. A directory you name that does not exist stops the bot. |
| `MODULES_BUILTIN` | no | `true` | `false` drops every built-in module, including `/request`. For engine tests; leave it alone. |

`MODULES_JSON` is where module behaviour is set, for example
`MODULES_JSON={"builder":{"allowSelfApproval":true,"dailyRunCap":4}}`. The builder's keys that
matter most are `requireOwnCredentials` (section 5c), `allowSelfApproval` (section 7),
`approvalTtlMs`, `maxConcurrentPerGuild`, `maxConcurrentPerRepo` and `dailyRunCap`.
`builder.ref` and `builder.workflowFile` no longer exist; they are ignored with a warning, and
`GITHUB_REF` / `GITHUB_WORKFLOW_FILE` are the only source.

### The CLI

Every command runs from the module repository's root, through the pinned engine:

| Command | What it does |
|---|---|
| `npx guildwright start` | Load `./.env` if present, then run the bot. `npm start` runs this. |
| `npx guildwright doctor [--offline]` | Check config, modules, versions and GitHub without starting. `npm run doctor` runs this. |
| `npx guildwright invite-url [--client-id <id>]` | Print the permissions integer and the invite URL. |
| `npx guildwright scaffold <id> [--summary "..."] [--db] [--force]` | Generate a module under `src/modules/<id>/` that is already green. `npm run scaffold -- <id>` runs this. |
| `npx guildwright init <dir> [--existing]` | Write the template into an empty `<dir>`; `--existing` converts the repository there (section 11). |
| `npx guildwright template check` | Do `.github/**` and `AGENTS.md` match the installed engine's template? CI's `template-sync` runs this. |
| `npx guildwright template apply` | Rewrite them from the installed engine. Refuses a dirty working tree. |
| `npx guildwright gc-approvals [--older-than 90d] [--yes] [--repo <key>]` | List, and with `--yes` delete, consumed `refs/approvals/*` refs older than the cutoff. Never automatic. |

---

## 7. Use it

### First: store a credential. This is not optional, and it applies to you.

```
/credentials set
```

A **modal** opens with one field. Paste either credential shape from section 5c and submit. The
reply is ephemeral and names only *which* secret was stored, because the bot cannot read the value
back.

**Do this before `/request new`, including for your own account.** With
`modules.builder.requireOwnCredentials` at its default of `true`, `/request new` is refused for
anyone who has stored nothing, and there is deliberately **no owner bypass** — "no free builds"
with a silent exemption for whoever holds the bot token is not the rule it claims to be, and the
exemption would be discovered in a bill.

If you skip it, this is what you get, privately, and nothing is filed:

```
Builds here run on your own Anthropic credentials, and you have not stored any.
Run /credentials set and paste either an Anthropic API key (sk-ant-api...) from
console.anthropic.com, or a Claude Code OAuth token (sk-ant-oat...) from running
`claude setup-token`.
```

That refusal happens at **modal submit**, before any GitHub issue is filed and before any card is
posted — so a refused request leaves nothing behind for anyone to clean up. The cost is that you
find out after typing your request rather than before the dialog opens; `/request new` opens a
modal and Discord forbids doing any work before showing one.

### Then: file a request

In a channel the bot can see:

```
/request new
```

A dialog opens asking for a **Title** and **What should it do?** (a full-size text box, up to 4000
characters). Fill it in and submit.

What happens:

1. The bot checks you have a credential stored. **No credential, no issue, no card, no spend** —
   you get the message above and nothing else happens.
2. It validates, redacts anything token-shaped, and rate-limits the submission.
3. It files a GitHub issue, with your text wrapped inside a per-issue nonce fence.
4. It posts an **Approve / Reject** card. Only an approver can press it — and by default **not the
   person who asked**, since asking and approving are separate permissions.
5. **Approve** checks the gate files and dispatches the workflow — but not before **re-reading**
   your credential. That second check is not redundant: approval can be minutes or days after the
   request, and a key you cleared or revoked in between would otherwise have become a run somebody
   else funded. Claude Code then implements the issue on `agent/req-<id>` and opens a pull
   request, billed to **your** environment.
6. The bot polls and posts the outcome back to the channel **as a new message that @-mentions
   you**. Builds take 5–30 minutes; it is a new message rather than an edit of the card because a
   Discord interaction token expires after ~15 minutes — and, just as importantly, because an
   edit notifies nobody.
7. **Reject** closes the issue as `not_planned` and nothing is built or spent.

> **About that mention, because a bot that can ping is a bot worth checking.** It pings exactly
> one user: the requester, from the Discord id the bot persisted on the request row when it was
> filed. The message is sent with `allowed_mentions: { parse: [], users: [<that id>] }` —
> `parse: []` is unchanged, so `@everyone`, `@here` and role pings stay *structurally*
> impossible, not merely discouraged. The id is never read out of anybody's text, so no request
> body can make the bot ping someone else. If you want no ping at all, mute the channel.

Two costs, two payers: the **Anthropic tokens** come out of the requester's credential; the
**GitHub Actions minutes** come out of the repository owner's allowance. `requireOwnCredentials`
moves the first, not the second — which is why the workflow's daily run cap still matters. See
"What it costs to run" below.

### After you have asked: `/request list`, `cancel`, `retry`

| Command | What it does |
|---|---|
| `/request list` | Your requests in this server, newest first: the state each is in, how long it has been there, and the links (issue, run, pull request) that state has produced. Anyone holding `builder.approve` sees everyone's. |
| `/request cancel` | Withdraws a request of yours (an approver may withdraw anybody's). The issue is closed `not_planned`, the card is rewritten with its buttons disabled, and the concurrency slot is freed immediately. If it is already building, the bot also **asks GitHub to cancel the run**, so a build you no longer want stops spending your credits rather than only stopping being watched. |
| `/request retry` | Runs a **failed** build again, or puts an **expired** request back in front of an approver, reopening its issue — without retyping and without a second issue. |

- **A retry is a fresh request for spend purposes.** It re-checks the requester's credential, the
  concurrency caps and the daily build cap, it is rate-limited like a submission, and it is bounded
  by `maxRetries`. A failed build is re-dispatched with a freshly minted approval id; an expired
  request was never approved, so it goes back to `awaiting_approval` on a new card and a human
  still has to click Approve.
- **Retry is offered for failures, not for outcomes you dislike.** A request that reached
  `pr_open` or `done` produced a pull request or a documented refusal; the answer to "the PR is
  wrong" is a new `/request new` describing what is wrong.

`/request list` is also the honest answer to "is it stuck?". A request sitting in `running` with
its run link is a build that is still going; one sitting in `awaiting_approval` for a day is
waiting on a human, and `/access list` will tell you which human.

### Seeing what the bot is doing: `/status`, `/admin jobs`, `/admin audit`

| Command | What it shows |
|---|---|
| `/status` | Which build is running (engine version, module repository version and commit), how the bot authenticates to GitHub, each module's health, which payment mode is live, and per repository whether builds are enabled and why not. |
| `/admin jobs` | The job system's own counters — queued, running, dead-lettered, scheduled — and the oldest running job's age. This is where "the build card never updated" separates into "still running" and "died two hours ago". |
| `/admin audit` | The most recent audit rows for this server: who approved, rejected, granted, revoked, stored or cleared what, and when. Pageable and filterable. |

`/admin` is gated on `admin.view`, whose fallback is `guild-admin`. Neither command can change
anything. They are windows, not levers: the levers are `/access`, `/request cancel` and the GitHub
UI.

### Your first build, if you are testing alone

A solo install needs **two** things that a multi-person one does not:

1. **You have run `/credentials set`.** There is no owner bypass.
2. **You can approve your own request.** By default you cannot: `builder.approve` has fallback
   `nobody`, and asking and approving are separate on purpose. Pressing Approve on your own
   request gets `Ask someone else to approve your own request.`

Pick one:

- **Grant somebody the approver permission, from inside Discord:**

  ```
  /access grant permission:builder.approve user:@reviewer
  /access grant permission:builder.approve role:@maintainers
  ```

  No restart, no `.env` edit. `/access` is itself gated on `access.manage`, whose fallback is
  `guild-admin`, so any server manager can run it out of the box.

- **Have a second person file the request.** You can approve anyone else's.

- **Or, if you are genuinely alone, allow self-approval** in `.env` and restart:

  ```
  MODULES_JSON={"builder":{"allowSelfApproval":true}}
  ```

  Turn it back off once a second approver exists. Prefer `/access grant` wherever you have anybody
  at all to grant to: it survives restarts, it is audited, and it does not weaken the review rule
  for everyone in order to unblock one person.

Keep the three decisions separate: `/access grant` is about **who may approve**,
`allowSelfApproval` is about **whether asking and approving may be the same person**, and
`requireOwnCredentials` is about **money**.

### The three `/access` commands

| Command | What it does |
|---|---|
| `/access list` | Every permission key any installed module declares, who is explicitly granted it here, and what happens when nobody is. |
| `/access grant` | Gives a key to **one** user or **one** role. The `permission` option autocompletes from the live registry. |
| `/access revoke` | Takes it back. Says "nothing to revoke" — distinctly from "revoked" — when the grant was not there. |

All three are ephemeral, guild-only, and gated on `access.manage` (fallback `guild-admin`).

- **The key must be one a module really declared.** A typo is refused, not stored.
- **Read the `default` column on `/access list`.** A key whose default is `nobody` and whose
  "granted to" column is `-` works for **no one** — not even a server manager. That is the state
  `builder.approve` and `repos.manage` ship in, deliberately.
- **Grants are per server.** Nothing here is global except the single `DISCORD_OWNER_ID` bypass.

### Requests expire after 48 hours

An **unapproved** request does not sit in the queue forever. An hourly sweep moves any request
still `awaiting_approval` after `approvalTtlMs` (default **48 hours**) to `expired`: it closes the
GitHub issue as `not_planned` and rewrites the card with its buttons disabled. Nothing is built and
nothing is spent.

This matters because `maxConcurrentPerGuild` (default **2**) counts requests that are *waiting for
an approver* as well as builds that are running. If you hit the cap, the refusal tells you which
situation you are in:

> 2 requests are still waiting for an approver here, and nothing is actually building. Ask an
> approver to approve or reject them — an unapproved request only clears itself after 48 hours.

To change the window: `MODULES_JSON={"builder":{"approvalTtlMs":86400000}}`. Shortening it below a
working day is usually a mistake — an approver is a human in another timezone.

### The three `/credentials` commands

| Command | What it does |
|---|---|
| `/credentials set` | Opens a **modal** and stores your own Anthropic API key or Claude Code OAuth token. **Required before `/request new` works.** Run it again to replace what is there. |
| `/credentials status` | Names which of your credentials are stored. Never shows a value — nothing can. |
| `/credentials clear` | Removes them. **This takes `/request new` away from you** until you set one again, and a request already approved but not yet started will fail too. The reply says so. |

Every reply is ephemeral.

**The bot stores neither credential.** It is sealed to GitHub's public key in memory and written
straight into a per-user GitHub environment named `user-<your discord id>`, which is *write-only*
— there is no REST endpoint that returns a stored secret, so there is nothing in the bot's
database to leak. It is a **modal**, not a command option, so the value never enters a channel or
anybody's scrollback.

Be honest with your requesters about one thing, which the modal also says: anyone with admin on
the module repository can, in effect, read an environment's secrets by writing a workflow step
that prints them. That is the trust relationship of handing any CI system a key, and no engine
change can remove it. A spend-limited key is the right thing to hand over.

> **The `/credentials` module cannot see the builder's setting.** Modules never import each other,
> so its wording leads with the default (`requireOwnCredentials: true`). If you turned the switch
> off, read "your builds will be refused" as "your builds will fall back to `ai-agent`".
> `/status` is the authority on which mode is live.

---

## 8. Building in several repositories (optional)

**Skip this section if the bot builds in one repository.** `GITHUB_OWNER`/`GITHUB_REPO` define a
one-repository set, nothing here changes for it, and `/status` reads exactly as before.

One bot can serve several Discord servers that build into **different** repositories — say your
own server builds into `acme/bot-modules` and a friend's server into `acme/events-modules`. Every
repository is one *you* configured and own; the bot never reaches a repository that is not listed.
All of them are one trust domain: they share one bot process, one database and one App key, and
the modules that run are the ones in the checkout the bot was started from.

### Configure the set

Replace the single-repository lines in `.env` with one line of JSON. When `GITHUB_REPOS_JSON` is
set, **delete** `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_REF`, `GITHUB_WORKFLOW_FILE` and
`GITHUB_APP_INSTALLATION_ID` — the bot refuses to start with both, so there is only one source.

```
GITHUB_REPOS_JSON={"main":{"owner":"acme","repo":"bot-modules","default":true},"events":{"owner":"acme","repo":"events-modules"}}
```

- The keys (`main`, `events`) are short names you choose: a lowercase letter, then lowercase
  letters, digits or dashes. They are what `/repo use` and `/credentials set repo:` take.
- `ref` and `workflowFile` default to `main` and `agent-implement-request.yml`, per entry.
  `installationId` is optional and App-only; leave it out and the bot looks it up.
- **At most one** entry is `"default": true`: where a server builds until you link it elsewhere.
  With no default, a server builds nothing until you run `/repo use` in it.

Moving an existing one-repository install onto `GITHUB_REPOS_JSON` under a key such as `main` is
safe: requests already filed are re-keyed at boot to the repository their issue really lives in.

### Prepare every repository

Each listed repository passes **every** boot check on its own (sections 4 and 5), so each one
needs:

1. **The GitHub App installed on it** with the section 4a permissions (or, in PAT mode, the token
   granted on it with the section 4b permissions). With an App, one installation on "Only select
   repositories" can cover several of them; an installation on *all* repositories is refused.
2. **To be private**, or `ALLOW_PUBLIC_TARGET_REPO=true`.
3. **The `APPROVAL_HMAC_KEY` repository secret**, with the **same** value as the bot's `.env`.
4. **The Claude GitHub App** installed on it.
5. **The template `.github` files** (`agent-implement-request.yml`, `verify_approval.py`,
   `agent-settings.json`), byte-identical to the template of the engine the bot runs. A drifted
   copy disables builds in that repository only; `/status` says which. The easiest way to get them
   right is to make every repository a module repository (section 2) on the same engine pin, and
   to run `npx guildwright template check` in each.
6. Optionally, the **`AGENT_DAILY_RUN_CAP`** variable, set to the same value as
   `modules.builder.dailyRunCap` — see "What it costs to run". It is read per repository.

### Point each server at its repository: `/repo`

| Command | Who | What it does |
|---|---|---|
| `/repo use key:<key>` | operator only by default (`repos.manage`, fallback `nobody`) | Links this server to one configured repository. New requests from the server are filed and built there. |
| `/repo show` | server admins by default (`repos.view`) | The link, the repository's health, how many of its builds are dispatched against `maxConcurrentPerRepo`, today's runs against the daily cap, and whether its `AGENT_DAILY_RUN_CAP` agrees. |
| `/repo clear` | `repos.manage` | Removes the link (the server falls back to the default repository, if any). Refused while the server has a request in flight. |

Run `/repo use` in each server that should not build in the default repository. **A request stays
in the repository it was filed in:** re-linking a server mid-build does not move a build, a
cancel or a retry.

### Credentials are per repository

A credential lives in a GitHub environment, and environments belong to one repository. So
**every user runs `/credentials set` once per repository they build in**:

- in a server, `/credentials set` stores into **that server's** repository (the modal names it);
- in a DM with the bot, `/credentials set repo:<key>` stores into the repository you name;
- `/credentials status` in a DM lists every repository, and `/credentials clear everywhere:True`
  clears all of them.

### Caps, per repository

| Setting | Scope | Default | What it bounds |
|---|---|---|---|
| `maxConcurrentPerGuild` | each server | 2 | Requests one server holds at once, including ones waiting for an approver. Counted when a request is filed. |
| `maxConcurrentPerRepo` | each repository | 2 | Builds **dispatched** in one repository at once, from every server routed there. Counted when Approve is clicked or `/request retry` re-dispatches. |
| `dailyRunCap` | each repository | 4 | Agent runs per UTC day, counted in that repository. |

**Why `maxConcurrentPerRepo` exists.** The workflow's concurrency group keeps one running build
and **one** pending one; GitHub silently cancels the older pending run when a third is queued. So
two servers sharing a repository could each approve a build and have one of them cancelled with no
explanation. Past the cap, the Approve click is refused instead — naming the repository and saying
nothing was spent — and the card stays live. Raise it only if you have changed the workflow's
concurrency to admit more: `MODULES_JSON={"builder":{"maxConcurrentPerRepo":2}}`.

---

## 9. Running it long-term

**One process per database file.** SQLite is opened with WAL and a busy timeout, but two bot
processes on one database fight over job leases and run in-flight jobs twice. Never scale past
one.

### Docker (recommended)

A module repository does not ship container files, because where and how you run is yours to
decide. These three go at the root of the module repository and are what the engine's own
`Dockerfile` does, minus running source: an installed engine is compiled JavaScript.

`Dockerfile`:

```dockerfile
# Must satisfy "engines" (>=24.12.0).
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a module-only change reuses this layer. --ignore-scripts: nothing runs at
# install time. --omit=dev: typescript and oxlint are check-time tools; the engine and zod are
# ordinary dependencies.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# The SQLite database (DATABASE_PATH defaults to ./data/bot.sqlite). Mount a volume here.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# The image has no .git, so /status reads the commit from here; compose passes it through.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

# Not root: merged modules run in this process, so it should hold as few rights as possible.
USER node

# The engine's CLI, compiled. Your modules' .ts files run directly: they are outside node_modules.
CMD ["node", "node_modules/guildwright/dist/cli.js", "start"]
```

`.dockerignore` — everything here never reaches the build context, so it cannot end up in an image:

```
.env
.env.*
!.env.example
secrets/
*.pem
data/
*.db
*.db-wal
*.db-shm
*.sqlite
*.sqlite-wal
*.sqlite-shm
node_modules/
.git/
.github/
.agent/
*.log
Dockerfile
compose.yaml
.dockerignore
```

`compose.yaml`:

```yaml
services:
  bot:
    build:
      context: .
      args:
        GIT_SHA: ${GIT_SHA:-}
    image: my-bot-modules:latest
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./secrets:/app/secrets:ro      # the GitHub App key; GITHUB_APP_PRIVATE_KEY_FILE=./secrets/app.pem
    restart: unless-stopped
    init: true                         # tini as PID 1, so SIGTERM reaches node
    stop_grace_period: 30s             # in-flight jobs finish or checkpoint before SIGKILL
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"
```

```bash
GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build     # start, or rebuild after pulling
docker compose logs -f bot                                     # follow the logs
docker compose down                                            # stop; in-flight jobs finish or checkpoint first
```

- **Secrets stay out of the image.** `.env` is read by compose at run time (`env_file`), and the
  App key is mounted read-only; `.dockerignore` keeps both, and `data/`, out of the build context.
  The container runs as uid 1000 (`node`), so the key file must be readable by that uid:
  `chmod 600 secrets/app.pem && sudo chown 1000 secrets/app.pem`, or put the PEM in `.env` as
  `GITHUB_APP_PRIVATE_KEY` instead and drop the mount.
- **The database is `./data`, bind-mounted** at `/app/data`. Same file as a non-Docker run, so
  switching between the two needs no migration.
- **Rolling back:** `docker compose down`, check out the previous commit (which pins the previous
  engine), and `docker compose up -d --build`. Restore the database backup too if the newer build
  ran a migration.

### systemd

```ini
[Service]
WorkingDirectory=/opt/my-bot-modules
ExecStart=/usr/bin/node node_modules/guildwright/dist/cli.js start
Restart=always
RestartSec=5
```

`start` reads `/opt/my-bot-modules/.env` itself. Run `npm ci --ignore-scripts` in the working
directory after every pull.

### Logs

The bot logs JSON lines to stdout (pino). Every line carries `service: "guildwright"`, the
`bootId`, the engine version and the module repository's version and commit, so a three-line
excerpt in a bug report still says which build it came from. Filter on `service` to pick the bot's
lines out of a shared log stream. Warnings that need a human are printed to stderr too, and every
refusal to start begins `guildwright cannot start:`.

### Backing it up — do not use `cp`

The database (`DATABASE_PATH`, default `./data/bot.sqlite`) holds approval state, the job queue,
the per-guild permission grants and the audit log. Back it up with SQLite's own backup command,
against the **running** bot:

```bash
sqlite3 data/bot.sqlite ".backup '/backups/bot-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
```

**Why not `cp`.** The bot opens the database in **WAL** mode, so at any instant the committed
state is split across three files: `bot.sqlite`, `bot.sqlite-wal` and `bot.sqlite-shm`. Copying
`bot.sqlite` alone from a live bot silently drops everything still in the WAL, and copying all
three one at a time captures them at three different instants — a torn snapshot that may open
cleanly, may be corrupt, and does not tell you which until the day you restore it. `.backup` takes
a read lock, folds the WAL in, and writes **one** consistent file. `VACUUM INTO` does the same job
and additionally compacts the copy:

```bash
sqlite3 data/bot.sqlite "VACUUM INTO '/backups/bot-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
```

**What to do about the `-wal` and `-shm` files: nothing.** Do not copy them and do not restore
them. Restoring is:

1. stop the bot;
2. delete any `bot.sqlite-wal` and `bot.sqlite-shm` sitting next to the destination;
3. put the backup in place as `bot.sqlite`;
4. start the bot.

Step 2 is the one people skip. A stale `-wal` left beside a restored file is how a good backup
becomes an unrestorable one.

**No `sqlite3` binary?** It is a separate install (`apt install sqlite3`, `brew install sqlite`).
The `node:24-slim` image does not have it, so run it on the host against the bind-mounted
`./data/bot.sqlite`. If you would rather not install it, the safe file-copy route is: **stop the
bot first**, then copy. A clean shutdown checkpoints and removes the WAL, after which
`bot.sqlite` on its own *is* the whole database.

Do not put the database on a network share — SQLite locking over SMB/NFS is not reliable.

---

## 10. Upgrading the engine

The engine version and the gate files under `.github/` move together, in one pull request,
because the bot refuses to build while the files differ from the pinned engine's template:

```bash
git switch -c engine-1.0.1
npm install --save-exact guildwright@1.0.1
npx guildwright template apply    # rewrites .github/** and AGENTS.md; refuses a dirty tree
npm run check
git commit -am "Engine 1.0.1" && git push
```

A human does this, not the agent: the agent cannot edit `.github/**`. Read the engine's
[CHANGELOG](https://github.com/bool-/guildwright/blob/main/CHANGELOG.md) first — a major version
can change the ports your modules compile against. CI's `template-sync` job and the convention
suite fail the pull request if the gate files and the pin disagree. Merge it, then on the bot
host pull, `npm ci --ignore-scripts` (or rebuild the image) and restart.

---

## 11. Moving an existing install onto the engine

This is for a bot that runs from a checkout of the **old single repository**, where the engine,
the modules and the workflow all lived in one tree (RFC-001 section 10). The existing private
repository **becomes your module repository**: the per-user environments, the
`APPROVAL_HMAC_KEY` secret, `AGENT_DAILY_RUN_CAP` and the issue history the builder's rows point
at all stay where they are, and nobody has to run `/credentials set` again. The SQLite file is on
the host, not in the repository, and is migrated in place, not exported.

Before you start: `guildwright` must be published at the version you will pin, and you need the
old bot running from that repository's `main`.

1. **On a branch in the existing repository, delete what the engine now provides.** This is the
   one delete list (RFC-001 section 10 points here); `--ignore-unmatch` skips whatever your tree
   never had:

   ```bash
   git switch -c move-to-guildwright
   git rm -r --ignore-unmatch src/core src/adapters src/testing src/lib scripts docs test \
     src/main.ts src/loader.ts src/engine-events.d.ts \
     src/main.test.ts src/loader.test.ts src/build.test.ts src/registry.boot.test.ts \
     src/cli.test.ts src/conventions.test.ts \
     tsconfig.build.json tsconfig.module-repo.json
   git rm -r --ignore-unmatch src/modules/access src/modules/admin src/modules/builder \
     src/modules/credentials src/modules/help src/modules/ping src/modules/repos
   git commit -m "Remove the engine: it is the guildwright package now"
   ```

   The `src/*.test.ts` files are the engine's own tests; `init` in step 2 writes the module
   repository's `src/conventions.test.ts` in place of the engine's. Keep `src/modules/tags/` and
   every module of your own. The built-in folders must go: the engine loads its own `builder`
   (and the rest) from `node_modules`, and a second module with the same id refuses to start
   naming both. Do **not** touch any `migrations/*.sql` you keep: their checksums are recorded in
   the database, and a changed byte stops the boot.

2. **Convert the rest with the engine's CLI:**

   ```bash
   npx guildwright@1.0.0 init . --existing
   ```

   It rewrites `package.json` to the template shape keeping your `name` and pinning the engine,
   **regenerates `package-lock.json`** (the old one pinned `discord.js`, `octokit` and the rest
   directly, and `npm ci` refuses an out-of-sync pair), replaces `.github/**` with the template's
   copies (the agent workflow, `verify_approval.py` and `agent-settings.json` are the same gates;
   `ci.yml` loses the engine-only steps and gains `template-sync`), writes `AGENTS.md`,
   `README.md`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/conventions.test.ts` and
   `src/engine.d.ts`, and never writes `.env` or anything under `src/modules/`. `README.md` and
   `AGENTS.md` are replaced by the template's, so save anything of your own from them first.

   **If the lockfile step fails, the conversion is still done.** The lockfile is resolved against
   the registry, so when `guildwright` at the pinned version is not reachable there (not yet
   published, or no network), `init` prints `init: could not generate package-lock.json` and
   exits 1, leaving the converted tree in place and any old lockfile removed. You do not need to
   run `init` again; once the registry has the version, run:

   ```bash
   npm install --package-lock-only --ignore-scripts
   ```

3. **If the bot runs in Docker, replace the old `Dockerfile` and `compose.yaml`.** The old
   `Dockerfile` ran `node --conditions=source src/main.ts`, which no longer exists. Use the files
   in section 9, keeping your own image name. `compose.yaml` needs the `./secrets` mount only if
   you move to an App key file. **Merge** section 9's `.dockerignore` into your existing one
   rather than replacing it: keep the entries your repository already had (`brand/`, `.claude/`,
   `.vscode/`, `.idea/`, `dist/` and the like) and add section 9's below them.

4. **Bring your module tests along, then prove it.** Two things the deletion in step 1 takes
   with it:

   - **Module tests that import `#adapters/*` or `#lib/*` no longer resolve.** A module
     repository's import map has only `#core/*`, `#modules/*` and `#testing/*`, and the engine
     exports no adapters. The usual case is a test that rendered a reply through
     `renderView` from `#adapters/discord/render`; assert on the view instead:

     ```ts
     import { validateView } from '#core/view';

     assert.deepEqual(validateView(outcome.view), [], 'the reply must pass the engine view validator');
     ```

     `validateView` is the same structural check `renderView` runs first, but it is weaker: it
     does not build the discord.js payload, so anything discord.js itself would reject while
     building it is no longer caught by your test. It is still caught at run time, as an error
     on the card rather than a crash.
   - **`tags` loses its tests.** Its tests were the engine's, and `init --existing` never writes
     under `src/modules/`. Copy the template's, written against the same `tags` source:

     ```bash
     cp node_modules/guildwright/template/src/modules/tags/module.test.ts src/modules/tags/
     ```

   Then:

   ```bash
   npm ci
   npm run check
   ```

   Fix anything a module of your own trips on: the engine's ports are the 1.0.0 ports (see the
   CHANGELOG), so a module that called `ctx.ports.builds` directly now calls `.at(repo)` first.
   Commit, push, and open a pull request. CI (`check`, the two body jobs and `template-sync`) must
   be green. The pull request's `## Operator action required` section is the list in step 5.

5. **Configure GitHub and `.env`.** Values in `.env` are unchanged. Then either:
   - **keep the PAT**, and make sure it has both of these:
     - **Secrets: read.** Without it the bot **refuses to start**: it checks that the
       `APPROVAL_HMAC_KEY` repository secret exists, and a PAT that cannot read secrets fails
       that check at boot.
     - **Contents: read.** Without it the bot starts, but **every build is refused**: the
       gate-file check cannot read the workflow at `GITHUB_REF`, so builds stay disabled.

     Or
   - **register a GitHub App** (section 4a), install it on this repository only, add
     `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`, and **remove** `GITHUB_TOKEN` — both at
     once refuses to start.

   `GITHUB_OWNER`/`GITHUB_REPO` stay, pointing at this same repository, and `MODULE_DIRS` stays at
   its default. Confirm the repository is private. Remove `ref` and `workflowFile` from
   `MODULES_JSON.builder` if they are there (they are ignored, with a warning). If you run with
   `requireOwnCredentials: false`, the `ai-agent` environment must exist and hold a credential
   before the bot will start.

6. **Cut over.** Take a backup first (section 9) — the first boot on the engine applies the
   builder's migration `0005_repo_key.sql`, so rolling back means restoring it. Then stop the old
   process (SIGTERM; in-flight jobs finish or checkpoint), merge the pull request, pull on the
   bot host, and either `npm ci --ignore-scripts && npx guildwright doctor && npm start`, or
   `docker compose up -d --build`. The core and the builder's earlier migrations are byte-identical
   copies, so their checksums match; durable jobs are recovered and in-flight requests keep
   polling. Downtime is the restart.

   **Merge the pull request before you restart the bot on the engine, never after.** The engine
   compares the gate files at `GITHUB_REF` with its own template, and the old `main`'s
   `agent-implement-request.yml` is not the template's (its prompt text changed in RFC-001
   PR 1.8; `verify_approval.py` and `agent-settings.json` are unchanged). Started against the
   old `main`, the bot runs but the gate-file check disables every build until the pull request
   lands.

7. **Discord: nothing.** Same application, same token, same invite. Commands are redeployed only
   if their definitions changed. New permission keys `repos.manage` (fallback `nobody`) and
   `repos.view` (fallback `guild-admin`) appear in `/access list`.

8. **Secrets and environments: nothing.** `APPROVAL_HMAC_KEY`, `AGENT_DAILY_RUN_CAP`, `ai-agent`
   and every `user-*` environment are untouched. No credential is re-sealed.

9. **Logs: update your filters.** Every log line's `service` field is now `guildwright` (it was
   `discord-bot`), and refusals to start begin `guildwright cannot start:` (they began
   `discord-bot cannot start:`). Anything that filters or alerts on the old strings must change.

---

## Troubleshooting

**The bot refuses to start on a GitHub problem — and says which variable.**
Boot verifies the GitHub half of the configuration before reporting ready, so an expired token or
a renamed workflow fails in one second with the variable named, rather than hours later as a
user's build "timing out". `npx guildwright doctor` runs the same checks without starting.

**On a PAT, two permissions are the usual cause, and they fail differently.** A PAT without
**Secrets: read** stops the bot at boot (fatal, below). A PAT without **Contents: read** lets the
bot start, and then **every build is refused**, because the gate-file check cannot read the
workflow. Grant both (section 4b).

What is **fatal** (the process exits 1, naming what to fix):

| Answer | Meaning |
|---|---|
| `401` on any read | `GITHUB_TOKEN` is expired, revoked or malformed — or, in App mode, the private key does not belong to `GITHUB_APP_ID`: download a new key from the App's settings page. |
| `the GitHub App "<slug>" (id N) is not installed on owner/repo` | Install it (section 4a step 7). The sentence carries the installations URL. |
| a list of missing permissions | The App installation lacks one of the nine in section 4a. Edit the App's permissions, then **accept the new permissions** on the installation (GitHub asks the installer to approve them). |
| `repository_selection` is all | Change the installation to "Only select repositories". |
| `<owner>/<repo> is PUBLIC` | Make it private, or set `ALLOW_PUBLIC_TARGET_REPO=true` if that is what you want. |
| `has no repository secret APPROVAL_HMAC_KEY` | Add it (section 5a). |
| `the token cannot read repository secrets` | Add **Secrets: read** to the PAT or the App. |
| `GitHub refused to list environments` | With `requireOwnCredentials` on, environments must work: grant Environments, check your plan allows environments on a private repository, or turn the switch off and fund builds yourself. |
| `requireOwnCredentials is false but … no environment named ai-agent` | Create it and add a credential (section 5c). |
| `404` on the repository | `GITHUB_OWNER`/`GITHUB_REPO` is wrong, **or** the App or token was never granted that repository. On a private repository GitHub returns 404 rather than 403. |
| `404` on the workflow file | `GITHUB_WORKFLOW_FILE` names a file that is not on the default branch, or the grant lacks **Actions**. |
| `package.json asks for guildwright@X but Y is installed` | Run `npm ci`. |
| `two copies of zod are installed` | Pin `"zod"` in `package.json` to the engine's exact version and run `npm ci`. |
| `two copies of guildwright are loaded` | Run `npm ls guildwright` and dedupe. |

What only **warns** (the bot starts; builds may be off until it passes, and `/status` says so):

- **`403`, `429`, `5xx`, or GitHub being unreachable** on a probe. None of these is evidence that a
  value is wrong; GitHub has outages. Refusing to boot on them would mean somebody else's incident
  takes `/help` down with it. The unverified check is re-run at the next `/request new` or
  dispatch.
- **`404` on the ref.** Resolving a ref needs **Contents: read**; the warning names both causes.
  Without Contents the bot starts, but every build is refused until it is granted.
- **The workflow is disabled**, or **Issues are switched off**. Both are fixable on the
  repository's settings pages without a restart.
- **`GITHUB_TOKEN` expires within 14 days.**
- **Running on a PAT at all**, once per boot.

**`/status` says builds are disabled because a gate file does not match the engine's template.**
`.github/workflows/agent-implement-request.yml`, `.github/scripts/verify_approval.py` or
`.github/claude/agent-settings.json` at `GITHUB_REF` differs from the pinned engine's copy. Run
`npx guildwright template apply`, commit, merge, and the next `/request new` sees the new commit —
no restart needed. This is deliberate and has no override: the gates are what make an approval
mean something.

**`/request new` does not appear in the command list.**
Commands deployed globally can take up to an hour to propagate. Set `DISCORD_DEV_GUILD_ID` to your
server's id for instant, guild-scoped registration while you are setting up. Also confirm the bot
was invited with the `applications.commands` scope — the `invite-url` URL includes it.

**Every build fails at "Verify the Discord approval".**
`APPROVAL_HMAC_KEY` differs between `.env` and the **repository** secret, or it was stored as an
*environment* secret instead. Both must hold the same value, byte for byte (section 5a).

**Every build fails at the agent step.**
The Claude GitHub App is not installed on the repository (section 5b). The run report says
`failed_step: agent` and carries the OIDC error.

**"resource not accessible by integration" / unexpected 404 on a private repo.**
The App or token is missing a permission from section 4, or was not granted that specific
repository. A 404 on a private repo usually means "no permission", not "does not exist".

**`/request new` says "Builds here run on your own Anthropic credentials, and you have not stored any."**
Working as designed, and the message is the instruction: run `/credentials set` first. This applies
to the operator too.

**`/request new` says too many builds are already in flight, but nothing is building.**
Read the message again — it distinguishes the two cases. If the slots are held by requests nobody
has clicked: `/access list` to see whether anybody holds `builder.approve`, `/access grant` to
create an approver, and have them Reject the stale cards. Otherwise the hourly sweep expires them
after `approvalTtlMs`.

**`/request new` says "Your build credentials are no longer stored on GitHub."**
Your environment exists but is empty: you ran `/credentials clear`, or the secret was deleted by
hand. `/credentials set` again.

**`/credentials` says the grant is missing the "Environments" permission.**
It is, and it is not the permission called "Secrets" — see section 4. Grant **Environments: Read
and write** *and* **Administration: Read and write**.

**Approve says the daily build cap has been reached.**
Working as designed, before spending anything. Wait for the reset (midnight UTC), or raise both
numbers together (`AGENT_DAILY_RUN_CAP` **and** `modules.builder.dailyRunCap`).

**The build succeeded but no link arrived.**
Check the run's "Reject forbidden path changes" step — if the agent touched `.github/**`, `.env`,
`.npmrc` or `.ssh/`, the run fails deliberately and the PR is marked do-not-merge.

**Nobody was pinged when the build finished.**
Discord's own delivery rules apply: a requester who left the server, muted the channel or blocked
mentions from the bot is not notified. The message is still posted, and `/request list` always
shows the outcome.

**A module is broken and the bot will not behave.**
`MODULES_DISABLE=thatmodule` skips it *before* import, so it works even for a module that throws on
load. The rest of the bot keeps running.

**A module was quarantined at boot for an import.**
The boot scan refuses a module whose source imports `discord.js`, `octokit`, `node:fs`,
`node:child_process` and the like (`AGENTS.md` rule 1), and names the import. The scan is textual
and bypassable on purpose-built code; it catches mistakes, it is not a sandbox. `npm run check`
fails on the same import first.

---

## Adding features yourself

```bash
npm run scaffold -- my-module --summary "One line about it." --db
npm run check
```

**Start here rather than copying a folder.** The generated module compiles, lints and passes its
own test immediately, with every mandatory field written out (`PUBLIC`, `NO_LIMIT`, `needs: []`)
instead of omitted — so your first `npm run check` measures your change and not your boilerplate.
Nothing else needs editing: the loader finds the folder on the next boot. Drop `--db` if the module
stores nothing; keep it if it does, because it also writes the `migrations/` folder that
`migrations: true` requires. Read `AGENTS.md` first; it documents the rules that are not inferable
from the code, and `src/modules/tags/` is the worked example of a finished module. The engine's
source ships for reading at `node_modules/guildwright/src/core/`.

### Where a future change will tell you it needs you

Every pull request into your module repository — yours, or one the bot's own agent opens —
carries a section headed **`## Operator action required`**. That is where anything on *this page*
that a change makes newly necessary gets announced: a privileged gateway intent to tick in the
Developer Portal, a new permissions integer meaning you must re-invite the bot (section 3), a new
required variable in `.env` (section 6), a new GitHub permission or secret (sections 4 and 5), or a
change to who pays for a build (section 5c).

It says `None.` when nothing is needed, and it is never absent: the `require-operator-disclosure`
job in `.github/workflows/ci.yml` fails a pull request whose body omits it or leaves it empty.

A sibling job, `require-test-change`, fails a pull request that changes a `.ts` file under `src/`
while no `*.test.ts` file in the diff changed. It proves a test file was **touched** — not that it
is a good test — and a body line reading `NO-TEST-NEEDED: <reason>` passes it deliberately, so the
reason ends up somewhere a reviewer reads. Both jobs re-run when a description is edited.

---

## What it costs to run

Two separate bills. They are billed to different places and confusing them is easy.

### GitHub Actions minutes — billed to whoever owns the module repository

| | |
|---|---|
| **Public repo** | **unlimited, free** |
| Private repo, Free account | 2,000 min/month, then **$0.006/min** (Linux) |

Your module repository is private (the bot refuses a public one by default), so the private
arithmetic applies to each group separately. Each build is capped at `timeout-minutes: 30`, though
a typical small feature finishes well inside that. Against 2,000 minutes/month that works out to
roughly **~2 builds/day** if every build ran the full 30 minutes, **~4 builds/day** at a more
typical 15 minutes, and **~8 builds/day** at 8 minutes.

The daily cap therefore defaults to **4**, and it is enforced in **two** places:

- **In the workflow**: the run counts today's runs of `agent-implement-request.yml` and exits 1
  when there have already been too many. Set it with the `AGENT_DAILY_RUN_CAP` repository
  variable. This is the one that does not trust the bot: it still applies to a hand-triggered
  `workflow_dispatch`, to a replayed dispatch, and to a bot that has been compromised.
- **In the bot**, before it dispatches anything: `modules.builder.dailyRunCap` (also 4). Approve
  asks GitHub how many runs there have been since midnight UTC and, if the cap is reached, refuses
  in Discord — naming the number and when it resets — and dispatches nothing. This is the one a
  human reads, and it costs no minutes when it fires.

**Keep the two numbers equal — and the bot checks that you have.** At boot it reads
`AGENT_DAILY_RUN_CAP` (with **Variables: read**) and caches the comparison for `/status`:

| | Effect | What the bot does about it |
|---|---|---|
| bot lower than workflow | the bot refuses first, politely. Harmless. | reported in `/status`, logged at info |
| bot higher than workflow | the bot dispatches, the workflow refuses. Avoid. | `/status` shows a **WARNING** naming both numbers, a warning is logged, and a `builder.daily_cap_drift` audit row is written |
| `AGENT_DAILY_RUN_CAP` not a whole number | **every build fails seconds after it starts** | `/status` says so explicitly, and it is audited |
| `AGENT_DAILY_RUN_CAP` not set | the workflow's literal default of **4** applies | compared against 4 rather than skipped |

```
MODULES_JSON={"builder":{"dailyRunCap":8}}     # and set AGENT_DAILY_RUN_CAP=8 to match
```

**With several repositories** (section 8), every number above is **per repository**: each has its
own runs, its own `AGENT_DAILY_RUN_CAP` and its own line in `/status`, compared against the bot's
single `dailyRunCap`.

### Anthropic tokens — billed to the person who asked

`claude-sonnet-5-5` at ~$2/$10 per million tokens in/out. A small feature is usually well under a
dollar; a large one with a lot of exploration can be a few. Bounded by `--max-turns 150` and the
30-minute job timeout. **Who pays is decided by `modules.builder.requireOwnCredentials`**
(section 5c), which defaults to `true`: the run uses the requester's own `user-<discord-id>`
environment.

> **The Actions minutes above do *not* follow the credential.** They are billed to whoever owns the
> repository, whichever mode you are in. So "every requester pays for their own build" is true of
> the Anthropic half only, and the daily run cap remains the operator's spend control.

### Is 30 minutes enough?

GitHub's own limit is **6 hours per job**, so the 30-minute timeout is ours, not theirs. The reason
not to raise it casually is the failure mode: a build cut off mid-work has pushed a branch and not
opened a PR. The workflow already tells the agent to open a **draft PR** describing what remains
rather than stopping silently.

---

## Developing the engine itself

Only for changing Guildwright, not for running a bot. The engine repository runs its own
TypeScript source through the `source` resolution condition, so it needs no build to develop:

```bash
git clone https://github.com/bool-/guildwright.git && cd guildwright
npm ci
npm run check                                   # typecheck -> lint -> test: the gate
ENGINE_PACK_TEST=1 node --conditions=source --test src/build.test.ts   # pack, install, init, check (needs the registry)
npm run build                                   # dist/, and regenerates template/AGENTS.md and template/MANIFEST.json
```

`npm start` and `npm run dev` in the engine checkout boot the built-ins straight from source,
against a `.env` filled from the engine's own `.env.example`, pointed at a private test repository
that holds the template's `.github` files. The engine's own `Dockerfile` does the same in a
container, and so does systemd with:

```ini
[Service]
WorkingDirectory=/opt/guildwright
ExecStart=/usr/bin/node --conditions=source src/main.ts
Restart=always
RestartSec=5
```

`--conditions=source` is required there and only there: without it `#core/*` resolves to `dist/`,
which a checkout does not have. A module repository never passes it. `AGENTS.md` and
`docs/ARCHITECTURE.md` (sections 10 and 11) explain the build and the package boundary.

Releases are cut by hand with the `publish` workflow; see `CHANGELOG.md` and the comment at the top
of `.github/workflows/publish.yml`.
