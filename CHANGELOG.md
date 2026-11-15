# Changelog

Every release of the `guildwright` package. The module contract is a public API from 1.0.0: a
change to `PortRegistry` or any port's methods, `ModuleDefinition`, the core events, the workflow
inputs, the approval MAC, or any file under `template/` is a **major** version and is listed under
`BREAKING:`. New optional behaviour is a minor version. To upgrade a module repository, see
`docs/SETUP.md` section 10.

## 2.2.0

### Sponsored builds

- **A request is filed even when its requester has no build credentials.** Its approval card says
  "Paid by: Nobody yet - this needs a sponsor" and carries a **Sponsor** button. Anyone with a
  stored credential, the requester included once they run `/credentials set`, clicks it to pay for
  the build from their own environment; the same button withdraws.
- **Approve is refused while nobody can pay**, and the sponsor cannot approve the build they pay
  for (unless `allowSelfApproval`). A requester who cleared their credential after filing gets the
  card redrawn with Sponsor instead of an approval.
- **At dispatch the payer is the sponsor, else the requester**, and that environment name is what
  the approval MAC signs. The workflow and `verify_approval.py` are unchanged.
- **Every re-arm clears the sponsor**: a retry is paid by the requester if they can, and otherwise
  goes back to an approval card that asks for a new sponsor; a revision and an expired request put
  back likewise. Nobody's bill grows from a click made for an earlier build.
- Builder migration `0007_sponsors.sql` (`sponsor_id`, `needs_sponsor`, and the approval card's
  content so a Sponsor click can redraw it). `/request retry` re-approval cards now show the
  original excerpt instead of none.

## 2.1.0

### Live progress on the "Building" card

- **The card says which step the build is on**, e.g. "Step 14 of 24: Agent is writing code
  (started 4 minutes ago)". Step names are mapped to plain labels in
  `src/modules/builder/progress.ts`; the elapsed time is a Discord timestamp, so the client keeps
  it current and the card is redrawn **only when the step changes**.
- **The pull request is linked on the card as soon as the agent opens it**, before the run ends.
  It is looked for only from the agent's step on. A revision's card says "Building revision k"
  and links its PR from the start.
- New optional `BuildsPort.runProgress` (`GET /actions/runs/{id}/jobs`, the same `actions: read`
  the poll already uses) and `RunProgress`; `mdTimestamp` in `#core/text`. Optional, so no other
  port implementation breaks. Progress is cosmetic: a failed read or edit never touches the build.

## 2.0.0

Identical in behaviour to `2.0.0-rc.0`, which ran in production first: a new request and a `/request revise` of it were built end to end, and the revision landed on the same pull request.

### `/request revise`: iterate on an open pull request from Discord

- **`/request revise id:<id> feedback:<text>`** sends feedback on the pull request a request opened
  back to the agent. The feedback is appended to the issue body as a fenced `## Revision <k>`
  section (`buildRevisionSection`, same nonce as the issue), goes back to `awaiting_approval` on a
  new card, and once approved the workflow checks out the existing `agent/req-<id>` branch and
  pushes to the open pull request instead of opening another. Requester only; bounded by
  `modules.builder.maxRevisions` (default 3); every cap and the credential gate apply. A
  rejected, expired or cancelled revision returns the request to `pr_open` and never closes the
  issue. A revision whose pull request closed meanwhile is dropped before dispatch.
- **The mode is bound by the approval MAC, not a dispatch input.** The workflow reads it from the
  `<!-- build-revision v1 nonce=<nonce> revision=<k> -->` marker in the MAC-bound body; the
  approval tuple (`v2`) and `verify_approval.py` are unchanged. The stray-nonce check admits
  exactly that one extra line shape.
- **The run report gains `pushed`** (did the branch head move during the run), computed by the
  workflow from two SHAs it read itself. A revision's ending is judged on it.
- Builder migration `0006_revisions.sql` (`revision_count`).
- BREAKING: `IssuesPort.appendRevision`, `PrRef.isOpen` and `RunReport.pushed` are new required
  members, so any other implementation of those ports must add them.
