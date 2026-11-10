# Setup

Getting from a fresh clone to a bot that turns `/request new` into a pull request.

Budget about 20 minutes. Most of it is clicking around Discord and GitHub; the code needs no build
step and no toolchain beyond Node.

There are exactly **two** steps people get wrong. Both fail in a confusing way, so both are called
out where they occur:

**1. `APPROVAL_HMAC_KEY` must exist twice with the same value** — in `.env` and as a GitHub
**repository** secret (not an environment secret; step 4b explains why). If they differ, or if it is
stored in the wrong place, approvals look fine in Discord and every build is rejected.

**2. Nothing in `.env` pays for a build.** The Anthropic credential is not an operator setting any
more. Every person who wants to use `/request new` — **including you** — runs `/credentials set` in
Discord first, and their own key funds their own builds. There is no owner bypass. A fresh install
where nobody has done that has a working bot that refuses every request, with a message telling the
person exactly what to run. Step 6 is the walkthrough; step 4b is what the old `ai-agent` secret is
still for.

> The bot needs **no privileged intent**. `/request new` is a slash command, and slash commands and
> modal submissions arrive as interactions, so the bot never asks to read your server's messages.
> If you have set up a Discord bot before and are looking for the Message Content toggle: you do
> not need it.

---

## 0. Already done for you

If you are `bool-` working in this repository, these are done — verified against the live repo, not
assumed. Skip them:

- [x] Repo created, private, both workflows registered
- [x] `ai-agent` environment exists
- [x] `APPROVAL_HMAC_KEY` generated, set as a **repository** secret, and written into `.env` with
      the same value — so the byte-identical trap below is already closed
- [x] `.env` scaffolded from `.env.example`
- [x] Database and migrations verified working by a real boot

**What is left is only the five things nobody else can do for you**, because they each require your
credentials or your clicks:

| # | Step | Why only you |
|---|---|---|
| 1 | Discord bot token | shown once, in your Developer Portal |
| 2 | Discord client + owner IDs | from your application and your account |
| 3 | Invite the bot | your server |
| 4 | GitHub fine-grained PAT | your account |
| 5 | Anthropic credential, via `/credentials set` **in Discord** | your key or your subscription, and it is stored against *your* Discord id |

Then fill `.env` and `npm start`.

Note where step 5 happens: **in Discord, after the bot is running** — not in `.env`, and not in a
GitHub environment. That is the one thing about this setup that has changed shape, and step 6
explains why.

---

## 1. Prerequisites

| Need | Check |
|---|---|
| Node.js **24.12+** | `node --version` |
| A Discord account that can create applications | |
| A GitHub repo the bot may file issues in | |
| A Claude Pro/Max subscription **or** an Anthropic API key | either works — you hand it to the bot in step 6, not here |

```bash
git clone git@github.com:bool-/discord-ai-feature-builder.git
cd discord-ai-feature-builder
npm install
npm run check     # typecheck -> lint -> test. Should be green before you configure anything.
```

If `npm run check` is green, the code is fine and everything after this is configuration.

<details>
<summary>What <code>npm install</code> pulls in, and why <code>libsodium-wrappers</code> is on the list</summary>

Five runtime dependencies: `discord.js`, `octokit`, `pino`, `zod`, and **`libsodium-wrappers`**.

The last one is new with `/credentials` (step 6) and is the only one that is not obvious, so:
GitHub requires environment secrets to be encrypted with **`crypto_box_seal`** (X25519 +
XSalsa20-Poly1305) before they are sent. Node's own `node:crypto` cannot do it — measured on
v24.16.0 / OpenSSL 3.5.6, `crypto.getCiphers()` contains no salsa cipher at all, and
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

## 2. Create the Discord application

