# AGENTS.md - Guildwright

Rules that are **not** inferable from reading the code. Everything else: read
`node_modules/guildwright/src/core/module.ts`, run `npm run scaffold`, and read `src/modules/tags/` as the
worked example.

This repo is extended by AI agents on purpose — that is what the `builder` module does. So the
contracts are built to make a wrong contribution *fail to compile* rather than fail in production.
If you are fighting the types, you are almost always doing something the design forbids on purpose.

None of that is a sandbox. A module runs inside the bot's process, so merging a module grants it
the bot's full authority: its Discord token, its GitHub credentials and its database. The
contracts make a mistake loud; only a reviewer who reads the pull request stops a hostile one.

## Start here

This repository holds modules only. The engine is the `guildwright` package in
`node_modules`; `#core/*` resolves into it. Do not edit `node_modules`, and do not add
`#adapters/*` to the imports map.

1. Read exactly two things: `node_modules/guildwright/src/core/module.ts` and `src/modules/tags/`. That is enough
   to write a module. You do **not** need to read `src/adapters/**` — ever.
2. **Generate a new module; never hand-create the folder.**

   ```bash
   npm run scaffold -- <your-id> --summary "One line about it." [--db]
   ```

   What it writes already compiles, already lints and already passes its own test, with every
   mandatory field written out rather than defaulted — so your first `npm run check` measures
   *your* change instead of your boilerplate. Then edit it, reading `src/modules/tags/`
   as the worked example of a finished one. The folder name **is** the module id, the SQL table
   prefix, and half of every `custom_id`. Pass `--db` when the module stores anything: it also
   writes the `migrations/` folder, without which `migrations: true` quarantines the module at
   boot.
3. Definition of done: `npm run check` passes (typecheck → lint → test), you added a test that
   fails without your change — the `require-test-change` job fails a pull request that touches a
   `.ts` file under `src/` while no `*.test.ts` file in the diff changed, so this one is checked
   rather than trusted — **and your pull request body carries an
   `## Operator action required` section** — see below. It says `None.` when nothing is needed,
   and it is never absent.

## The six hard rules

1. **A module imports `#core/**`, its own folder, and `zod`. Nothing else.**
   Never another module. Never `#adapters/**`. Never `discord.js`. Never `octokit`. Never
   `node:sqlite`, `node:fs`, or `node:child_process`. If no port fits your need, that is a
   core change — see "If you are blocked".

2. **Every `CommandSpec` / `ActionSpec` field is required. There are no defaults.**
   When you mean "anyone may run this", write `permission: PUBLIC`. When you mean "no rate limit",
   write `limit: NO_LIMIT`. When you need no Discord permissions, write `needs: []`. These sentinels
   exist so the decision is visible in review instead of being an omission nobody notices.

3. **Human text is `UserText`, which is an OBJECT — not a string.**
   Convert it with a named function from `#core/text`: `toMarkdown`, `toPlainName`, `toSlug`,
   `toInteger`, `toEnum`, `toHttpsUrl`, `toSnowflake`, `toHexColor`, `toIsoDate`, `truncate`,
   `redactUserSecrets`. Never put it in a template literal — `${userText}` renders
   `[object Object]`, which is a loud bug, not a silent leak, but it is still a bug.

4. **Ports and services return `Result<T, AppError>`; only genuinely exceptional things throw.**
   Handle the `Err` branch. Every `AppError` carries a next-step imperative because the user needs
   to know what to do, not what broke.

5. **`ctx.ports.db` is SYNCHRONOUS. Do not `await` it.**
   `node:sqlite` is synchronous by design. `await db.query(...)` typechecks (awaiting a non-promise
   is legal) and then silently costs you a microtask for nothing.

6. **`capabilities` is your blast radius, and it is enforced by the compiler.**
   Declaring `capabilities: ['db','audit']` means `ctx.ports` is *exactly* `{db, audit}`.
   `ctx.ports.github` is then `TS2339`. Do not widen the tuple to make an error go away — widen it
   only because your module genuinely needs that port, and expect that line to be reviewed.

## Things that will bite you

- **Node runs `.ts` directly in strip-only mode.** No `enum`, no `namespace`, no
  `constructor(private x: T)` parameter properties, no decorators. `npm run typecheck` catches all
  of them, but the error is easier to read if you know why.
- **This repo runs its own `.ts` directly and the engine as compiled JavaScript.** `#core/*`
  resolves through `imports` in `package.json` to `node_modules/guildwright/dist/core/*.js`
  (and its `.d.ts` for types). There is no build step and no `--conditions=source` here: that
  flag would point the installed engine at its shipped `.ts`, which Node refuses to run from
  `node_modules`. Run tests with `npm test`, or a single file with
  `node --test --experimental-test-module-mocks src/x.test.ts`.