- BREAKING: `template/.github/workflows/agent-implement-request.yml` changed (a new
  `Read the approved request` step; the nonce checks moved there from the compose step). A module
  repository must run `guildwright template apply` after upgrading, or the per-dispatch gate check
  refuses builds as drifted. That check compares the repository's gate files with the engine's
  own copies in both directions, so the engine and the module repository's `.github/` are
  upgraded together.

## 1.0.0

The first published version. Before it, the engine, the product modules and one operator's
deployment lived in a single private repository and were never released; this version splits
them (RFC-001, `docs/RFC-001-public-core-private-modules.md`). The engine is the public npm
package `guildwright`; each group runs its own bot from its own private module repository, made
from the template this package ships. One bot instance serves one trust domain.

The "BREAKING" entries below are measured against that unreleased single-repository engine
(`0.1.0`), so they matter to anyone moving an install or a module across (`docs/SETUP.md`
section 11), not to a first install.

### Phase 0: the approval gate and the prompt fence

- **Single-use, expiring approvals.** The approval MAC is v2: it signs the request id, a
  per-approval `approval_id`, the issue number, the issue body's sha256, the paying environment,
  `approval_issued_at` and the repository. The workflow consumes each approval once (a run-list
  scan keyed on run names, then an atomic `refs/approvals/<id>` ref) and refuses one older than
  `APPROVAL_MAX_AGE_SECONDS` (repository variable, default 900) measured against the run's
  creation. Every retry mints a fresh id. A re-dispatch refused as a replay adopts the earlier
  run. Builder migration `0004_approval_id.sql`.
- **Nonce-delimited prompt fence.** The agent's prompt wraps the user's text in a tag named by the
  per-issue nonce the bot minted, and the workflow refuses an issue with no nonce marker, a stray
  nonce, or the nonce in its title.
- BREAKING: the workflow requires the `approval_id` and `approval_issued_at` inputs. A bot and a
  workflow from different sides of this change cannot dispatch to each other.

### Phase 1: package, template, GitHub App

- **Config-driven discovery and a boot import scan** (1.1). `MODULE_DIRS` (default
  `./src/modules`) names the module directories, scanned after the built-in root, de-duplicated by
  real path; a directory named explicitly that does not exist stops the boot. `MODULES_BUILTIN`
  (default `true`). A module whose source imports a banned specifier (`discord.js`, `octokit`,
  `node:fs`, `node:child_process`, `#adapters/*` and the rest of `AGENTS.md` rule 1) is quarantined
  before it is imported. The scan is textual and bypassable, and says so.
- **Build and exports** (1.2). The package ships compiled `dist/` (Node will not strip types under
  `node_modules`), `src/core` for reading, and the template. `exports`: `./core/*`, `./testing/*`,
  `./events`, `./main`, `./loader`, `./tsconfig.module-repo.json`. The checkout runs source through
  the `source` condition. `zod` is a peer dependency at an exact version. A second copy of the
  engine, or of `zod`, refuses to start.
- **Conventions as a package** (1.3). `registerConventionTests` in `guildwright/testing/conventions`
  runs the same import wall, extension rules, clock and collector bans, disclosure assertions and
  workflow pins in the engine and in every module repository, with the same failure sentences.
- **The CLI** (1.4), bin `guildwright`: `start`, `doctor [--offline]`, `invite-url`, `scaffold`,
  `init [--existing]`, `template check|apply`, `gc-approvals`.
- **The module-repository template** (1.5): `template/`, written by `guildwright init` and published
  as the template repository. `tags` moved there as the worked example, byte for byte
  (its migration keeps its ledger checksum). `template/AGENTS.md` is generated from the engine's
  with fixed substitutions; `template/MANIFEST.json` records the sha256 of every gated file.
- **GitHub App authentication** (1.6), beside the PAT. `GITHUB_APP_ID` plus exactly one of
  `GITHUB_APP_PRIVATE_KEY_FILE` / `GITHUB_APP_PRIVATE_KEY`, optional `GITHUB_APP_INSTALLATION_ID`;
  exactly one of the two modes, or the boot refuses. The App's nine permissions are checked at boot,
  an installation on all repositories is refused, and an uninstalled App is named as such. Tokens
  come from the App bundled in `octokit`; no dependency was added. A PAT logs a warning.
