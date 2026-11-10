# Architecture Decision Record

Every version number and API behaviour below was **verified by execution on 2026-09-01**, not recalled.
Where a claim was checked against a live API or a real compile, the evidence is named. Anything still
unverified is marked **UNVERIFIED** rather than asserted.

---

## 1. Language and runtime: TypeScript on Node 24, with no build step

Node 24.16 executes `.ts` files directly via native type stripping — verified by running a typed file
with zero flags. So the repo ships TypeScript source and runs it as-is:

```
npm start   ->  node --env-file-if-exists=.env src/main.ts
```

`tsc` is a **checker only** (`--noEmit`). There is no `dist/`, no bundler, no loader, no `tsx`.

**Consequences you must live with:**

| Rule | Why |
|---|---|
| Relative imports carry the `.ts` extension | Node resolves the real file; verified working under `tsc` and `node` simultaneously |
| `erasableSyntaxOnly` is on | No `enum`, no `namespace`, no parameter properties, no decorators — type stripping cannot erase them |
| Node does **zero** runtime type checking | `const n: number = "x"` *runs*. `npm run typecheck` is not optional |

Python was seriously evaluated (discord.py 2.7.1 is healthy and actively committed). A three-lens judge
panel picked TypeScript 2–1: ecosystem currency and operator experience favoured it clearly, while
task-fit favoured Python narrowly. The deciding factor for a repo that **AI agents will extend** is that
`tsc --noEmit` gives an agent a fast, mechanical self-verification loop before it hands work back.

## 2. No framework — a small purpose-built core on plain discord.js

`@sapphire/framework`, `necord`, `discordx` and `commandkit` were all surveyed against live repo activity.

**`@sapphire/framework` was rejected on a security finding, not a taste preference.** Its
`UserPermissions` / `ClientPermissions` preconditions compute their DM fallback as the bit-complement of
a DM-safe set. That complement **includes the Administrator bit**, and discord.js's
`PermissionsBitField#missing(bits, checkAdmin = true)` returns `[]` whenever Administrator is present.
Net effect: **in a DM, every permission-gated command passes its precondition for any user.**
Reported upstream as issue #872 on 2026-08-18; v5.5.1 shipped 2026-08-22 without addressing it. The core
package also had **zero commits from 2026-01 through 2026-07**.

`necord` is genuinely healthy (265 commits/12mo) but means adopting NestJS wholesale. `discordx` has not
tagged a release in over two years. `commandkit` owns your build toolchain and stopped committing in
2026-07.

The modularity primitives these frameworks sell are a few hundred lines we own outright — and none of
them sit in our security path.

## 3. The approval → build → report mechanism

**Bot-initiated `workflow_dispatch`, then bot-side polling. No inbound HTTP on the bot at all.**

The classic hard part of this design is correlating a dispatch to its workflow run: the API historically
returned `204 No Content` with no run id, forcing fuzzy time-window matching.

**That problem is gone.** `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` now
accepts `return_run_details: true` and answers `200` with the run id.

Verified twice — first in GitHub's published OpenAPI description (`workflow_run_id`, `run_url`,
`html_url`, all three `required`), then **by live dispatch against this repository**:

```json
{"workflow_run_id":33592845695,
 "run_url":"https://api.github.com/repos/bool-/discord-ai-feature-builder/actions/runs/33592845695",
 "html_url":"https://github.com/bool-/discord-ai-feature-builder/actions/runs/33592845695"}
```

Confirmed on API versions `2022-11-28` **and** `2026-03-10`.

The `204` branch is still implemented as a fallback (GitHub Enterprise Server was **UNVERIFIED**): the
workflow sets `run-name` to include the request id, so the bot can find the run by name.

### Why polling and not webhooks

- A **Discord webhook posted from the workflow** creates a message the bot never sees, so the state
  machine silently diverges from reality — and it puts a second Discord credential on a runner that is
  executing an LLM over attacker-influenced text.
- **GitHub webhooks into the bot** would require a public HTTPS endpoint, a tunnel, TLS, and HMAC
  verification — a permanent inbound attack surface bought to avoid one `GET` every 15 seconds.
- Polling **recovers on its own**. A bot that was offline while a build finished catches up on next boot.
  A missed push notification is gone forever.

## 4. Octokit's types are wrong on the one call that matters

`octokit@5.0.5` resolves `@octokit/openapi-types@27.0.0`, which **does not contain
`return_run_details` at all**. So `octokit.rest.actions.createWorkflowDispatch(...)` types the endpoint
as 204-only, `res.data` narrows to `never`, and any property access is `TS2339`. Verified by compiling.

The shipping pattern — verified to typecheck clean *and* run:

```ts
const res = await octokit.request(
  "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
  { owner, repo, workflow_id: file, ref, inputs, return_run_details: true } as never,
);
const status: number = res.status;   // octokit types this as the literal 200
if (status === 204) return null;     // no body: fall back to run-name correlation
const parsed = DispatchRunDetails.safeParse(res.data);  // validate at runtime
```

The `as never` is the **only** sanctioned cast in the codebase. It is compensated by real runtime
validation, which is the right trade when the generated types are known-stale.

## 5. The 15-minute rule (the bug most likely to ship)

A Discord **interaction token is valid for about 15 minutes**. A Claude Code build takes **5–30 minutes**.

Therefore the "PR opened" message **cannot** be delivered through `interaction.editReply` or the
interaction webhook. It must be a fresh REST call against a `channel_id` / `message_id` persisted at
request-creation time.

This passes every test with a fast build and fails silently in production on a slow one. The core
contracts are designed to make the long-running delivery path *structurally different* from the reply
path, so an agent cannot reach for the wrong one by habit.

Related, and equally non-negotiable: an interaction must get a response **within 3 seconds**, so every
command declares an ack strategy (`instant` / `defer` / `defer-update`) rather than leaving it to chance.

**The half of this that was missing for a long time: a fresh channel message notifies nobody
either.** Getting the delivery path structurally right still left the requester watching a card
that silently changed twenty minutes later. `View` therefore carries an optional
`mentionUserId`, and the renderer emits `allowed_mentions: { parse: [], users: [mentionUserId] }`.
The `parse: []` default is unchanged and stays unchangeable — `@everyone`, `@here` and role pings
remain structurally impossible, whatever a user types into a request — and the single id that
*can* be pinged is one the bot persisted itself at request time. It never comes from user text.
That asymmetry is the whole design: a bot that cannot be made to ping anyone, that can still tell
one specific person their build finished.

## 6. Persistence: `node:sqlite`, WAL, compare-and-set

`node:sqlite` ships in Node 24 and needs no native build toolchain — verified with a real insert/select
and a compare-and-set (first `UPDATE` reports `changes=1`, the second `changes=0`).

That CAS is the actual defence against a double-clicked **Approve**, not a UI nicety. Every state
transition is a single guarded `UPDATE`; a caller that loses the race gets `null` and treats it as a
benign no-op.

`better-sqlite3` was rejected (native build defeats non-expert setup on Windows); JSON-file stores were
rejected (whole-file rewrite corrupts on a mid-write kill, unacceptable for approval state).

**WAL has an operational consequence that belongs in the ADR, not only in the runbook.** In WAL
mode the committed database is three files — `bot.sqlite`, `-wal` and `-shm` — so `cp bot.sqlite`
against a running bot silently omits everything not yet checkpointed, and copying all three
captures three different instants. Backups must therefore go through `sqlite3 … ".backup"` or
`VACUUM INTO`, which fold the WAL in and emit one consistent file; `docs/SETUP.md` carries the
commands and the restore order. This is the cost side of choosing WAL, and it is written down
because the failure only ever appears on the day somebody restores.

## 7. Security posture

1. **Actions script injection.** No `${{ }}` expression appears inside any `run:` block — enforced by an
   audit and re-checked on every edit. Values reach the shell through `env:` and are read as `"$VAR"`.
2. **The untrusted text is never a workflow input.** It is fetched at runtime into `.agent/issue.json`
   and wrapped in `<untrusted_<nonce>>` tags in a file the agent is told to treat as data, where
   the nonce is the per-request fence the bot minted and scrubbed from the user's text, so the
   user cannot close the tag. A body with no nonce marker, or with the nonce anywhere outside its
   sanctioned lines, is refused before the prompt is composed.
3. **Deny-all baseline.** The workflow starts at `permissions: {}`; the job grants the minimum.
4. **No `workflows` permission**, so the agent structurally cannot edit its own authorization path.
5. **Post-hoc path gate** fails the run if the diff touches `.github/**`, `.env`, `.npmrc`, or `.ssh/`.
6. **A daily run cap in two layers.** The bot counts today's runs (`BuildsPort.runsSince`) before
   dispatching and refuses in Discord, so a human reads the reason and no minutes are spent; the
   workflow counts them again and exits 1. Only the second bounds a hand-triggered or replayed
   `workflow_dispatch`, which never passes through the bot — so the two are not redundant, and
   deleting the workflow's copy as "already handled" would remove the only one that survives a
   compromised bot.
7. **Actions pinned by SHA**, since `v1` is a rolling tag re-pointed on every release.
8. **Separation of duty**: `builder.request` and `builder.approve` are distinct permission keys with
   distinct allowlists. Asking is not approving.