- **Subpath imports carry no extension**: `import { Ok } from '#core/result';`
  **Relative imports do**: `import { helper } from './helper.ts';`
  Getting this backwards is the single most common mistake — both forms are wrong in the other
  position, and both fail loudly.
- **`ack: 'form'` handlers must not `await` before returning.** Discord forbids
  defer-then-show-modal, so a single `await` before `showModal` turns into a 100% reproducible
  production failure that no unit test sees.
- **Never use `createMessageComponentCollector` or `awaitMessageComponent`.** Button handlers are
  routed statelessly by decoding `custom_id`, which is exactly why a card still works after the bot
  restarts. A collector lives in memory and dies with the process.
- **Never call `Date.now()`, `new Date()`, `setTimeout` or `setInterval` in a module.** Use
  `ctx.ports.clock`. Otherwise your module is untestable without real time passing.
- **Long work is a durable job, never an in-memory timer or a dangling promise.** A Discord
  interaction token expires in about 15 minutes; a build can take 30. Anything that might outlive
  the interaction must go through `ctx.ports.jobs` and deliver its result to the *channel*, using
  the persisted `channelId`/`messageId` — not to the interaction.
- **SQL is the `sql` tagged template only.** A plain string does not typecheck. Your tables are
  named through `db.table('name')`, which yields `m_<yourid>_name`; you cannot name another
  module's table because the port will not mint the identifier.

## Publishing an event

Modules never import each other. To let others react to something, declare it in
`src/modules/<id>/events.d.ts`:

```ts
export {};
declare module '#core/events' {
  interface AppEvents {
    'yourmodule.thing_happened': { readonly id: string };
  }
}
```

Then add a matching zod schema under `publishes` in your manifest — declaring the event and
forgetting the schema is a missing property (`TS2741`), not an unvalidated payload in production.

Two different objects, and the split is deliberate:

- **`ctx.emit(name, payload)`** publishes. It is narrowed to `keyof publishes`, so you can emit
  *only* the events you declared. Emitting another module's event does not compile.
- **`ctx.bus.on(name, handler)`** subscribes, to anyone's events, with full payload inference and
  no import of the publishing module. `ctx.bus` has no `emit` at all.

Keep the unsubscribe returned by `ctx.bus.on` in `handle.subscriptions` so it is unwound if your
module is quarantined.

Events are **past-tense facts with 0..N subscribers**. A subscriber cannot report failure back, and
ordering is not guaranteed. If you need a return value, an ordering guarantee, or to know about
failure, call a port instead — an event is the wrong tool.

## Operator action required

**Every pull request body carries a section with exactly this heading.** Yours, and the agent's.

It is the one part of a PR addressed not to the reviewer but to the person who *runs* this bot,
and it lists what only they can do: tick something in the Discord Developer Portal, re-invite the
bot, set a variable, approve a dependency. None of that is in the diff, so none of it gets noticed
by reading the diff.

When your change needs none of it, the whole section is:

```
## Operator action required

None.
```

Write it anyway. A missing section is indistinguishable from nobody having checked, and the
difference between those two is paid in production, by an operator whose merged bot will not boot.

Give an entry for each of these your change introduces:

1. **A privileged gateway intent** — `MESSAGE_CONTENT`, `GUILD_MEMBERS` or `GUILD_PRESENCES`.
   This bot deliberately requests **none** of the three (`BASE_INTENTS = [Guilds]` in
   `src/adapters/discord/client.ts`), so needing one enlarges what the operator agreed to when
   they installed it. Name the intent and give the path:
   *your application → Bot → Privileged Gateway Intents*, in the Discord Developer Portal.
   For `MESSAGE_CONTENT`, also say that `DISCORD_MESSAGE_CONTENT=true` must be set **and that
   without it the bot refuses to start** — `src/main.ts` exits 1 when a module declares a message
   hook while that flag is off. That refusal is deliberate: disclose it, never weaken it.

2. **A new Discord bot permission** — a name added to a `needs: [...]` array. It changes the
   permissions integer in the invite URL, so the operator has to **re-invite** the bot. Give the
   new integer: `npx guildwright invite-url` prints it - `permissionInteger()` over the
   union of every `needs:` the installed modules declare.

3. **A new required environment variable** in `EnvSchema` (`src/core/config.ts`), or a new GitHub
   token permission, repository secret or environment secret. Name it, say what it is for, and say
   where the operator gets the value. A required variable with no default stops the bot at config
   parse, before a single command registers.