- **Containment preflight** (1.7). The bot refuses to start when the target repository is public
  (unless `ALLOW_PUBLIC_TARGET_REPO=true`), when the `APPROVAL_HMAC_KEY` repository secret is
  missing, when the grant cannot read repository secrets (**`Secrets: read` is now required, on a
  PAT too**), when environments cannot be listed with `requireOwnCredentials` on, and when
  `ai-agent` is missing or empty with it off. Before every dispatch the three gate files at the
  dispatch ref are compared with the installed engine's template; any drift disables builds, with
  no override, until `guildwright template apply` is merged. Transient GitHub failures warn and
  leave builds off until a later check passes.
- BREAKING: `BuildsPort.dispatch()` no longer takes `workflowFile` or `ref`, and
  `BuildsPort.runsSince()` no longer takes a workflow file: the adapter is bound to
  `GITHUB_WORKFLOW_FILE` and `GITHUB_REF`. `BuildsPort` gains `verifyGates()` and `readiness()`,
  and `dispatch()` refuses unless the last `verifyGates()` passed.
- BREAKING: `VersionPort.current()` returns `BuildInfo` with two identities, `engine` (the package)
  and `repo` (the module repository the bot was started in, with its git sha), plus `node`.
  `VersionPort` gains `githubAuth()`, rendered by `describeGithubAuth`.
- BREAKING: `MODULES_JSON.builder.ref` and `.workflowFile` are removed; they are ignored with a
  boot warning.
- BREAKING: `tags` is no longer a built-in module. A repository keeps `/tag` by keeping
  `src/modules/tags/`.

### Phase 2: several repositories

- **The repository set** (2.1). `GITHUB_REPOS_JSON` configures several repositories; without it
  `GITHUB_OWNER`/`GITHUB_REPO` (with `GITHUB_REF`, `GITHUB_WORKFLOW_FILE`,
  `GITHUB_APP_INSTALLATION_ID`) are a one-repository set keyed `default`, so an existing
  configuration is unchanged. One adapter and one installation per repository; every boot check
  runs for each.
- **Guild routing** (2.2). The built-in `repos` module: `/repo use`, `/repo show`, `/repo clear`,
  with the new permission keys `repos.manage` (fallback `nobody`) and `repos.view` (fallback
  `guild-admin`). Each request records the repository it was filed in, and a re-link never moves a
  build. Builder migration `0005_repo_key.sql`.
- **Credentials per repository** (2.3). `/credentials set` stores into the server's repository, or
  the `repo:` named in a DM; `status` lists every repository in a DM; `clear everywhere:`.
- **Per-repository caps** (2.4). `modules.builder.maxConcurrentPerRepo` (default 2) bounds builds
  dispatched at once in one repository; `dailyRunCap` and its drift report apply per repository.
- BREAKING: `PortRegistry.issues`, `.builds` and `.secrets` are `RepoScoped<T>`: a module calls
  `ctx.ports.builds.at(repo)` with a `RepoRef` from the new `repos` capability
  (`ReposPort`: `all`, `resolve`, `byKey`, `target`, `activity`).
- BREAKING: `SettingsPort` gains `clear()`; `ModuleHandle` gains the optional `repoActivity`.

### The name, and this release (1.8)

- The product is **Guildwright**, applied to every surface at once: the npm package and its bin
  are `guildwright`; the GitHub user agent is `guildwright`; every log line carries
  `service: "guildwright"`; every refusal to start begins `guildwright cannot start:`; the engine
  guard is `Symbol.for('guildwright.engine')`; the template depends on `guildwright` and every
  generated command is `npx guildwright ...`. Environment variable names and `#core/*` are
  unchanged.
- BREAKING: log filters and alerts on `service: "discord-bot"` or `discord-bot cannot start:` must
  be updated.
- The agent's prompt no longer names engine-only paths, so the one workflow file is correct in the
  engine and in every module repository.
- Documentation for the App and module-repository world: `docs/SETUP.md` (including moving an
  existing install), `docs/ARCHITECTURE.md` sections 10 and 11, this file.
- `publish.yml` publishes with npm provenance and then pushes the generated template, lockfile
  included, to the template repository. It runs only by hand, and does nothing without its secrets.