1. Go to the [Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN`. It is shown once.
3. **No privileged intents needed.** You can leave every toggle under **Privileged Gateway
   Intents** switched off — the bot only uses interactions.

4. **General Information** tab → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
5. Get your own Discord user ID for `DISCORD_OWNER_ID`: enable
   **Settings → Advanced → Developer Mode**, then right-click your name → **Copy User ID**.

### Invite it to your server

Replace `<CLIENT_ID>` and open in a browser:

```
https://discord.com/api/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=274878286912
```

`274878286912` grants exactly: View Channel, Send Messages, Send Messages in Threads, Embed Links,
Read Message History, Attach Files, Use External Emojis, Add Reactions. Nothing else — the bot
never needs to kick, ban, or manage anything, and a bot asking for Administrator should always
make you suspicious.

---

## 3. Create the GitHub token

A **fine-grained** personal access token
([Settings → Developer settings → Fine-grained tokens](https://github.com/settings/tokens?type=beta)),
scoped to the single target repository, with these **Repository permissions**:

| Permission | Access | Why |
|---|---|---|
| Issues | Read and write | file, label, comment on, close **and reopen** requests. Reopen is what `/request retry` uses on a request that expired, so the approver is not asked to fund an issue GitHub still shows as "not planned" |
| Actions | Read and write | dispatch the build workflow, poll the run, and **cancel** it. Cancel is what `/request cancel` uses to stop a run that is still spending the requester's credits — without it the bot can only stop watching |
| **Variables** | **Read** | *optional.* Lets the bot read `AGENT_DAILY_RUN_CAP` once at boot and tell you in `/status` when it and `modules.builder.dailyRunCap` have drifted apart. **Nothing else in the bot uses this**, and without it the check degrades to "the repository cap could not be read" and nothing else changes |
| Pull requests | Read | find the PR the agent opened |
| Contents | Read | not currently called by the bot; harmless, and keeps `gh` working against the repo |
| **Environments** | **Read and write** | check which environment can pay *before* spending Actions minutes, and store each user's own credential for `/credentials` (step 6) |
| **Administration** | **Read and write** | *creating* a user's environment. `PUT /repos/…/environments/{name}` is the first call `/credentials set` makes, and GitHub gates it on Administration — not on Environments |
| Metadata | Read | mandatory for any fine-grained token |

> **"Environments" is not the permission called "Secrets".** This is the most confusing thing on
> this page, so it is worth thirty seconds now rather than an afternoon later.
>
> The permission named **Secrets** covers only *repository-level* Actions secrets —
> `/repos/{owner}/{repo}/actions/secrets/*`. Everything this bot touches is an **environment**
> secret, under `/repos/{owner}/{repo}/environments/{name}/secrets/*`, and those are governed by
> **Environments**. Reading "I am writing a secret", granting `Secrets: write` and trying again
> gets you the identical 403 with nothing anywhere explaining why.
>
> If you have already hit it: the bot's 403 on both the `/credentials` path and the pre-build
> check names **Environments** explicitly. If you are instead reading *"check the token repository
> permissions (contents, issues and actions)"*, that is a different 403 and those three really
> are what to look at.
>
> And there are **two** permissions in play, which is the part that costs an afternoon:
> **Administration** creates an environment; **Environments** writes the secrets inside it.
> `/credentials set` needs both, and it calls the Administration one first — so a token with
> only Environments fails on the very first call while the bot's error still says
> "Environments", which is true but not the whole answer.

**Upgrading an existing install? `Environments` and `Administration` are now REQUIRED, and this
changed.** They used to be optional: without them the bot fell back to the operator's `ai-agent`
environment, logged a warning, and kept building. It no longer does, because
`modules.builder.requireOwnCredentials` now defaults to **true** and falling back *is* the outcome
that switch exists to forbid — "I cannot check whether you can pay" is not "you can pay".

So on a token missing them, every `/request new` is refused with a configuration error naming
**Environments** by name. Two ways out, and the message says both:

- grant the permissions (that is this step), or
- set `MODULES_JSON={"builder":{"requireOwnCredentials":false}}` and fund the server yourself,
  which restores the old behaviour exactly.

That is `GITHUB_TOKEN`. It does **not** need `workflow` scope — the bot never pushes workflow
files, and deliberately cannot.

---

## 4. Configure the repository the AI builds in

This is the repo the agent writes code into. It can be this one (the bot extends itself) or any
other repo you own.

**a. Copy these three files into it** — skip if the target repo *is* this repo:

```
.github/workflows/agent-implement-request.yml
.github/scripts/verify_approval.py
.github/claude/agent-settings.json
```

**b. One secret you must set, and one environment you probably do not need.**

| Secret | Where | Required? |
|---|---|---|
| `APPROVAL_HMAC_KEY` | **repository** secret | **yes, always** — without it every build is rejected |
| `CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_API_KEY` | **environment** `ai-agent` | **only if** you set `requireOwnCredentials: false` — see below |

**Create the environment:** Settings → Environments → New environment, named exactly `ai-agent`.
Create it even if you add no credential to it: the workflow's `environment:` line resolves a name,
and it is where `APPROVAL_HMAC_KEY` used to be put by mistake.

#### What `ai-agent` is still for

It used to be the wallet: any requester with no credential of their own fell back to it, so one
person paid for everyone's ideas. **That fallback is now off by default.**
`modules.builder.requireOwnCredentials` defaults to `true`, and with it on:

- the shared `ai-agent` environment is **unreachable from a user request** — the bot refuses at
  `/request new` and refuses again at dispatch, so a credential cleared in between still cannot reach
  it;
- so putting `ANTHROPIC_API_KEY` there **does nothing**, and you can leave it empty.

Set a credential on `ai-agent` in exactly one case: you run a private server, you want to fund every
build yourself, and you have therefore set

```
MODULES_JSON={"builder":{"requireOwnCredentials":false}}
```

Then `ai-agent` funds anyone who has not run `/credentials set`, exactly as it did before — and note
that "anyone" means anyone who can type `/request new` in any server the bot is in. `/status` tells you
which of the two modes is live without you having to re-read `.env`.

**Add `APPROVAL_HMAC_KEY` as a repository secret:** Settings → Secrets and variables → Actions →
*Repository* secrets. **Not** an environment secret. The approval gate runs inside whichever
environment the build selected, and once anyone brings their own credentials that is
`user-<discord-id>`, not `ai-agent`. A key stored only on `ai-agent` resolves to an empty string in
every one of those runs, and the gate then rejects them all with a key-length error that has
nothing to do with the approval. A repository secret resolves in all of them.

### Choosing between a subscription and an API key

Read this whichever mode you are in — the choice is the same, only *where you put the value*
differs. With `requireOwnCredentials` on (the default) each person hands theirs to the bot with
`/credentials set` (step 6); with it off you put one on the `ai-agent` environment above.

**API key** — `ANTHROPIC_API_KEY`. Create one at
[console.anthropic.com](https://console.anthropic.com) → API Keys. It starts `sk-ant-api…`.
Metered, and separate from your personal usage, which is the right choice once more than one
person can trigger builds.

**Claude Pro/Max subscription** — `CLAUDE_CODE_OAUTH_TOKEN`. There is **no web page** for this and
nothing can generate it for you: it comes from an interactive login against your own subscription,
so you run it yourself, in your own terminal, with the Claude Code CLI installed:

```bash
claude setup-token
```

("Set up a long-lived authentication token (requires Claude subscription)".) It prints a token
starting `sk-ant-oat…`. Paste it into `/credentials set` — or, with the switch off, into the
`ai-agent` environment secret.

The catch is worth knowing before you choose it: build usage comes out of the subscription's
limits, which are **shared with your own interactive Claude Code usage**, so a long build eats into
what you have left that day. And because it needs the CLI plus an interactive login, it is the
harder of the two to set up — if you just want this working, use the API key.

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

**c. Generate the approval key** once:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use that one value in **both** places. If they differ, Discord approvals look like they worked and
every build fails at the gate with *"approval token does not match this issue"*. That is the
symptom to remember.

**d. Put a human between the agent and `main`.** The agent opens PRs directly, so you want a
review gate.

Note that **branch rulesets need GitHub Pro on a private repo** — on a free account
`Settings → Rules` returns 403 and this is simply unavailable. Without it, the protections that
still apply are: the agent has no `workflows` permission so it cannot touch `.github/**`, the
post-hoc path gate fails the run if the diff does, and merging is a manual act you perform. If you
want an enforced gate, either upgrade the account or make the repo public.

---

## 5. Configure the bot

```bash
# NON-DESTRUCTIVE on purpose. If section 0 applies to you, `.env` already exists and already
# holds an APPROVAL_HMAC_KEY matching the GitHub repository secret. Overwriting it with the
# placeholder is the single fastest way to cause the failure this page opens by warning about.
[ -f .env ] || cp .env.example .env
```

Fill in the seven required values:

| | |
|---|---|
| `DISCORD_TOKEN` | step 2 |
| `DISCORD_CLIENT_ID` | step 2 (Application ID) |
| `DISCORD_OWNER_ID` | step 2 (your user ID) |
| `GITHUB_TOKEN` | step 3 |
| `GITHUB_OWNER` | the account owning the target repo — e.g. `bool-` |
| `GITHUB_REPO` | the repo name alone, no owner — e.g. `discord-ai-feature-builder` |
| `APPROVAL_HMAC_KEY` | step 4c — must equal the repository secret |

`.env.example` documents these and the nine optional ones.

```bash
npm start
```

On a good start you will see the modules load and the gateway connect. On a bad one you get a
sentence telling you what is wrong — the bot names **every** missing variable at once rather than
making you fix them one restart at a time:

```
discord-bot cannot start: The bot is misconfigured.
  where: env

  ✖ Invalid input: expected string, received undefined
    → at DISCORD_TOKEN
  ...
  what to do: Set the missing environment variables and restart. See .env.example.
```

---

## 6. Use it

### First: store a credential. This is not optional, and it applies to you.

```
/credentials set
```

A **modal** opens with one field. Paste either credential shape from step 4 and submit. The reply is
ephemeral and names only *which* secret was stored, because the bot cannot read the value back.

**Do this before `/request new`, including for your own account.** With
`modules.builder.requireOwnCredentials` at its default of `true`, `/request new` is refused for anyone
who has stored nothing, and there is deliberately **no owner bypass** — "no free builds" with a
silent exemption for whoever holds the bot token is not the rule it claims to be, and the exemption
would be discovered in a bill.

If you skip it, this is what you get, privately, and nothing is filed:

```
Builds here run on your own Anthropic credentials, and you have not stored any.
Run /credentials set and paste either an Anthropic API key (sk-ant-api...) from
console.anthropic.com, or a Claude Code OAuth token (sk-ant-oat...) from running
`claude setup-token`.
```

That refusal happens at **modal submit**, before any GitHub issue is filed and before any card is
posted — so a refused request leaves nothing behind for anyone to clean up. The cost is that you
find out after typing your request rather than before the dialog opens; `/request new` opens a modal and
Discord forbids doing any work before showing one.

### Then: file a request

In a channel the bot can see:

```
/request
```

A dialog opens asking for a **Title** and **What should it do?** (a full-size text box, up to 4000
characters). Fill it in and submit.

What happens:

1. The bot checks you have a credential stored. **No credential, no issue, no card, no spend** — you
   get the message above and nothing else happens.
2. It validates, redacts anything token-shaped, and rate-limits the submission.
3. It files a GitHub issue, with your text wrapped inside a per-issue nonce fence.
4. It posts an **Approve / Reject** card. Only an approver can press it — and by default **not the
   person who asked**, since asking and approving are separate permissions.
5. **Approve** dispatches the workflow — but not before **re-reading** your credential. That second
   check is not redundant: approval can be minutes or days after the request, and a key you cleared
   or revoked in between would otherwise have become a run somebody else funded. Claude Code then
   implements the issue on `agent/req-<id>` and opens a pull request, billed to **your** environment.
6. The bot polls and posts the outcome back to the channel **as a new message that @-mentions
   you**. Builds take 5–30 minutes; it is a new message rather than an edit of the card because a
   Discord interaction token expires after ~15 minutes — and, just as importantly, because an
   edit notifies nobody. Before the mention existed the honest description of this step was
   "wait twenty minutes, then go back and look".
7. **Reject** closes the issue as `not_planned` and nothing is built or spent.

> **About that mention, because a bot that can ping is a bot worth checking.** It pings exactly
> one user: the requester, from the Discord id the bot persisted on the request row when it was
> filed. The message is sent with `allowed_mentions: { parse: [], users: [<that id>] }` —
> `parse: []` is unchanged, so `@everyone`, `@here` and role pings stay *structurally*
> impossible, not merely discouraged. The id is never read out of anybody's text, so no request
> body can make the bot ping someone else. If you want no ping at all, mute the channel; there is
> no setting, because the whole point of the feature is that the outcome reaches the person who
> is waiting for it.

Two costs, two payers, and it is worth being clear which is which: the **Anthropic tokens** come out
of the requester's credential; the **GitHub Actions minutes** still come out of the repository
owner's allowance. `requireOwnCredentials` moves the first, not the second — which is why the
workflow's daily run cap still matters. See "What it costs to run" below.

### After you have asked: `/request list`, `cancel`, `retry`

`/request new` opens the modal. Three subcommands cover everything that happens afterwards,
and they exist because for a long time nothing did — you filed a request and your only way to find
out anything was to scroll back to the card.

| Command | What it does |
|---|---|
| `/request list` | Your requests in this server, newest first: the state each is in, how long it has been there, and the links (issue, run, pull request) that state has produced. Anyone holding `builder.approve` sees everyone's, because deciding what to approve means seeing what is already queued. |
| `/request cancel` | Withdraws a request of yours that **nobody has approved yet**. The issue is closed `not_planned`, the card is rewritten with its buttons disabled, and the concurrency slot is freed immediately. Nothing had been spent, so nothing is wasted. |
| `/request retry` | Files the same request again after a build **failed**. Same text, new request, new build. |

Three things about these that are worth knowing before you need them:

- **Cancel is for requests, not for running builds.** Once Approve has dispatched, the GitHub
  Actions run is out of the bot's hands — there is no port that stops one — so cancelling a
  request that is already building is refused, and the refusal hands you the run URL so you can
  stop it in GitHub if you really mean to. What you *can* always cancel is the thing that costs
  nothing yet: a request still waiting for an approver. That is also the fast way out of a full
  `maxConcurrentPerGuild`, and it no longer requires finding an approver to press Reject.
- **Retry needs approving again.** It is a fresh request row with a fresh approval, because a
  retry spends money exactly like a first attempt, and a retry that reused the original approval
  would be a way to spend without a second human click. It counts against `maxConcurrentPerGuild`
  and against the daily build cap like anything else.
- **Retry is offered for failures, not for outcomes you dislike.** A request that reached
  `pr_open` or `done` produced a pull request or a documented refusal; the answer to "the PR is
  wrong" is a new `/request new` describing what is wrong, not a re-run of the same prompt hoping for
  a different model.

`/request list` is also the honest answer to "is it stuck?". A request sitting in `running` with
its run link is a build that is still going; one sitting in `awaiting_approval` for a day is
waiting on a human, and `/access list` will tell you which human.

### Seeing what the bot is doing: `/admin jobs` and `/admin audit`

Two things this bot has always recorded and never showed anyone: the durable job queue that
carries every build, and the audit log that records every privileged action. Both existed, were
tested, and had no caller at all. `/admin` is that caller.

| Command | What it shows |
|---|---|
| `/admin jobs` | The job system's own counters — what is queued, what is running, what has dead-lettered and what is scheduled. This is where "the build card never updated" separates into "the job is still running" and "the job died two hours ago". |
| `/admin audit` | The most recent audit rows for this server: who approved, rejected, granted, revoked, stored or cleared what, and when. Guild-scoped, so one server's operators cannot read another's. |

Both are ephemeral and both are gated on `admin.view`, whose fallback is `guild-admin` — so a
server manager can run them out of the box, exactly like `/access`. Run `/access list` if you want
the authoritative answer for your install; it prints every declared key with its default.

Neither command can change anything. They are windows, not levers: the levers are `/access`,
`/request cancel` and the GitHub UI.

### Your first build, if you are testing alone

A solo install needs **two** things that a multi-person one does not, and they are unrelated —
missing either produces a different dead end:

1. **You have run `/credentials set`.** There is no owner bypass, so your own `/request new` is refused
   without it, exactly as anyone else's would be.
2. **You can approve your own request.** Read on.

**Read this before you press Approve.** Asking and approving are separate permissions on purpose —
`builder.approve` has fallback `nobody`, and by default **you cannot approve your own request**. On
a solo install that is a dead end: you file a request, press Approve, and get

```
Ask someone else to approve your own request.
```

Pick one — and the first is now the right answer for almost everybody:

- **Grant somebody the approver permission, from inside Discord:**

  ```
  /access grant permission:builder.approve user:@reviewer
  ```

  No restart, no `.env` edit, no downtime. That person can now approve *and reject* requests in this
  server. This is the intended shape — two people, one asking and one approving — and it is what
  the separation exists to make possible. You can grant a **role** instead, which is usually what
  you want:

  ```
  /access grant permission:builder.approve role:@maintainers
  ```

  `/access` is itself gated on `access.manage`, whose fallback is `guild-admin`, so **any server
  manager can run it out of the box with nothing configured.** That fallback is deliberate: a
  permission-granting command that needed a grant only it could make would deadlock in exactly the
  way `builder.approve` used to.

- **Have a second person file the request.** You are the application owner, so you can approve
  anyone else's. Needs no configuration at all.

- **Or, if you are genuinely alone, allow self-approval.** In `.env`:

  ```
  MODULES_JSON={"builder":{"allowSelfApproval":true}}
  ```

  Restart the bot. Turn it back off once a second approver exists — the separation is what stops
  one person spending the budget unreviewed. Prefer `/access grant` wherever you have anybody at
  all to grant to: it survives restarts, it is audited (an `access.grant` row records who granted
  what to whom), and it does not weaken the review rule for *everyone* in order to unblock one
  person.

  You still run `/credentials set` either way — that one has no config escape hatch short of
  `requireOwnCredentials: false`, which changes who pays rather than who may approve. Keep the
  three decisions separate in your head: `/access grant` is about **who may approve**,
  `allowSelfApproval` is about **whether asking and approving may be the same person**, and
  `requireOwnCredentials` is about **money**.

### The three `/access` commands

Every "you do not have permission" message in this bot ends by naming `/access grant`. This is that
command. It reads and writes the per-guild allow-list that every permission check consults.

| Command | What it does |
|---|---|
| `/access list` | Every permission key any installed module declares, who is explicitly granted it here, and what happens when nobody is. This is the answer to "who can approve builds in this server?" |
| `/access grant` | Gives a key to **one** user or **one** role. The `permission` option autocompletes from the live registry. |
| `/access revoke` | Takes it back. Says "nothing to revoke" — distinctly from "revoked" — when the grant was not there. |

All three are ephemeral and guild-only, and all three are gated on `access.manage` (fallback
`guild-admin`).

Three things worth knowing:

- **The key must be one a module really declared.** `/access grant permission:ghost.do-anything` is
  refused, not stored. A typo that sat in the table looking granted while gating nothing is how
  somebody "fixes" access and never learns they did not. Revoke validates the key for the same
  reason: a silent "nothing to revoke" for a mistyped key is indistinguishable from a revoke that
  worked.
- **Read the `default` column on `/access list`.** A key whose default is `nobody` and whose
  "granted to" column is `-` works for **no one** — not even a server manager, not even you. That is
  the state `builder.approve` ships in, deliberately, because it spends money.
- **Grants are per server.** They are rows in `core_access` keyed by guild, so granting in one
  server does nothing in another. Nothing here is global except the single `DISCORD_OWNER_ID`
  bypass.

### Requests expire after 48 hours

An **unapproved** request does not sit in the queue forever. An hourly sweep moves any request still
`awaiting_approval` after `approvalTtlMs` (default **48 hours**) to `expired`: it closes the GitHub
issue as `not_planned` and rewrites the Discord card to say nobody approved it, with the
Approve/Reject buttons disabled so the card visibly resolves. Nothing is built and nothing is spent.

**Why this matters more than it sounds.** `maxConcurrentPerGuild` (default **2**) counts requests
that are *waiting for an approver* as well as builds that are actually running. Without expiry, two
requests that nobody ever clicked would take `/request new` away from that server permanently — the bot
answering "Too many builds are already in flight here" about builds that did not exist. The TTL is
what makes that a timeout instead of a leak.

If you hit the cap, the refusal now tells you which situation you are in. If the requests are merely
waiting, it says so and points at approval rather than at waiting:

> 2 requests are still waiting for an approver here, and nothing is actually building. Ask an
> approver to approve or reject them — an unapproved request only clears itself after 48 hours.

That is your cue to run `/access grant builder.approve @someone`, or to reject the stale ones.

To change the window:

```
MODULES_JSON={"builder":{"approvalTtlMs":86400000}}
```

Shortening it below a working day is usually a mistake — an approver is a human in another timezone,
and expiring a legitimate request before anyone has seen it is its own failure.

### The three `/credentials` commands

The bill follows the person who asked. Every requester funds their own build; nobody subsidises
anybody by default.

| Command | What it does |
|---|---|
| `/credentials set` | Opens a **modal** and stores your own Anthropic API key or Claude Code OAuth token. **Required before `/request new` works.** Run it again to replace what is there. |
| `/credentials status` | Names which of your credentials are stored. Never shows a value — nothing can. |
| `/credentials clear` | Removes them. **This takes `/request new` away from you** until you set one again, and a request already approved but not yet started will fail too. The reply says so. |

Every reply is ephemeral: which credential you pay with is nobody else's business.

> **The `/credentials` module cannot see the builder's setting.** Modules never import each other
> here, so its wording leads with the default (`requireOwnCredentials: true`) and mentions the
> operator-funded case second. If you turned the switch off, read "your builds will be refused" as
> "your builds will fall back to `ai-agent`". `/status` is the authority on which mode is live.

**The bot stores neither credential.** It is sealed to GitHub's public key in memory and written
straight into a per-user GitHub environment named `user-<your discord id>`, which is *write-only*
— there is no REST endpoint that returns a stored secret, so there is nothing in the bot's
database to leak, back up by accident, or hand to whoever gets a shell on the box next. The bot
cannot read your key back either, which is why `/credentials status` reports names only.

It is a **modal**, not a command option, and that is the point: a modal submission arrives as an
interaction, so the value never enters a channel, never appears in anybody's scrollback, and is
not sitting in Discord's copy of the channel. `/credentials set token:sk-ant-…` would fail every
one of those.

Two things worth knowing before you run it:

- **Which credential.** `sk-ant-api…` (from console.anthropic.com) is metered and separate from
  your personal usage. `sk-ant-oat…` (from `claude setup-token`) draws on your Claude Pro/Max
  subscription — the **same allowance as your own interactive Claude Code usage**, so a long build
  eats into what you have left that day. Anything else, including an Admin API key, is refused.
- **This needs the `Environments` and `Administration` permissions** on `GITHUB_TOKEN` (step 3).
  Without them, storing fails with a message saying exactly that — and, because the bot then cannot
  read anyone's environment either, `/request new` is refused for everyone with a configuration error
  rather than silently billing the operator. That is deliberate; step 3 has the two ways out.

---

## Troubleshooting

**The bot now refuses to start on a bad GitHub configuration — and says which variable.**
Boot makes three GitHub reads before it reports ready: the repository, the workflow file, and the
ref every dispatch is sent against. This is new, and it is a deliberate behaviour change. Previously
the bot validated Discord, started clean, and made **no GitHub call at all** — so an expired token,
a renamed workflow or a deleted branch first surfaced when somebody pressed Approve, after which the
card said "building…" and then, six hours later, that it timed out, about a build that never
started. One expired token could eat a day of that.

What is **fatal** (the process exits 1, naming the variable to edit):

| Answer | Meaning |
|---|---|
| `401` on any of the three | `GITHUB_TOKEN` is expired, revoked or malformed. Nothing works without it. |
| `404` on the repository | `GITHUB_OWNER`/`GITHUB_REPO` is wrong, **or** the token was never granted access to that repo. On a private repository GitHub returns 404 rather than 403, so this is usually a token-scope problem, not a missing repository. |
| `404` on the workflow file | `GITHUB_WORKFLOW_FILE` names a file that is not on the default branch — or the token lacks the **Actions** permission, which the build poller needs on every build anyway. |

What is only a **warning** (the bot starts):

- **`404` on the ref.** This one is deliberately not fatal. Resolving a ref needs the **Contents**
  permission, and nothing else in this bot needs it — a dispatch needs Actions write. So a token
  that has been dispatching builds happily for months can 404 here, and refusing to start on that
  would take down a working bot to report a guess. The warning names both possible causes.
- **`403`, `429`, `5xx`, or GitHub being unreachable.** None of these is evidence that a value in
  your environment is wrong; GitHub has outages. Refusing to boot on them would mean somebody else's
  incident takes `/help` and `/tags` down with it — and a bot in a restart loop hammers an API that
  is already rate-limiting it.
- **The workflow is disabled**, or **Issues are switched off** on the repository. Both are fixable
  on the repository's own settings pages without restarting the bot, which is exactly the line
  between a warning and a fatal here: *fatal means "edit a value and restart".*
- **`GITHUB_TOKEN` expires within 14 days.** Fine-grained tokens advertise their expiry in a
  response header; the bot passes it on so you find out before every build starts failing with a
  401 that looks like GitHub being down.

Warnings are printed to stderr **and** to the structured log, because one buried in JSON is one
nobody reads at 3am.

**`/request new` does not appear in the command list.**
Commands were deployed globally and can take up to an hour to propagate. Set `DISCORD_DEV_GUILD_ID`
to your server's id for instant, guild-scoped registration while you are setting up. Also confirm
the bot was invited with the `applications.commands` scope — the invite URL above includes it.

**Every build fails at "Verify the Discord approval".**
`APPROVAL_HMAC_KEY` differs between `.env` and the **repository** secret, or it was stored as an
*environment* secret instead. Both must hold the same value, byte for byte, and the GitHub copy must
be a repository secret — see step 4b for why an environment secret breaks every per-user build.

**"resource not accessible by integration" / unexpected 404 on a private repo.**
The fine-grained token is missing a permission from step 3, or was not granted access to that
specific repository. A 404 on a private repo usually means "no permission", not "does not exist".

**`/request new` says "Builds here run on your own Anthropic credentials, and you have not stored any."**
Working as designed, and the message is the instruction: run `/credentials set` first. This applies
to the operator too — there is no owner bypass. If you would rather fund the server yourself, set
`MODULES_JSON={"builder":{"requireOwnCredentials":false}}` and put a credential on the `ai-agent`
environment (step 4b).

**`/request new` says too many builds are already in flight, but nothing is building.**
Read the message again — it distinguishes the two cases. If it says *"N requests are still waiting
for an approver here, and nothing is actually building"*, the slots are held by requests nobody has
clicked, not by builds. `maxConcurrentPerGuild` (default 2) counts both.

Fix it in the order that actually works:

1. `/access list` — check whether anybody at all holds `builder.approve`. On a fresh install
   nobody does, because its default is `nobody`.
2. `/access grant permission:builder.approve role:@maintainers` — create an approver.
3. That person clicks **Reject** on the stale cards, which frees the slots immediately.

If you do nothing, the hourly sweep expires them after `approvalTtlMs` (default 48h) and the slots
free themselves. Before that sweep existed this state was permanent, which is why the message now
names the deadline instead of just telling you to wait.

**`/request new` says "Your build credentials are no longer stored on GitHub."**
Different message, different cause: your environment exists but is empty. Either you ran
`/credentials clear`, or the secret was deleted by hand, or a rotation removed it. `/credentials set`
again. The bot distinguishes this from "never stored anything" on purpose, because the second one is
a surprise and the first one is not.

**`/credentials` says the token is missing the "Environments" permission.**
It is, and it is not the permission called "Secrets" — see the callout in step 3. Grant
**Environments: Read and write** *and* **Administration: Read and write**.
**This now stops builds rather than degrading**, which changed with `requireOwnCredentials`: the bot
cannot read any environment, so it cannot show that anyone is funding their own build, and
"I cannot check" is not "the operator pays". `/request new` is refused with a config error naming the
permission and offering `requireOwnCredentials=false` as the alternative.

**A user set their own credential and the build still billed the operator.**
Only possible with `requireOwnCredentials: false`. Check the bot's log for
`cannot read environment credentials`: that line means `GITHUB_TOKEN` cannot read environments at
all, so with the switch off the bot skipped the check and let the shared environment pay rather than
failing every build in the server. Grant **Environments**. With the switch on (the default) this
cannot happen — the run is refused instead.

**Everyone's `/request new` started being refused after an upgrade.**
`Environments`/`Administration` were optional before and are required now. See step 3.

**The workflow never starts.**
Confirm `GITHUB_WORKFLOW_FILE` matches the filename in the target repo (default
`agent-implement-request.yml`) and that the workflow exists on the branch named by `GITHUB_REF`.

**The build succeeded but no link arrived.**
Check the run's "Reject forbidden path changes" step — if the agent touched `.github/**`, `.env`,
`.npmrc` or `.ssh/`, the run fails deliberately and the PR is marked do-not-merge.

**Approve says the daily build cap has been reached.**
Working as designed, and it now says so *before* spending anything. Four builds a day is the
default because that is roughly what a private repo's free Actions allowance affords — see
"What it costs to run". Wait for the reset (midnight UTC), raise both numbers together
(`AGENT_DAILY_RUN_CAP` **and** `modules.builder.dailyRunCap`), or make the target repo public,
where Actions minutes are unlimited and the cap becomes a pure abuse control. The requests you
did not build are still there: `/request list` shows them, and they expire on the usual 48-hour
sweep if nobody gets to them.

**Nobody was pinged when the build finished.**
The outcome message mentions the requester by their stored Discord id. It will not notify them if
they have left the server, if they have the channel muted, or if they have blocked mentions from
the bot — Discord's own delivery rules apply and the bot has no way to see the difference. The
message itself is still posted to the channel either way, and `/request list` always shows the
outcome. If a mention renders as a raw `<@123…>` rather than a name, the user is no longer a
member of that guild.

**`/request cancel` refuses to cancel a build that is running.**
Deliberate: the bot dispatches GitHub Actions runs and has no port that stops one, so a "cancel"
that only stopped the bot from watching would be a lie — the run would keep spending. The refusal
gives you the run URL; cancel it there if you mean it. Anything still `awaiting_approval` cancels
instantly, which is the case that actually holds a concurrency slot.

**A module is broken and the bot will not behave.**
`MODULES_DISABLE=thatmodule` skips it *before* import, so it works even for a module that throws
on load. The rest of the bot keeps running.

**Two bots, one database.**
Don't. SQLite is opened with WAL and a busy timeout, but two instances will fight over job leases.
One process per database file.

---

## Running it long-term

Docker (recommended): the repo ships a `Dockerfile`, a `.dockerignore` and a `compose.yaml`.

```bash
docker compose up -d --build     # start, or rebuild after pulling
docker compose logs -f bot       # follow the logs
docker compose down              # stop; in-flight jobs finish or checkpoint first
```

- **Secrets stay out of the image.** `.env` is read by compose at run time (`env_file`), and
  `.dockerignore` keeps `.env`, `data/` and `.git` out of the build context, so no image layer
  ever holds your tokens or your database. Never replace this with `COPY . .` and no
  `.dockerignore`: that bakes `.env` into the image.
- **The database is `./data`, bind-mounted** at `/app/data`. Same file as a non-Docker run, so
  switching between the two needs no migration. Back it up exactly as described below.
- **One container per database.** Do not scale the service past 1.
- **The process runs as the unprivileged `node` user**, not root. Modules merged by the builder
  run inside this process, and the container keeps them away from the rest of the host: they
  see `/app`, `./data` and the network, not your home directory.
- **`/status` shows the commit only if you pass it in**, because the image has no `.git`:
  `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build`.
- **Rolling back:** `docker compose down`, check out the previous commit, and
  `docker compose up -d --build`. Restore the database backup too if the newer build ran a
  migration.

systemd:

```ini
[Service]
WorkingDirectory=/opt/discord-bot
ExecStart=/usr/bin/node --conditions=source src/main.ts
EnvironmentFile=/opt/discord-bot/.env
Restart=always
RestartSec=5
```

### Backing it up — do not use `cp`

The database (`DATABASE_PATH`, default `./data/bot.sqlite`) holds approval state, the job queue,
the per-guild permission grants and the audit log. Back it up with SQLite's own backup command,
against the **running** bot:

```bash
sqlite3 data/bot.sqlite ".backup '/backups/bot-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
```

**Why not `cp`, and this page used to say `cp`.** The bot opens the database in **WAL** mode, so
at any instant the committed state is split across three files: `bot.sqlite`, `bot.sqlite-wal`
(transactions not yet checkpointed back into the main file) and `bot.sqlite-shm` (the shared
index into that WAL). Copying `bot.sqlite` alone from a live bot silently drops everything still
in the WAL, and copying all three one at a time captures them at three different instants — a
torn snapshot that may open cleanly, may be corrupt, and does not tell you which until the day
you restore it. `.backup` takes a read lock, folds the WAL in, and writes **one** consistent file.

`VACUUM INTO` does the same job and additionally rewrites the copy compactly, if you prefer:

```bash
sqlite3 data/bot.sqlite "VACUUM INTO '/backups/bot-$(date -u +%Y%m%dT%H%M%SZ).sqlite'"
```

**What to do about the `-wal` and `-shm` files: nothing.** Do not copy them and do not restore
them. Both commands above produce a single self-contained database with the WAL already applied,
which is the entire reason to use them. Restoring is:

1. stop the bot;
2. delete any `bot.sqlite-wal` and `bot.sqlite-shm` sitting next to the destination;
3. put the backup in place as `bot.sqlite`;
4. start the bot.

Step 2 is the one people skip. A stale `-wal` left beside a restored file is how a good backup
becomes an unrestorable one — SQLite will try to replay a journal belonging to a different
database.

**No `sqlite3` binary?** It is a separate install (`apt install sqlite3`, `brew install sqlite`,
or the precompiled tools from sqlite.org) and it is worth having. If you would rather not, the
safe file-copy route is: **stop the bot first**, then copy. A clean shutdown checkpoints and
removes the WAL, after which `bot.sqlite` on its own *is* the whole database. That is the only
condition under which copying the file is correct.

Do not put the database on a network share — SQLite locking over SMB/NFS is not reliable.

## Adding features yourself

```bash
npm run scaffold -- my-module --summary "One line about it." --db
npm run check
```

**Start here rather than copying a folder.** The generated module compiles, lints and passes its
own test immediately, with every mandatory field written out (`PUBLIC`, `NO_LIMIT`, `needs: []`)
instead of omitted — so your first `npm run check` measures your change and not your boilerplate,
and the decisions a copy tends to inherit silently are visible instead. Nothing else needs
editing: the loader finds the folder on the next boot. Drop `--db` if the module stores nothing;
keep it if it does, because it also writes the `migrations/` folder that `migrations: true`
requires. Read [`AGENTS.md`](../AGENTS.md) first; it documents the rules that are not inferable
from the code, and `template/src/modules/tags/` (in a module repository built from the template,
`src/modules/tags/`) is the worked example of a finished module.

### Where a future change will tell you it needs you

Every pull request into this repo — yours, or one the bot's own agent opens — carries a section
headed **`## Operator action required`**. That is where anything on *this page* that a change makes
newly necessary gets announced: a privileged gateway intent to tick in the Developer Portal, a new
permissions integer meaning you must re-invite the bot (step 2), a new required variable in `.env`
(step 5), a new GitHub token permission or secret (steps 3 and 4b), or a change to who pays for a
build (step 6).

It says `None.` when nothing is needed, and it is never absent: the `require-operator-disclosure`
job in `.github/workflows/ci.yml` fails a pull request whose body omits it or leaves it empty. So
when a merged change stops the bot booting, the reason was on the pull request — read that section
before you merge, not after.

A sibling job, `require-test-change`, fails a pull request that changes a `.ts` file under `src/`
while no `*.test.ts` file in the diff changed. It proves a test file was **touched** — not that it
is a good test — and a body line reading `NO-TEST-NEEDED: <reason>` passes it deliberately, so the
reason ends up somewhere a reviewer reads. Both jobs re-run when a description is edited, so
neither needs an empty commit to turn green.

---

## What it costs to run

Two separate bills. They are billed to different places and confusing them is easy.

### GitHub Actions minutes — billed to whoever owns the target repo

| | |
|---|---|
| **Public repo** | **unlimited, free** |
| Private repo, Free account | 2,000 min/month, then **$0.006/min** (Linux) |

Each build is capped at `timeout-minutes: 30`, though a typical small feature finishes well
inside that. Against 2,000 minutes/month that works out to roughly:

- **~2 builds/day** if every build ran the full 30 minutes
- **~4 builds/day** at a more typical 15 minutes
- **~8 builds/day** at 8 minutes

The daily cap therefore defaults to **4**, and it is now enforced in **two** places.

**In the workflow**, as it always was: the run starts, counts today's runs of
`agent-implement-request.yml`, and exits 1 when there have already been too many. Set that one
with the `AGENT_DAILY_RUN_CAP` repository variable (Settings → Secrets and variables → Actions →
Variables).

**In the bot**, before it dispatches anything: `modules.builder.dailyRunCap` (also 4). Approve
asks GitHub how many runs there have been since midnight UTC, and if the cap is already reached it
refuses in Discord — naming the number and when it resets — and dispatches nothing.

Both stay, and they are not redundant, which is the whole reason to have two:

- the **bot's** check is the one a *human reads*. It costs no Actions minutes when it fires, and
  it replaces the old experience: a card that said "Building…", then a run that failed, with the
  only explanation buried in an Actions log the requester probably cannot open.
- the **workflow's** check is the one that does not trust the bot. It still applies to a
  hand-triggered `workflow_dispatch`, to a replayed dispatch, and to a bot that has been
  compromised or bypassed. Removing it because the bot now checks too would be exactly backwards.

**Keep the two numbers equal — and the bot now checks that you have.** They are still separate
settings in separate systems, but they are no longer unreconciled:

| | Effect | What the bot does about it |
|---|---|---|
| bot lower than workflow | the bot refuses first, politely, in Discord. Harmless — and if you want a *softer* limit than the hard backstop, this is how. | reported in `/status`, logged at info. Deliberately **not** a warning: crying wolf on the harmless direction is how an operator learns to ignore the one that matters |
| bot higher than workflow | the bot dispatches, the workflow refuses, and you are back to the old confusing failure. Avoid. | `/status` shows a **WARNING** naming both numbers and both levers, a warning is logged, and a `builder.daily_cap_drift` row is written so `/admin audit` can diagnose a mystery failure in five seconds |
| `AGENT_DAILY_RUN_CAP` set to something that is not a whole number | **every build fails seconds after it starts.** The workflow guards with `case "$DAILY_CAP" in ''\|*[!0-9]*) … exit 1`, so ` 4 `, `4.0`, `+4`, `-1` and `four` are all fatal — and the only explanation is in an Actions log | the loudest arm: `/status` says so explicitly, and it is audited like the bad direction |
| `AGENT_DAILY_RUN_CAP` not set at all | the workflow's own literal default of **4** applies. This is the ordinary install, not an error | compared against 4 rather than skipped — which is the drift likeliest on a fresh install, where nobody has set the variable and somebody has raised the bot's number |

```
MODULES_JSON={"builder":{"dailyRunCap":8}}     # and set AGENT_DAILY_RUN_CAP=8 to match
```

The check runs **once, at boot**, and its answer is cached for `/status` — reading it on every
`/status` would add a GitHub round trip to a diagnostic command, and this is configuration rather
than a per-call fact. It needs the optional **Variables: read** permission from step 3; without
it `/status` says "the repository cap could not be read" and nothing else changes, because the
workflow's cap is the authority and a bot stopped by an optional permission would be worse than a
bot that cannot check.

> **The lever that makes this a non-issue:** the repo the agent builds *into* does not have to be
> private. On a public repo, GitHub-hosted Actions minutes are unlimited and free, and the cap
> becomes purely an abuse control. The bot's own repo can stay private either way.

### Anthropic tokens — billed to the person who asked

`claude-sonnet-5-5` at ~$2/$10 per million tokens in/out. A small feature is usually well under a
dollar; a large one with a lot of exploration can be a few. Bounded by `--max-turns 150` and the
30-minute job timeout.

**Who pays is decided by `modules.builder.requireOwnCredentials`, which defaults to `true`:** the
run uses the requester's own `user-<discord-id>` environment, and nobody who has not run
`/credentials set` can start a build at all. Set it to `false` and you are back to one wallet for
everyone — see step 4b before you do.

Use `CLAUDE_CODE_OAUTH_TOKEN` instead and it comes out of a Claude subscription — but that
capacity is **shared with your own interactive Claude Code usage**, so a long build eats into what
you have left that day.

> **The Actions minutes above do *not* follow the credential.** They are billed to whoever owns the
> target repository, whichever mode you are in. So "every requester pays for their own build" is
> true of the Anthropic half only, and the daily run cap remains the operator's spend control.

### Is 30 minutes enough?

GitHub's own limit is **6 hours per job**, so the 30-minute timeout is ours, not theirs, and there
is a lot of headroom if you want more. The reason not to raise it casually is the failure mode: a
build cut off mid-work has pushed a branch and not opened a PR. The workflow already tells the
agent to open a **draft PR** describing what remains rather than stopping silently.
