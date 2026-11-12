# Known issues

Findings from an adversarial audit that are **confirmed and not yet fixed**. Each was reproduced
against the real code by an independent verifier, not merely asserted.

This file exists so that nothing gets quietly dropped. If you are picking work up, start here.

## Fixed already (for context)

These were confirmed critical/high and are done — listed so you can tell them apart from what
remains:

| Was | Fix |
|---|---|
| No `migrations/` existed, so `m_builder_requests` was never created | migrations added; boot now quarantines `migrations: true` with no `.sql` |
| `BuildRow` read camelCase off snake_case columns — every multi-word field always `undefined` | columns aliased; `module.integration.test.ts` runs a real DB |
| `reconcile()` re-adopted nothing | consequence of the column bug; fixed with it |
| Every rate limit was a no-op (`ALLOW_ALL` wired in main) | real persisted gate in `core_ratelimits` |
| `checkTableOwnership` refused every UPSERT (`DO UPDATE SET`) | `SET` exempted; foreign-table upserts still refused |
| Build rows never reached a terminal state, leaking a concurrency slot per successful build | `finish()` on success/failure/cancel/death |
| A failing job tick became an `unhandledRejection` and killed the bot | tick failures are logged, the next tick runs |
| `npm run check` never booted the registry, so boot-fatal conflicts shipped green | `registry.boot.test.ts` |
| `$request` was honoured in every channel | `requestChannelIds` enforced; entry point is now `/request` |
| AGENTS.md cited lint rules that did not exist | `conventions.test.ts` |

### The "wired but never called" round

An audit found one pattern repeated across the codebase: **the port was built, tested, and never
attached to a command.** Each of these was production code whose only caller was a test.

