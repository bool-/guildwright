# Guildwright

The engine for a Discord bot that your group runs itself, whose flagship module turns a chat
message into shipped code:

```
/request new  ->  Title: dark mode for the dashboard
              Detail: users on the settings page want a toggle that...
```

becomes a GitHub Issue → an Approve/Reject card in Discord → (on approval) an autonomous
Claude Code run in GitHub Actions → a pull request into **your own private module repository**,
with the link posted back to the channel and the person who asked @-mentioned on it.

**One instance, one trust domain.** Guildwright is an npm package (`guildwright`) plus a template.
A group creates one private module repository from the template, registers its own GitHub App,
and runs its own bot process from that repository. The bot loads the engine's built-in modules and
the modules in that repository, and nothing else. Modules are in-process code, so **merging a
module grants it the bot's full authority**: its Discord token, its GitHub App key and its
database. There is no hosted bot that runs other people's modules, and there is deliberately no
way to make one. Several Discord servers, and several repositories you own, may share one bot;
several groups may not.

**Each requester pays for their own build.** Before `/request new` works you run `/credentials set`
once and hand the bot your own Anthropic API key or Claude Code OAuth token, which it seals
straight into a per-user GitHub environment and cannot read back. That applies to the operator
too; there is no owner bypass.

```bash
npx guildwright@1.0.0 init my-bot-modules    # or "Use this template" on bool-/guildwright-template
cd my-bot-modules && npm ci && npm run check  # green before anything is configured
cp .env.example .env                          # Discord token, GitHub App, APPROVAL_HMAC_KEY
npx guildwright doctor                        # every configuration problem at once
npm start
```

**[Setup guide](docs/SETUP.md)** · **[Changelog](CHANGELOG.md)** · **[Architecture decisions](docs/ARCHITECTURE.md)** · **[Known issues](docs/KNOWN-ISSUES.md)** · **[RFC-001: public core, private module repos](docs/RFC-001-public-core-private-modules.md)** · **[AGENTS.md](AGENTS.md)**

## Why this exists

Most "AI builds your feature" demos skip the three things that make it safe to actually run:
a **human approval gate**, **containment of untrusted input**, and **an answer to who gets the
bill**. This one treats all three as the product. Anyone who brings their own credential can ask;
only an approver can start a run and merge the code.

## How it works

| Step | Where |
|---|---|
| `/credentials set` seals your Anthropic credential into a `user-<your id>` GitHub environment | bot → GitHub |
| `/request new` opens a modal; the submission is refused outright if you have stored no credential | bot |
| Otherwise it is validated, redacted, and rate-limited | bot |
| A well-formed GitHub Issue is filed | bot → GitHub |
| An Approve / Reject card is posted, gated on `builder.approve` — handed out with `/access grant` | bot |
| Approve re-checks who is paying **and how many builds have run today**, then dispatches into **that person's** environment | bot → Actions |
| Claude Code implements the issue on a deterministic branch and opens a PR | GitHub Actions |
| The run is polled; the PR link — or a draft PR, or the agent's refusal, or the run log — comes back **as a message that @-mentions the requester** | bot |
| `/request list` shows what you asked for and where each one got to | bot |
| `/request cancel` withdraws a request **and asks GitHub to stop the run**, so a build you no longer want stops spending your credits rather than only stopping being watched | bot → Actions |
| `/request retry` re-arms a failed or expired request, **reopening its issue** so an approver is never asked to fund one GitHub still shows as "not planned" | bot → GitHub |
| A request nobody approves expires after 48h: issue closed, card resolved, slot freed | bot |

The bot exposes **no inbound HTTP** — no webhook server, no tunnel, no TLS certificate. It learns
the outcome by polling, which also means a bot that was offline mid-build recovers on next boot.

## Security posture

- Untrusted Discord text never reaches a `${{ }}` expression in a workflow. It is fetched at runtime
  into a file and wrapped in `<untrusted_<nonce>>` tags named by a per-request random nonce the
  user never saw, so the boundary cannot be closed from inside the request.
- The Actions workflow starts from `permissions: {}` and grants the minimum per job.
- The agent has no `workflows` permission, so it structurally cannot edit its own authorization path.
- A post-hoc gate fails the run if the agent touched `.github/**`, `.env`, `.npmrc`, or `.ssh/`.
- The Anthropic bill follows the requester: with `requireOwnCredentials` on (the default) no code
  path leads from "brought no credential" to spending the operator's, and the environment that
  pays is bound into the approval HMAC so an approved run cannot be re-pointed at someone else.
- The approval token is single-use and expires: it signs a per-approval id the workflow consumes
  once, and an issue time the workflow checks against the run's creation (15 minutes by default),
  so a token read out of a run log cannot be replayed.