9. **The approval gate is enforced on GitHub, not only in the bot.** The dispatch carries an
   HMAC-SHA256 over
   `v2.<request_id>.<approval_id>.<issue_number>.<sha256 of the issue body>.<environment_name>.<approval_issued_at>.<repository>`,
   and `.github/scripts/verify_approval.py` re-checks it before any spend. Without this, "a human
   approved it in Discord" would be a property of the bot alone, and anyone able to dispatch a
   workflow could build any issue — including one they filed themselves.
   Binding the body hash also closes the *approve-then-rewrite* attack: editing the issue after
   approval invalidates the token. Verified against all three paths (valid, tampered body,
   missing key).

   **The token is single-use and expiring.** Dispatch inputs print in plaintext, so the token
   itself could be copied out of a finished run's log and re-dispatched. The `approval_id` is
   minted by the Approve click (or by `/request retry`), written in the same compare-and-set
   that wins the race, and consumed once by the workflow: a run-list scan keyed on the run name
   (which nothing inside a run can rename or delete) and then an atomic `refs/approvals/<id>`
   ref. `approval_issued_at` is signed at dispatch time and compared to the run's own
   `created_at`, with `APPROVAL_MAX_AGE_SECONDS` (default 900) as the limit. When the refused
   run is the bot's own re-dispatch after a lost answer, the bot adopts the earlier run instead
   of reporting a failure.

   The bot must hash the body **as the API returns it**, not the string it sent, or the two sides
   disagree the first time GitHub normalises anything.

10. **The bot can mention exactly one person.** `allowed_mentions.parse` is hardcoded `[]` and stays
    that way; the only addition is a `users:` array holding a single snowflake the bot persisted at
    request time. There is no path from user text to a mention, so `@everyone` in a request body is
    still inert.
11. **Two CI jobs read the pull request itself**, because `node --test` cannot:
    `require-operator-disclosure` (no `## Operator action required` section, or an empty one, fails
    the PR) and `require-test-change` (a `.ts` change under `src/` with no `*.test.ts` in the diff
    fails the PR, unless the body carries a `NO-TEST-NEEDED:` line). The second proves only that a
    test file was *touched* — a limit stated in the job, in AGENTS.md and in `docs/KNOWN-ISSUES.md`,
    because a check trusted for more than it does is worse than no check.

Verified live: dispatching with a malformed `request_id` failed at step 1 and **skipped the agent step
entirely**.

## 8. Rejected dependencies

| Rejected | Instead | Reason |
|---|---|---|
| `discord.js@dev` (15.0.0-dev.*) | `discord.js@14.27.0` | No stable v15; rolling nightlies only, and it raises the Node floor to >= 24.17.0 |
| `dotenv` | `node --env-file-if-exists` | Built in; we need none of dotenv's extras |
| `tsx` | native type stripping | On Node 24 it buys only enums/decorators — things `erasableSyntaxOnly` steers us away from |
| `vitest` | `node --test` | Runs `.ts` natively, no config |
| `better-sqlite3` | `node:sqlite` | No native build toolchain on Windows |
| `express` / `fastify` | — | The bot exposes **no** inbound HTTP surface |
| `eslint` + `typescript-eslint` | `oxlint` | `typescript-eslint` declares `typescript: >=4.8.4 <6.1.0`, excluding TS 7 |

## 9. Open items for the operator

- **Anthropic credentials are per requester, not per operator, and this bullet used to say the
  opposite.** It read: *"`ANTHROPIC_API_KEY` must be added to a GitHub **environment** named
  `ai-agent`."* That was true before bring-your-own-credentials and has been wrong since:
  `modules.builder.requireOwnCredentials` defaults to `true`, each person runs `/credentials set`,
  and the value is sealed into their own `user-<discord-id>` environment. A key on `ai-agent` is
  read only when an operator turns that switch **off**. The *scoping* half of the old sentence was
  always right and still is — a credential belongs in an environment, never in a repository
  secret, so it reaches only the job that names that environment.
- `APPROVAL_HMAC_KEY`, by contrast, **must** be a repository secret. It is verified inside whichever
  environment the build selected, and an environment-scoped copy resolves to an empty string in
  every per-user run — rejecting all of them with a key-length error that names nothing relevant.
- **No privileged intent is required.** The entry point is `/request new`, a slash command, and
  application commands and modal submissions arrive as interactions. A module may still declare a
  `$prefix` message hook, which does need `MessageContent` — that is opt-in via
  `DISCORD_MESSAGE_CONTENT=true`, and the bot **refuses to start** if a module declares a hook
  while the flag is off, rather than running with a hook that can never fire.
- A branch ruleset requiring one approving review would be ideal, since the agent opens PRs
  directly — but **rulesets need GitHub Pro on a private repo** and return 403 on a free account.
  See `docs/SETUP.md` for what protects the repo instead.