| Was | Fix |
|---|---|
| `AccessPort.grant/revoke` had no caller — no module can mint another module's `PermissionRef`, so no module could offer the grant, and `builder.approve` (fallback `nobody`) was ungrantable to anyone but `DISCORD_OWNER_ID` | `grantByKey`/`revokeByKey` take a **string** and the adapter proves it against the boot catalog; `/access grant`, `/access revoke`, `/access list` ship |
| `'expired'` was declared in three places and written by nothing, so `awaiting_approval` was permanent and two unclicked requests bricked `/request` for a guild forever | hourly scheduled `expire` job (`JobSpec.schedule`'s first user); `approvalTtlMs` default 48h |
| `maxDispatchAttempts` compared against a counter nothing incremented — the ceiling never fired | `countDispatchAttempt` raised **before** the dispatch call, so a crash mid-dispatch still costs an attempt |
| A **failed** run returned a *retryable* error, so the runner re-polled a settled failure for up to four more hours while the card still read "Building…" | non-retryable conflict; the job dead-letters at once and draws the failure card |
| A deliberate agent **refusal** (successful run, no PR, explanation on the issue) was retried until the 6h deadline and then reported as "Build failed" | `succeeded_at` anchors a `prGraceMs` window (default 120s); after it, "Refused — no changes were made", terminal state `done`, not `failed` |
| Every card had `links: []` — the run URL was read off the payload and discarded, so "your build failed" carried nothing to open | `RunStatus` carries `runUrl` on **every** arm; `issue_url`/`run_url` persisted for the job frame that renders the card later |
| A **draft** PR (the agent's "I could not finish") was reported as an ordinary opened PR — the one wrong answer of the three, since it invites merging incomplete work | `PrRef.isDraft` populated from GitHub's `draft`; draft card says what remains |
| Boot validated Discord and refused to start on a bad token, but made **no GitHub call at all** — an expired PAT, a deleted `GITHUB_REF` or a renamed workflow first surfaced as a user's build "timing out" hours later | three-request boot preflight; 401/404 on repo or workflow is fatal, everything else warns |
| The agent's own quality gate (`npm run check`) could not run — no `setup-node`, no `node_modules` | `setup-node` + `npm ci --ignore-scripts`, after the refusals, before the agent |

### The "twenty minutes of silence" round

The machinery worked; nobody was ever *told* anything. An audit put it as: **"Twenty minutes of
silence, and the outcome is delivered by an edit that notifies nobody."** A requester submitted,
waited, and had to go back and look. There was no history, no cancel, no retry and no ping.

| Was | Fix |
|---|---|
| The outcome arrived as a message nobody was notified about — the requester had to remember to scroll back to the card | Two halves, and **only together do they work**. (a) `View.mentionUserId`; the renderer emits `allowed_mentions: { parse: [], users: [id] }` and puts `<@id>` in the message `content`. `parse: []` is untouched, so `@everyone`/`@here`/role pings remain structurally impossible; the only pingable thing is one snowflake **the bot persisted itself**, never one read out of user text. (b) **Discord notifies on message CREATE, not on EDIT** — so a card rewritten in place from “Building” to “Pull request opened” renders the mention and notifies nobody. Every terminal outcome therefore *also posts* a short notice carrying the mention (`src/modules/builder/notify.ts`). No mention, no notice: an extra message that pings nobody is litter |
| No history. Once the card scrolled away, a requester had no way to ask the bot what they had asked for or what became of it | `/request list` — your requests in this server with state, age and links; approvers see everyone's |
| No cancel. A request nobody wanted any more held a `maxConcurrentPerGuild` slot until an approver pressed Reject or the 48h sweep took it | `/request cancel`, for anything still `awaiting_approval` — closes the issue `not_planned`, resolves the card, frees the slot |
| No retry. A build that failed on a transient GitHub error had to be retyped from scratch | `/request retry` re-files the same text as a new request. Deliberately a **new approval**, because a retry spends money exactly like a first attempt |
| `AuditLog.recent`/`forGuild` and `JobSystem.stats` were implemented, tested, and **called by nothing** — the same "wired but never called" shape as the round above | new `AdminPort` (capability `admin`) and `/admin jobs` / `/admin audit` |
| The daily run cap was discovered by failing: the card said "Building…", then the run exited 1, with the reason in an Actions log the requester usually cannot open | `BuildsPort.runsSince` — the bot counts today's runs before dispatching and refuses in Discord, naming the number and the reset. The workflow's own cap **stays**: it is the layer that does not trust the bot |
| Nothing checked that a contributor added a test, although AGENTS.md has always demanded one | `require-test-change` in `ci.yml` — see the honest limits under "Open — low" |
| **The agent was never handed either of the two things this repo built for it.** The composed prompt said *"Read AGENTS.md and CONTRIBUTING.md first **if they exist**"* — a hedge that made the one guide that does exist optional, while pointing at one that never has. And nothing mentioned `npm run scaffold`, the generator written specifically so an agent starts from a module that already compiles and passes a test | the prompt now names AGENTS.md as the contract, says plainly there is no CONTRIBUTING.md, and makes `npm run scaffold -- <id> [--db]` the required way to create a module folder — with the reason (your first `npm run check` measures your change, not your boilerplate). AGENTS.md says the same to human contributors |
| **`docs/SETUP.md` told operators to back up a live WAL-mode SQLite file by copying it.** This was the one documentation bug that loses *data* rather than time | replaced with `sqlite3 … ".backup"` / `VACUUM INTO`, plus what to do about the `-wal`/`-shm` files. See below for what the old advice actually got wrong |


### The "make what it says true" round

The previous round made the bot *talk*. This one makes what it says **true**, and closes the one
race that could oversubscribe a guild. Every item was a case where a shipped sentence was not so.

| Was | Fix |
|---|---|
| **`/request cancel` cancelled the bot's interest and nothing else.** It stopped the poller, freed the slot, closed the issue and drew a card reading "cancelled" — while the Actions run carried on to the end, spending the **requester's own** Anthropic credits and a daily-cap slot on a result nobody would ever look at | `BuildsPort.cancelRun` asks GitHub to stop the run. `jobs.cancel` and `cancelRun` are both needed and neither substitutes: the first stops work in this process, the second stops work where the money is. The attempt happens **after** the compare-and-set, so a cancel that loses the race to an approver does not kill the run that approval just bought |
| A cancel could not tell **202 Accepted** from **409 Conflict**, so "we stopped it" and "it had already finished, and it may have opened a pull request" were the same sentence | `CancelOutcome` is a two-arm union and **both arms are `Ok`** — 409 is not a failure, it is what a user gets for clicking one second after their build finished. Mapping it to an `AppError` would put "GitHub refused that, ask an admin" in front of somebody for whom nothing went wrong. 409 also joined `DO_NOT_RETRY`, or the commonest success path through that endpoint would have cost four requests and ~14s of backoff |
| **`/request retry` on an expired request re-armed it under a CLOSED issue.** Expiry closes the issue `not_planned`; the retry then drew a fresh Approve/Reject card pointing at it, so the product said "waiting for a decision" while GitHub said "not planned" — and the approver's one way to check what they were funding contradicted the card asking them to fund it | `IssuesPort.reopen`, sending `state: 'open'` **and** `state_reason: 'reopened'`. Sending the state alone leaves the expiry's `not_planned` stamp in place, so the retry would still be discussed under an issue GitHub renders as declined. Idempotent, so a retry of a retry needs no read first |
| **`/admin jobs` and `/status` could not tell a wedged job from a working one.** `running: 1` was the same sentence for a build that started four seconds ago and one wedged since Tuesday, and the card's honest advice was "run it twice and see if the number moves" | new core migration `0002_jobs_started_at.sql`. **Why a new column and not `updated_at_ms`:** that column is a *lease* liveness signal — the runner rewrites it on every renewal and every heartbeat — so a job hung on a socket reads as "just now", which is reassuring and false. `started_at_ms` is written once at claim and never again. `/status` now degrades and names the job |
| **The two daily caps had nothing reconciling them.** `modules.builder.dailyRunCap` and the `AGENT_DAILY_RUN_CAP` repository variable both default to 4 and drift silently; the bad direction dispatches builds the workflow then refuses | `BuildsPort.repositoryVariable` reads it once at boot; the comparison surfaces in `/status`, the log and `/admin audit`. Both caps deliberately **stay** — see "two caps, one of which does not trust the bot" |
| **The per-guild concurrency cap was advisory.** See the corrected entry below — the mechanism in the old write-up was wrong | `claimSlot` is one `INSERT … SELECT … WHERE (count) < cap`, and `draft` now occupies a slot |
| **Nothing drove `attachRouter`** — the 3-second acknowledgement, the watchdog, the guard order and the handoff had never executed in a test | `router.test.ts` part two drives the real `attachRouter` from a fake gateway. It found a live defect; see below |
| **The ack watchdog double-acknowledged, leaving a permanent "Bot is thinking…".** Found by the work above, and fixed here | discord.js sets `interaction.deferred` only *after* its REST POST returns, so for one round trip an interaction was acknowledged at Discord and read as unacknowledged locally. A handler finishing in that window (≈2.5–2.8s — precisely the mis-declared `ack: 'instant'` the watchdog exists to rescue) took the `reply()` branch, got Discord 40060, and the failure was logged and swallowed — leaving the user with a "thinking…" nothing would ever edit. `interactionScopedReply` now tracks the in-flight acknowledgement, reports it from `acknowledged()`, and makes `send`/`showForm`/`close` wait for it. Fixed in the reply object rather than the watchdog so it closes for **every** caller |
| **The ack watchdog rescued a late handler PUBLICLY.** Sibling of the row above, found the same way and fixed in the same pass | The watchdog fires *before* the handler has said anything, so it cannot know what is coming — and a defer fixes the visibility of the reply that follows it. It called `deferReply({ ephemeral: false })`, so a handler about to return an ephemeral view — a permission denial, a credential error, an `/admin audit` listing — published it to the channel instead. Now defers ephemerally: guessing private costs a public answer its audience on a path that is *already* degraded (the handler broke its own `ack: 'instant'` contract), while guessing public is a disclosure nobody asked for and nobody can undo. No shipped command declares `instant`, so nothing leaked; it is fixed because this repo is extended by agents on purpose and the type system gave the next author no warning |
| `/admin audit` stopped at 20 rows, could not be filtered, and showed only the action prefix a module chose for itself | paging (`page:`), filters (action prefix / actor / decision layer), and a `module` column bound at wiring time — `AuditPort` is minted per module, so `module_id` cannot be claimed while `action` is a string the caller picked |

**What the integration itself caught, which neither half could have.** The four work-streams were
file-disjoint and each was green alone. Two of them had nonetheless designed *different* contracts
for the same seam:

- `#core/ports` shipped `RunningJob` as `{ moduleId, type, startedAtMs }`; the `admin` module read
  `.name` and `.ageMs` off it. Had the field stayed optional, `/admin jobs` would have silently
  omitted the one thing it was extended for and `/status` would never have degraded — a fix in
  name only, with both suites green. **Resolved:** `RunningJob` carries `ageMs` too (the adapter
  subtracts, because the adapter is the layer that legitimately owns a clock — `health()` is
  called with no time and `admin` declares no `clock` capability), and `admin` derives the
  `<moduleId>:<type>` display name rather than the port storing an identity twice.
- The builder asked for `agentDailyRunCap(): Result<number | null>`; the port shipped
  `repositoryVariable(name): Result<RepositoryVariable>`, a three-arm union. **The port's shape
  won, and it is better:** `number | null` cannot express `not-a-number`, and that arm is the one
  that matters most — the workflow guards with `case "$DAILY_CAP" in ''|*[!0-9]*) … exit 1`, so a
  value like `4.0` means *every* build dies in its first seconds. The builder gained a
  `repository-cap-unusable` arm that warns and audits.

Both were caught by the type system **only because the fields were made required**. The
optional-companion bridges the builder used to let its work land ahead of the port have been
removed for the same reason: an optional method that resolves to "the bot cannot ask" degrades to
a plausible, wrong sentence instead of failing the build.

**What the backup instruction got wrong, stated properly** — because "use `.backup` instead" is
a fix, not an explanation, and the next person to write a backup line needs the explanation.

The bot opens SQLite in **WAL** mode. In that mode the committed database is not one file: it is
`bot.sqlite` plus `bot.sqlite-wal` (committed transactions not yet checkpointed back) plus
`bot.sqlite-shm` (the shared index into the WAL). Copying `bot.sqlite` alone from a running bot
therefore takes a snapshot that is **missing every transaction still in the WAL** — approvals,
grants, queued jobs — and copying all three files one after another takes three snapshots at
three different instants, which is worse: the result can be internally inconsistent, may open
without complaint, and announces itself only on the day you restore it. `.backup` and
`VACUUM INTO` take a read lock and emit a single file with the WAL already folded in.

The instruction was not merely incomplete. It was the shape of advice that appears to work every
time you test it — a copied file opens fine when the WAL happens to be empty — and fails exactly
once, under load, when it is the only copy you have.

---

## Open — high

### 1. ~~The per-guild concurrency cap has a check-then-act race~~ — FIXED

`src/modules/builder/module.ts` — the hook reads `countActive(guildId)`, then does async work
(issue creation) before `insertDraft` commits a row in a state `countActive` counts. Several
`/request` submissions arriving together all pass the check before any of them is visible.

**Impact:** a burst bypasses `maxConcurrentPerGuild`.

> **CORRECTION TO THE MECHANISM, and it matters because the old sentence sends you to fix the
> wrong thing.** The write-up above says the row was committed *"in a state `countActive` counts"*.
> It was not, and that was the whole bug. `insertDraft` wrote `state = 'draft'`, and `activeCounts`
> counted `('awaiting_approval', 'dispatching', 'running')` — so a submission became countable only
> at `recordIssue`, **after** an issue creation and a card post. The gap was never the few
> synchronous lines between the count and the insert; it was the two network round trips between
> the insert and the row becoming visible. Anyone who read the original entry and went looking for
> a missing transaction would have found the code already correct and moved on.

> **CORRECTION (this entry was wrong, and wrong in the dangerous direction).** It previously read:
> *"It bounds concurrent builds, not requests, and approval is still required for each — so this is
> a noise and queue-depth problem rather than an unbounded-spend one."* That is backwards on both
> counts, and the mistake hid a permanent denial of service for the entire life of the entry.
>
> `countActive` counted `('awaiting_approval', 'dispatching', 'running')` — so it bounded
> **unresolved requests**, not concurrent builds. And `'expired'` was declared in three places (the
> `BuildState` union, the SQL `CHECK`, the terminal-state guard) and **written by nothing**, so
> `awaiting_approval` was in practice a permanent state. With `maxConcurrentPerGuild` defaulting to
> **2**, two requests that nobody ever clicked took `/request` away from that guild *forever*, with
> the message "Too many builds are already in flight here" — about builds that did not exist and
> never would.
>
> Worse, the only release valve was **Reject**, gated on `builder.approve`, whose fallback is
> `nobody` — and no `/access` command existed, so on a fresh install nobody could be granted it.
> The correct severity was not "noise and queue-depth"; it was *the flagship command bricks itself
> and cannot be unbricked from inside the product.*

**Status: BOTH are now fixed.** An hourly scheduled `expire` job now moves
`awaiting_approval` rows older than `approvalTtlMs` (default 48h) to `'expired'`, closes the issue
`not_planned`, and rewrites the card with its buttons disabled. `countActive` is replaced by
`activeCounts`, which reports waiting and running separately so the refusal can say which problem
the reader actually has. `/access grant builder.approve @someone` now creates a second approver, so
Reject is reachable on a fresh install too.

**The race is closed by two changes, and it needed both.** `draft` now occupies a slot, and
`claimSlot` is a single `INSERT … SELECT … WHERE (SELECT count(*) …) < cap` — so the row is visible
to the next reader's count in the same statement that admitted it. `VALUES` cannot carry a
predicate, which is precisely why the previous version had to check separately. `insertDraft` was
**removed** rather than left beside it: an unguarded insert left in a repo is an unguarded insert
somebody eventually calls, and there is now no way to add a row to `m_builder_requests` that does
not pass the cap. `/request retry` re-enters the active set through two more doors
(`reopenForDispatch`, `reopenForApproval`); both claim inside their own guarded `UPDATE`.

**The hazard the fix introduces, and the three things that answer it.** Claiming before the network
call is what makes the cap real, and it means a submission that dies after the claim takes a slot
with it. So: both post-claim failure paths call `releaseDraft` (and the card-post failure also
closes the issue it just filed, which would otherwise be a request existing only on GitHub);
`reconcile()` releases stale claims at boot, for a crashed process; and the hourly sweep releases
them too, for a process that hangs without dying. `DRAFT_STALE_MS` is 5 minutes against a real
lifetime of about a second — deliberately loose, because releasing a slot out from under a merely
slow submission would be a *different* way past the cap.

> **HOW MUCH OF THIS IS ACTUALLY PROVEN, stated precisely, because the obvious test does not prove
> it.** `ctx.ports.db` is synchronous `node:sqlite` and the bot is one process, so "count and write
> in one statement" and "count and write in two statements with nothing awaited between them" are
> indistinguishable to an ordinary async test — no other JavaScript can run between two synchronous
> calls. Verified by mutation: reverting `claimSlot` to a synchronous check-then-insert left **all
> 198 builder tests green**. The burst tests are therefore pinning the half that was historically
> broken — that a `draft` row is countable at all — and were not pinning atomicity.
>
> `concurrency.test.ts` now also drives the repo over a `DbPort` wrapper that lets a competing
> writer in immediately **after every read returns**, so the value a reader just received is stale
> by the time it acts on it. An implementation with a separate read then oversubscribes for real
> (the mutant fails with `actual: 2, expected: 1`); one whose count lives inside the write has no
> read to interleave at. The control assertion — that the injector fires on a read the code really
> does perform — is not optional, since a hook that silently never fired would make the whole test
> pass vacuously.
>
> **Still not proven offline:** behaviour under two *processes* against one database file. SQLite
> serialises the single statement under one write lock, which is the reason to prefer it, but
> nothing here demonstrates that.

> **`/request cancel` was, and remains, the recovery path** rather than the fix: it lets the person
> who filed a request withdraw it while it is still `awaiting_approval`, freeing the slot without
> waiting for an approver's Reject or the 48-hour sweep. It made an over-subscribed guild
> recoverable by anyone; it never made oversubscription impossible.

### 2. A permanent GitHub failure is retried for six hours and then reported as a timeout

`src/modules/builder/module.ts` — the dispatch path collapsed every error into
`{kind: 'retry'}`. A 401, a 403 from a revoked token scope, or a 404 from a deleted repo is not
transient, but it was retried every `pollIntervalMs` until `buildDeadlineMs` (default 6h), and the
user was finally told the build timed out.

> **CORRECTION.** This entry implied `maxDispatchAttempts` (default 3) put a partial ceiling on the
> retrying. It did not put *any* ceiling on it, because the counter it reads was never incremented.
> `dispatch_attempts` was created by `0001_init.sql` with `DEFAULT 0`, inserted as `0`, aliased into
> `BuildRow`, and compared against `cfg.maxDispatchAttempts` on every pass — and **nothing in the
> repository ever wrote to it.** `grep -rn 'dispatch_attempts *=' src/modules/builder/` returned
> nothing. The guard read `0 >= 3` forever, so it was dead code that read like a live control, and
> the six-hour deadline was the *only* bound in play.

**Status: FIXED.** `countDispatchAttempt` now raises the counter immediately **before**
`builds.dispatch(...)` — not after — so a crash, SIGTERM or lease expiry between the request and
the response still costs an attempt, which is the one case a ceiling exists to bound. It
deliberately does not bump `version`: that CAS token belongs to the transitions that race with
humans. Separately, the poll path no longer returns a retryable `upstream` error for a run that
already **failed**; it returns a non-retryable conflict, so the job dead-letters at once and the
failure card is drawn immediately instead of after four more hours of polling a settled run.

## Open — medium

### 3. ~~The Message Content intent check tests the wrong thing~~ — MOOT

Both guards read `client.options.intents`, the set the process REQUESTED, so the diagnostic was
unreachable and a missing grant surfaced as a token error instead.

This stopped mattering when the entry point became `/request`: the bot no longer requests the
intent at all, so there is nothing to misdiagnose. The guards remain only for the opt-in
`DISCORD_MESSAGE_CONTENT=true` path, and main.ts now refuses to start if a module declares a
message hook while that flag is off — which is a louder and earlier signal than the runtime
detection originally proposed here.

Still worth doing if anyone uses the opt-in path in anger: detect an empty `content` on the first
guild MessageCreate and log the actionable line once.

### 4. ~~Nothing drives `attachRouter`~~ — FIXED, and it found a live defect

`src/adapters/discord/router.test.ts` covers pure helpers only. The 3-second acknowledgement path,
the watchdog, the permission-denied path and the handoff repair have never executed in a test.
This is the layer where the interaction deadline lives, so it is the layer least safe to leave
unexercised.

**Status: FIXED.** An `EventEmitter` shaped like a discord.js `Client`, with interaction objects
that model discord.js's *real* response semantics, now drives the shipped `attachRouter`: the
subscription and its removal, per-kind dispatch, the acknowledgement ordering (asserted as an
ordered trace, so "the ack left while the handler was still blocked" is a statement about
interleaving rather than about two independent logs), the watchdog on a real timer, the guard order
at invocation time, the rate-limit spend, crash containment, unknown commands and `custom_id`s, the
message hook, autocomplete, and the handoff's `SURFACE_KEY` injection.

**The detail that made it worth doing properly:** the fake sets `deferred` only *after* its
simulated round trip, exactly as discord.js does. A convenient fake that set it synchronously would
have made the router look correct — and would have hidden the double-acknowledgement defect the
work actually found (see the round table above, now fixed in `interactionScopedReply`).

### 5. ~~The agent workflow may not be able to run `npm run check`~~ — FIXED

`.github/workflows/agent-implement-request.yml` told the agent to run the repo's checks, but the
job had no `actions/setup-node` and no dependency install, so a fresh checkout had no
`node_modules`. Whether it succeeded depended on the runner image and on the agent choosing to run
`npm ci` itself — and when it did not, the run opened a pull request whose only quality gate had
never executed, which is worse than a failed run because it looks finished.

Two steps now run **after** every refusal (the approval MAC, the credential check, the daily cap)
and **before** the agent: `actions/setup-node` pinned to the same commit SHA `ci.yml` uses, then
`npm ci --ignore-scripts`. The prompt also tells the agent the toolchain is already installed, so
it does not spend turns reinstalling. `src/adapters/github/agent-workflow.test.ts` asserts the
ordering, the shared Node major, the shared SHA, and that every `uses:` in both workflows is
pinned to a 40-character commit SHA.

### 6. ~~The prompt boundary is a static tag, while an unforgeable nonce already exists~~ — FIXED

**Status: FIXED (RFC-001 phase 0, PR 0.2).** The compose step now reads the `fenceNonce` out of
the trailing `<!-- build-request v1 nonce=… -->` marker in the body the MAC already bound, refuses
a body with no marker, with the nonce anywhere outside its three sanctioned lines, or with the
nonce in the title, and names the boundary tag `<untrusted_<nonce>>`; the action's `prompt:`
names the same tag through the step output. `agent-workflow.test.ts` pins the shape and
`compose.test.ts` runs the step's script under `sh` against four fixtures. The original entry
follows.

`.github/workflows/agent-implement-request.yml` wrapped the issue in
`<untrusted_user_request>` — a fixed string an author can close and then write text that appears to
be outside the boundary. The issue body already contains a per-issue **nonce fence** (`fenceNonce`,
minted per request) which cannot be guessed.

**Impact:** partial — the tool allow-list, the deny rules, the missing `workflows` permission and
the post-hoc path gate are all still in force, so this is defence-in-depth rather than the only
wall.

**Fix:** have the workflow delimit with the issue's own nonce rather than a constant tag.

## Open — low

- **A second bot instance steals live leases.** `recover()` re-queues `state='running'` rows with
  no predicate on `lease_until_ms > now`, so starting a second process against the same database
  double-runs in-flight jobs. Mitigated by "one process per database file" in `docs/SETUP.md`;
  a lease predicate would make it structural.
- **Blind-dispatch correlation is attempted with zero delay.** On the 204 path the bot looks for
  the run immediately; a slow-to-appear run is not recorded and the next tick dispatches again.
  Only reachable on API versions that do not support `return_run_details`, which is not the
  configured path.
- ~~**`recordRun` writes the job deadline into `updated_at`**, so `stuck()` cannot see the row for
  six hours.~~ **FIXED** — it now stamps `clock.now()`. It was being passed `jctx.deadlineAtMs`,
  which wrote a timestamp hours in the future and hid the row from the reconciler's
  `updated_at < before` sweep for exactly that long.
- **Discord's 6000-character aggregate embed limit is unchecked**, and `/help` silently drops
  modules past 25 fields. **Closer than it was:** this round adds a sixth module and four
  subcommands, so the 25-field ceiling is nearer than when the entry was written. Still not
  reached — six modules — but the failure mode is a silent truncation, so it will not announce
  itself when it is.
- **`require-test-change` proves only that a test file was touched.** Not that the test exercises
  the change, not that it fails without it, not that it asserts anything: `test('x', () => {})`
  passes it, and so does deleting a test. This is stated in the job's own comment, in AGENTS.md
  and here, because the failure mode of a cheap check is not that it is cheap — it is that
  somebody later believes it was expensive. A real version would run the suite against the base
  commit with only the test file applied and require it to fail; that costs a second full `npm ci`
  plus a test run per pull request, which is the trade this deliberately did not make.
- **The `NO-TEST-NEEDED:` escape hatch is unaudited.** Anything after the colon passes. It is
  visible in the PR body where a reviewer reads it, which is the whole design, but nothing counts
  how often it is used or by whom — an agent that learns to write the line every time would not be
  detected by anything in this repo.
- **The requester ping is best-effort, and nothing can tell you it failed.** The outcome notice
  mentions one persisted user id. If that user has left the guild, muted the channel or blocked
  the bot, Discord silently does not notify them, and the API reports success either way. A
  departed member also renders as a raw `<@id>` rather than a name. `/request list` remains the
  reliable path, which is why it is not merely a convenience.
- **A terminal outcome now costs two messages, not one.** The card is edited in place (so a
  request stays in one spot in the scrollback) *and* a short notice is posted (because only a
  CREATE notifies). A busy channel therefore sees roughly twice the builder traffic it used to.
  The alternative — posting the whole card again and leaving the old one stale — would put two
  contradictory records of the same request in the channel, which is worse. If the notice ever
  needs suppressing, `announce()` in `src/modules/builder/notify.ts` is the single choke point.
- **The posted notice is fire-and-forget.** `announce()` swallows a failed `discord.post`: by
  the time it runs, the row is terminal and the money is spent, so a channel the bot can no
  longer post in must not turn a finished build into a failed one. The consequence is that a
  permissions regression on the request channel degrades silently back to the pre-round
  behaviour — the card is still correct, nobody is told. `/admin audit` shows the outcome was
  recorded; nothing records that the telling failed.
- ~~**The daily cap is now two numbers with nothing reconciling them.**~~ **FIXED.**
  `modules.builder.dailyRunCap` and the `AGENT_DAILY_RUN_CAP` repository variable both default to
  4, and nothing checked they agreed; the bad direction dispatches builds the workflow then
  refuses. `reconcile()` now reads the variable once at boot — **in every configured repository**
  since RFC-001 PR 2.4, each compared against the bot's one number — and `/status` reports the comparison,
  with a warning and an audit row on the bad direction only — warning on the harmless direction is
  how an operator learns to ignore the warning that matters. **Both caps stay**, and the reason is
  in `docs/SETUP.md`: the workflow's is the only bound on a *replayed* dispatch, which never goes
  through the bot.
  - The check reads a **repository variable, not a secret** — Actions variables are plaintext by
    design and appear in run logs — and it needs `Variables: read` on `GITHUB_TOKEN`, which
    nothing else in the bot uses. Without it the check degrades to "the repository cap could not
    be read" and **nothing else changes**: the workflow's own cap is the authority, and a bot
    stopped by an optional permission would be the mistake `resolveBuildPayer` already learned.
  - It is placed **last** in `reconcile()` deliberately: `main.ts` wraps that call in try/catch, so
    anything that throws costs everything after it, and durable orphan recovery must not sit behind
    a diagnostic that reaches the network.
  - The comparison is a pure function, so all its arms — including `repository-cap-unusable`, which
    no live repository will produce on demand — are reachable in a test without GitHub.
- **`/admin audit` answers over a 500-row window, not the whole table.** `AdminPort.recentAudit`
  has no offset and no server-side predicate, so paging past page 1 over-reads and slices, and a
  filter is applied in memory over the newest `MAX_AUDIT_SCAN` (500) rows *for that guild*. "Every
  denial in the last week" is answered exactly when that week fits in 500 decisions. **It is a
  stated limit rather than a silent one:** whenever the window fills, the card says so and says how
  far back it reached ("Searched the newest 500 decisions here, back to 6d ago. Anything older than
  that was not looked at"). A `beforeId` keyset cursor plus `action`/`actorId`/`layer` predicates on
  the port would close it without changing anything above the port call. Consequently
  `MAX_AUDIT_PAGE` (50) is wider than the window can always satisfy: at `limit:20` the reachable
  depth is page 25, and asking beyond it returns the honest "past the end" card rather than an
  error.
- **Paging is a command argument, not a button, and on mobile that costs a re-type.** A pager
  button would have had to carry the whole query in one `custom_id` entity segment, which
  `encodeActionRef` caps at 40 characters — an actor snowflake (20) plus an action prefix (40)
  exceeds that on its own. The choice was a pager that keeps your filter or one that silently drops
  it, and an "Older →" that quietly discards the filter you set is the class of untruth this round
  existed to delete. Real UX cost, deliberately taken.
- **The `builder.daily_cap_drift` audit row is written with `guildId: null`**, because a
  repository-wide configuration fact is not a guild's. `/admin audit` scoped to a server will not
  show it; only the unscoped view (a DM, i.e. the application owner) will. Correct, and worth
  knowing before somebody goes looking for it in a server. Since PR 2.4 the row carries `repo`
  (`owner/repo`), so with several repositories it says whose variable to change.
- **`releaseStaleDrafts` logs and does not audit.** A reclaimed draft has no user-visible
  consequence and the rows span guilds, so a per-row audit entry looked like noise — but it does
  mean `/admin audit` cannot show that a crash cost a guild a slot for up to five minutes.
- **The router tests model discord.js 14.27, they do not run it.** The fake interactions reproduce
  that version's behaviour because its source was read — in particular that `deferReply` sets
  `deferred` only after its REST call resolves, which is the fact the whole acknowledgement
  contract rests on. A discord.js upgrade that changed it would leave these tests green while
  production changed. The pinned version in `package.json` is what makes that acceptable; an
  upgrade PR should re-read `InteractionResponses.js` against the comments in
  `router.test.ts` and `client.test.ts`.
- **~~The approval MAC is a non-expiring bearer token, and it is VISIBLE IN THE RUN LOGS.~~ FIXED
  (RFC-001 phase 0, PR 0.1).** The token now signs a per-approval `approval_id` persisted on the
  request row and an `approval_issued_at`; the workflow's "Consume the approval" step refuses an
  id any earlier run carried (run-list scan the agent cannot undo, then an atomic
  `refs/approvals/<id>` ref), and `verify_approval.py` refuses a token issued more than
  `APPROVAL_MAX_AGE_SECONDS` (default 900) before the run was created. The bot adopts its own
  earlier run when its re-dispatch is the thing refused. The original entry is kept below because
  the reasoning about which cap bounds a replay is still the right way to think about it.

  Verified by dispatching a probe: `workflow_dispatch` inputs are not secrets — they appear in the
  run title, the REST API and the job logs in plaintext. GitHub masks `secrets.*`, not `inputs.*`.

  So replaying an approval does not require intercepting anything, only repo **read** access:
  copy `approval_token` out of a previous run's log and re-dispatch. It cannot build an
  *unapproved* issue (the MAC binds the issue body, and only an approved request ever produces
  one), so the exposure is spend amplification on an already-approved issue, bounded by the
  daily run cap (default 4). On a private repo, anyone with read access is already trusted — but this is
  precisely why the MAC should be single-use.

  > **CORRECTION to the bound, now that there are two caps.** The bot also checks the daily cap
  > before dispatching (`BuildsPort.runsSince`, `modules.builder.dailyRunCap`). That check does
  > **nothing** for this entry and it would be easy to read it as if it did: a replay is a direct
  > `workflow_dispatch`, and it never goes through the bot. The bound on a replay is, and remains,
  > the cap **inside the workflow** — which is exactly why that one must not be removed as
  > "redundant" now that the bot checks too. Two caps, one of which does not trust the bot: only
  > the second one is load-bearing here.

  **Fix:** `newApprovalId()` is already minted, audited, and then unused. Persist it, include it
  in the signed tuple, and have the workflow reject an id it has seen before — or simply expire
  the MAC, since an approval that is minutes old is the only one worth honouring.

  **Corollary, and the important one:** never pass anything secret as a dispatch input. A
  per-user Anthropic key supplied this way would be printed to every collaborator.

---

## Several repositories (RFC-001 phase 2)

One bot serving servers that build into different repositories (`GITHUB_REPOS_JSON`, `/repo use`,
credentials per repository, caps per repository — `docs/SETUP.md` section 8).

### Fixed in this phase

| Was | Fix |
|---|---|
| **Two servers on one repository could dispatch more builds than its workflow keeps.** The workflow's `concurrency: agent-implement` group holds one running and one pending run and GitHub silently cancels the older pending one when a third queues; `maxConcurrentPerGuild` bounds one server, never the repository | `maxConcurrentPerRepo` (default 2), counted over `dispatching`/`running` per repository and claimed **in the same UPDATE** as the Approve click (`approveForDispatch`) and `/request retry` (`reopenForDispatch`). `concurrency.test.ts` runs the competing-writer `DbPort` wrapper over both claims: a check-then-act version oversubscribes and fails |
| The daily cap's drift check read only the **default** repository's `AGENT_DAILY_RUN_CAP`; a set with no default was never compared | every configured repository is read at boot; `/status` has a line per repository with its own comparison and its last-read daily count; the audit row names the repository |

### Open — low

- **The repository cap refuses; it does not queue.** Past `maxConcurrentPerRepo` the Approve click
  is refused (nothing approved, nothing spent, the card stays live) and the approver has to click
  again later. Nothing tells them when a slot frees. Queuing approved-but-undispatched builds would
  need a new state between `awaiting_approval` and `dispatching` — a migration and a CHECK change —
  for a refusal that names the repository and says what to do.
- **A build waiting for the daily-cap reset holds a repository dispatch slot.** It is `dispatching`
  until the UTC reset. With the day's runs spent that costs nothing (nothing could start anyway),
  but the refusal another approver sees says "running or about to start", which is true only in the
  sense that it will start at midnight UTC.
- **One bot number, many repository variables.** `modules.builder.dailyRunCap` is a single value
  applied to every repository; there is no per-repository override. Repositories whose
  `AGENT_DAILY_RUN_CAP` differ from each other will show drift on at least one line. A per-entry
  `dailyRunCap` in `GITHUB_REPOS_JSON` would close it; it is a core config change nobody has needed.
- **The daily count in `/status` and `/repo show` is "as last read".** It is the number the
  dispatch check last fetched for that repository today, so runs started outside the bot (a manual
  `workflow_dispatch`) appear only after the next dispatch there; before any dispatch that day the
  line says the cap rather than a count. A health check makes no GitHub request by design.
- **`compareAndSet` can still move a row to `dispatching` without the repository cap.** No
  production path does — Approve and retry go through the two claiming methods — but the method
  takes any state, and test fixtures use it to build legacy rows with no approval id. Narrowing its
  `next` type would make the rule structural, at the cost of rewriting those fixtures.

---

## Bring-your-own-credentials (added later, audited, merged)

The feature was rejected by its first audit and reworked. What an independent re-audit confirmed
fixed: one `SecretsPort` (the duplicate incompatible design is gone), GitHub's two different 404s
distinguished, a failed `/credentials set` rolled back, a missing **Environments** permission
degrading to "the operator pays" instead of breaking every build, a real credential-leak scan, and
`retryAfterMs` honoured. Each was verified by reverting it and watching a named test fail — 14
reverts, several pinned in both directions.

These survived, none blocking:

### Open — medium

**A false deletion receipt is possible if the 404 probe's premise is wrong.**
When GitHub answers 404 for an environment, the adapter probes `GET /repos/{o}/{r}/environments`
and reads its **status only** (not the paginated body, which could report false absence). A 200 is
taken to mean "the token can reach this repo's environments", so the 404 was about that one
environment — absence, not a permission problem.

That premise is *reasoned from the routes' shapes, not observed against live GitHub.* If it is ever
wrong, `/credentials clear` answers `Ok(false)` — telling a user "there was nothing there" while
their credential is still stored, and writing `{"existed":false}` to the audit. A "forget me"
request answered with a false confirmation is worse than the cosmetic misreport the same premise
would cause for `status`.

**Fix:** a live probe against a repo with a deliberately under-scoped token. Nothing offline can
settle it.

### Open — low

- **The payer degradation branches on `retryable`, which is broader than its comment claims.**
  It degrades to the operator's environment on `!error.retryable`, and the comment says that means
  "exactly 401/403". `retryable: false` is also set by `validation`, `not-found`, `conflict`,
  `forbidden`, `config`, `internal` and `cancelled`. **Latent only** — both call sites mint names
  through `buildEnvironmentName`, which throws rather than returning an invalid name, so the
  validation arm is unreachable today. Narrowing to
  `error.kind === 'upstream' && (error.status === 401 || error.status === 403)` would make the code
  say what the comment says.
- **The leak scan's window constant is duplicated.** `MEANINGFUL_RUN = 12` and `traces()` are
  defined independently in `credentials/module.test.ts` and `github/secrets.test.ts`. A disclosure
  of 11 characters passes both. 12 is not arbitrary: the module's own correct refusal text quotes
  `sk-ant-api` (10 chars), so anything lower produces false positives on legitimate prose. If a
  third scan appears, move both to `#testing`.
- **The rollback is silently best-effort.** If the post-failure `list` or `deleteEnvironment` fails,
  the user stays stranded with an empty environment and nothing says so. It heals on the next
  `/credentials set`. Deliberate — deleting an environment the bot cannot inspect would be worse.