- Every pull request must carry an `## Operator action required` section — `None.` when nothing is
  needed, never absent — and CI fails the PR if it does not. A second job fails a PR that changes
  `src/` while touching no test file; it proves a test was *touched*, nothing more, and says so.
- The bot can @-mention exactly one person: the requester, from a snowflake it persisted itself.
  `allowed_mentions.parse` stays `[]`, so `@everyone`, `@here` and role pings are impossible to
  produce from user text.
- The daily build cap is enforced twice: in the bot before it dispatches, so a human reads the
  refusal and no minutes are spent, and again in the workflow, which does not trust the bot and is
  the only one of the two that bounds a hand-triggered or replayed dispatch. The bot reads the
  workflow's number at boot and reports in `/status` when the two have drifted — including the case
  where the repository variable is not a whole number, which makes *every* build fail seconds in.
- Permissions are **per-server allow-lists**, handed out with `/access grant` and audited. A module
  cannot mint another module's permission key, so `/access` passes a plain string and the adapter
  re-proves it against the boot catalog before minting anything — an undeclared key is refused,
  which is what keeps permission references unforgeable.
- Boot verifies the GitHub half of the configuration before reporting ready, so an expired token or
  a renamed workflow fails in one second with the variable named, rather than six hours later as a
  user's build "timing out".
- `/status` degrades on a durable job that has been *running* too long, not merely on one that
  died. A count alone reads the same for a build that started four seconds ago and one wedged since
  Tuesday, so the job runner records when each attempt was claimed — in its own column, because the
  one that already existed is rewritten by every lease renewal and would report a hung job as
  healthy.

## Commands

| Command | Who can run it by default |
|---|---|
| `/request new` | anyone with a stored credential (`builder.request`) |
| `/request list` · `cancel` · `retry` | the person who asked (`builder.request`); approvers see everyone's list |
| `/access list` · `/access grant` · `/access revoke` | server managers (`access.manage`) |
| `/admin jobs` — counts by state, and the oldest running job's age, so "is anything stuck?" has an answer rather than a disclaimer | server managers (`admin.view`) |
| `/admin audit` — who decided what, which authorization layer allowed it, and which module recorded it; pageable and filterable by action, actor or layer | server managers (`admin.view`) |
| `/credentials set` · `status` · `clear` | anyone (`credentials.manage`) |
| `/repo use` · `show` · `clear` — which of several configured repositories a server builds into | the operator (`repos.manage`) / server managers (`repos.view`) |
| `/tag get` · `/tag set` — not an engine built-in: the worked-example module in the module-repo template (`template/src/modules/tags/`) | anyone / server managers |
| `/help`, `/status` | anyone |

Approving a build (`builder.approve`) is granted to **nobody** by default, because it spends money.
`/access grant permission:builder.approve role:@maintainers` is how you create your first approver.

## Requirements

- Node.js >= 24.12. A module repository runs its own TypeScript directly, with no build step; the
  engine arrives compiled from npm.
- A Discord application — **no privileged intents required**.
- A **private** GitHub repository made from the template, and a GitHub App you register yourself
  and install on that repository only (suggested name: `<your server name> Guildwright`), with
  Metadata, Pull requests, Contents, Secrets and Variables at read, and Issues, Actions,
  Environments and Administration at read-and-write. A fine-grained personal access token with the
  same grants still works, with a warning. The Claude GitHub App installed on the repository runs
  the agent step.
- An Anthropic API key or Claude Pro/Max subscription **per person who wants to build** — handed to
  the bot with `/credentials set`, not put in `.env`. The shared `ai-agent` environment funds builds
  only if you set `modules.builder.requireOwnCredentials` to `false`.

## Writing modules

In your module repository:

```bash
npm run scaffold -- my-module --summary "One line about it." --db   # start every new module here
npm run check          # typecheck + lint + test  (this is the gate)
```

A scaffolded module compiles and passes its own test immediately, and nothing outside its folder
needs editing — the loader finds it on the next boot. That is why `npm run scaffold` is the
documented starting point for a new module rather than copying a folder: the first `npm run check`
then measures your change instead of your boilerplate. Read `AGENTS.md` first: it documents the
rules that are not inferable from the code, and it is written for AI contributors because the
flagship module is one.

## Developing the engine

```bash
git clone https://github.com/bool-/guildwright.git && cd guildwright
npm ci
npm run check          # typecheck + lint + test  (this is the gate)
npm run dev            # watch mode, from source
npm run build          # dist/ for the package, plus template/AGENTS.md and template/MANIFEST.json
```

The engine checkout runs its own source under `--conditions=source`; only the published package is
compiled. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) sections 10 and 11 explain the build step
and the package boundary, and the template a module repository is made from lives in
[`template/`](template/).

## License

MIT. See [`LICENSE`](LICENSE).