4. **A new dependency.** The dependency list is behind human approval, so the body must *also*
   carry `CORE-CHANGE-NEEDED: new dependency <name> - <why>` — see "If you are blocked" below.

5. **A change to who pays for a build** — anything touching
   `modules.builder.requireOwnCredentials` or `resolveBuildPayer`. That switch defaults to
   `true`: every requester funds their own build from credentials they stored with
   `/credentials set`, and the operator is a requester like anyone else. Say plainly whether your
   change moves a cost onto the operator, because a bill is the worst possible place to discover
   it.

`src/conventions.test.ts` (two lines that run the installed engine's convention suite)
asserts that this section is still documented here and still demanded by
the agent prompt in `.github/workflows/agent-implement-request.yml`, so deleting either is a red
test. It cannot check what you actually wrote in a PR body — that is enforced by the
`require-operator-disclosure` job in `.github/workflows/ci.yml`, which fails a pull request whose
body has no such section, or an empty one. Neither can tell whether what you wrote is *true*; that
is the reviewer's job, and giving the reviewer something to judge is the entire point.

## The two CI jobs that read your pull request, not your code

`npm run check` runs offline and cannot see a pull request. Two jobs in
`.github/workflows/ci.yml` can, and they are where the two rules above are actually enforced:

| Job | Fails when |
|---|---|
| `require-operator-disclosure` | the body has no `## Operator action required` section, or the section is empty |
| `require-test-change` | the diff changes a `.ts` file under `src/` and no `*.test.ts` file in the diff changed |

**Be clear about what the second one proves: that a test file was *touched*.** Not that it
exercises your change, not that it fails without your change, not that it asserts anything at all
— `test('works', () => {})` passes it, and so does deleting a test. It is a floor, and it is
described that way on purpose: a cheap check stated accurately is worth more than an expensive one
stated vaguely, and a check believed to prove more than it does is how a repo stops reading its
own tests. Judging the test is the reviewer's job, exactly as with the disclosure section.

The floor still earns its place, because the failure it catches is the common one — not a weak
test, but **no test**, in a pull request that otherwise looks finished.

When a `src/` change genuinely has nothing to test — a comment, a rename, a reworded string — put
a line in the pull request body:

```
NO-TEST-NEEDED: renamed an internal helper; no behaviour changed.
```

That passes the job and puts the reason where the reviewer reads it. Same shape as
`CORE-CHANGE-NEEDED` below: the rule is routable around, never routable around quietly. Both jobs
also re-run when you edit the description, so adding either line turns the check green without an
empty commit.

## If you are blocked

If you need a new port, a new capability, a new core event, or any change to the engine (anything
under `node_modules/guildwright/`), `.github/`, or the dependency list:

**Do not work around it.** Do not weaken a type, delete an assertion, loosen a lint rule, or add a
cast to make the compiler stop complaining. Those guards are the product.

Instead: implement whatever part is possible without the change, and write
`CORE-CHANGE-NEEDED: <what and why>` in your PR description, under the
`## Operator action required` heading above — that section is what a human reads to decide.

A core change is a pull request to the engine repository, https://github.com/bool-/guildwright, not to this one.
`CORE-CHANGE-NEEDED:` in this repository's PR body is how the reviewer learns to file it there.

Especially: you cannot edit `.github/**`. The token running you has no `workflows` permission, so
attempting it will fail — and a post-hoc CI gate fails the run if the diff touches it anyway.

## Commands

```
npm run check       typecheck -> lint -> test    (this is the gate)
npm run typecheck   tsc --noEmit
npm run lint        oxlint
npm test            node --test
npm run dev         watch mode
npm run scaffold -- <id> [--summary "..."] [--db] [--force]
                    generate a module that is already green   (start here, do not copy a folder)
```

## What good looks like

A module is one object literal whose declaration produces the types it then uses:

```ts
export default defineModule({
  id: 'tags',                                  // MUST equal the folder name
  summary: 'Save and recall canned responses.',
  capabilities: ['db', 'audit', 'clock'],      // one line = the entire blast radius
  config: z.object({
    maxPerGuild: z.coerce.number().int().positive().default(200),
  }),
  permissions: {
    read:  { summary: 'Use a tag',              fallback: 'everyone' },
    write: { summary: 'Create, edit or delete', fallback: 'guild-admin' },
  },
  publishes: {},
  migrations: true,

  setup(ctx) {
    const svc = new TagService(tagsRepo(ctx.ports.db), ctx.ports.audit, ctx.config);
    return {
      commands: tagCommands(svc, ctx.perms),   // the closure IS the dependency injection
      health: async () => ({ status: 'ok' as const, detail: `${svc.count()} tags` }),
    };
  },
});
```

No decorators, no container, no registration call. The folder is the wiring.
