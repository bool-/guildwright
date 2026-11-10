/**
 * NO FREE BUILDS, AT THE FRONT DOOR.
 *
 * `payer.test.ts` proves the DISPATCH-time half of the gate against a fake port. This file
 * proves the half that has to happen first, and it drives the real modal-submit handler through
 * `install()` rather than calling a helper, because the claim being made is not "the check
 * returns the right answer" - it is "nothing is filed when the answer is no".
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT is not a wrong decision; it is a decision taken too
 * late. Refusing at approve time is also technically correct, and it leaves behind:
 *
 *   - a GitHub issue in the repository, open forever, describing work nobody will do;
 *   - an Approve/Reject card in a channel, demanding a human decision that can only end in
 *     "Reject", after that human has read the request and thought about it.
 *
 * Both are litter created by the bot, cleaned up by hand, for a build that could never have run.
 * So the assertions here are mostly about what did NOT happen: no issue, no card, no row.
 *
 * The other claim asserted here is the unpopular half of the product decision: THE OPERATOR IS
 * NOT EXEMPT. An owner bypass would be one line and nobody would notice it until a bill arrived,
 * so its absence is tested rather than trusted.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Err, Ok } from '#core/result';

import builder, { CREDENTIALS_NEXT_STEP } from '#modules/builder/module';
import type { FormHandlerSpec, FormSubmission, InstalledModule, Outcome, ProgressHandle } from '#core/module';
import type { FormValues } from '#core/args';
import { createEventBus } from '#core/events';
import { errors, userMessage } from '#core/errors';
import { buildEnvironmentName, toEnum, userTextForTest } from '#core/text';
import { newCardNonce, newRequestId, toChannelId, toGuildId, toUserId, type ChannelId, type GuildId, type UserId } from '#core/ids';
import type { SurfaceRef } from '#core/view';
import type { BuildsPort, IssuesPort } from '#core/ports';
import {
  fakeAccess,
  fakeAudit,
  fakeBuilds,
  fakeClock,
  fakeDb,
  fakeDiscord,
  fakeIssues,
  fakeJobs,
  fakeLogger,
  type FakeBuilds,
  type FakeDb,
  type FakeDiscord,
  type FakeIssues,
  fakeRepoSet,
  fakeRepos,
  fakeScopedByKey,
  oneRepoPorts,
} from '#testing/fakes';

const REQUESTER = '111111111111111111';
const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';
const NOW = 1_700_000_000_000;

/** Branded ids, built through the real parsers so a fixture cannot be a shape the bot rejects. */
function userId(raw: string): UserId {
  const r = toUserId(raw);
  if (!r.ok) throw new Error(`fixture: ${raw} is not a user id`);
  return r.value;
}
function guildId(raw: string): GuildId {
  const r = toGuildId(raw);
  if (!r.ok) throw new Error(`fixture: ${raw} is not a guild id`);
  return r.value;
}
function channelId(raw: string): ChannelId {
  const r = toChannelId(raw);
  if (!r.ok) throw new Error(`fixture: ${raw} is not a channel id`);
  return r.value;
}

/**
 * The one cast in this file, and it is structural rather than lazy.
 *
 * `ProgressHandle` carries a module-private symbol on purpose: that is what makes it
 * unserialisable, so a live interaction token cannot be smuggled into a durable job payload. A
 * test therefore cannot build one by writing the fields, and the router does exactly this same
 * cast for exactly this reason. Nothing in the request path reads it.
 */
function progress(): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => ({ guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' }),
  };
  return stub as unknown as ProgressHandle;
}

/** The modal's answers, as the router would hand them over: `UserText`, never strings. */
function values(fields: Readonly<Record<string, string>>): FormValues {
  return {
    names: Object.keys(fields),
    text(name) {
      const raw = fields[name];
      return raw === undefined ? undefined : userTextForTest(raw);
    },
    textRequired(name) {
      const raw = fields[name];
      // Same contract as the real accessor: absence means the spec and the registered modal
      // drifted, which is a deploy bug and should be loud.
      if (raw === undefined) throw new Error(`no field "${name}" was submitted`);
      return userTextForTest(raw);
    },
    choice(name, allowed) {
      const raw = fields[name];
      return raw === undefined ? Ok(undefined) : toEnum(userTextForTest(raw), allowed);
    },
  };
}

function submission(actorId: string, opts: { readonly isAppOwner: boolean } = { isAppOwner: false }): FormSubmission {
  return {
    id: newRequestId(NOW),
    actor: {
      userId: userId(actorId),
      roleIds: [],
      isAppOwner: opts.isAppOwner,
      memberPermissions: 0n,
      appPermissions: 0n,
    },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action: 'request', entityId: newRequestId(NOW), nonce: newCardNonce() },
    fields: values({ title: 'Add a /ping command', detail: 'It should reply pong, and nothing else.' }),
    progress: progress(),
    at: NOW,
  };
}

interface Harness {
  readonly installed: InstalledModule;
  readonly form: FormHandlerSpec;
  readonly issues: FakeIssues;
  readonly discord: FakeDiscord;
  readonly builds: FakeBuilds;
  readonly db: FakeDb;
}

/**
 * The real module, really installed, against fakes.
 *
 * WHY `install()` and not a hand-called helper: `requireOwnCredentials` is a zod field with a
 * default, and "the default is TRUE" is one of the things being asserted. Only the real config
 * parse can answer that, and only `install()` runs it.
 */
function harness(rawConfig: unknown = {}): Harness {
  const issues = fakeIssues();
  const discord = fakeDiscord();
  const builds = fakeBuilds();
  const db = fakeDb('m_builder_');
  const r = builder.install({
    // `access` is new this round: `/request cancel` and `/request list all` have to ask whether
    // the caller is an approver, and a module cannot answer that without the port. A missing one
    // QUARANTINES the module, which is why every harness in this folder has to be told about it.
    ports: { db, audit: fakeAudit(), clock: fakeClock(NOW), jobs: fakeJobs(), discord, access: fakeAccess(), ...oneRepoPorts({ issues, builds }) },
    rawConfig,
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(r.ok, 'the builder must install against the standard fakes');
  if (!r.ok) throw new Error('unreachable');

  const form = r.value.forms.find((f) => f.name === 'request');
  assert.ok(form !== undefined, 'the builder must expose a "request" form handler');
  if (form === undefined) throw new Error('unreachable');

  return { installed: r.value, form, issues, discord, builds, db };
}

/** Give this user a stored credential, the way `/credentials set` would. */
function bringACredential(h: Harness, id: string): void {
  h.builds.environments.set(buildEnvironmentName(id), ['CLAUDE_CODE_OAUTH_TOKEN']);
}

/** Everything the module would have created. All of it must be absent on a refusal. */
function litter(h: Harness): { issues: number; cards: number; writes: readonly string[] } {
  return {
    issues: h.issues.created.length,
    cards: h.discord.posted.length,
    writes: h.db.statements.filter((s) => /INSERT/iu.test(s)),
  };
}

function failure(outcome: Outcome): string {
  assert.equal(outcome.kind, 'fail', `expected a refusal, got "${outcome.kind}"`);
  return outcome.kind === 'fail' ? userMessage(outcome.error) : '';
}

// ---------------------------------------------------------------------------------------
// The refusal, and the absence of litter
// ---------------------------------------------------------------------------------------

test('a requester with no credential is refused, and NOTHING is filed', async () => {
  const h = harness();

  const outcome = await h.form.handle(submission(REQUESTER));

  assert.equal(outcome.kind, 'fail', 'a build nobody can pay for must not be accepted');
  assert.deepEqual(
    litter(h),
    { issues: 0, cards: 0, writes: [] },
    'no issue, no approval card and no row: refusing later is what leaves all three behind',
  );
});

test('the requester is told exactly what to do, and told it privately', async () => {
  // A refusal with no instructions is the dead end `AppError.nextStep` exists to forbid, and a
  // refusal in public is a spend policy announced in someone else's channel.
  const h = harness();

  const message = failure(await h.form.handle(submission(REQUESTER)));

  assert.match(message, /\/credentials set/u, 'the command to run');
  assert.match(message, /sk-ant-api/u, 'the API key shape');
  assert.match(message, /console\.anthropic\.com/u, 'and where an API key comes from');
  assert.match(message, /sk-ant-oat/u, 'the OAuth token shape');
  assert.match(message, /claude setup-token/u, 'and how to mint one');
  assert.ok(message.includes(CREDENTIALS_NEXT_STEP), 'the same sentence the dispatch check uses');

  assert.equal(h.form.ack, 'defer-ephemeral', 'so the refusal is visible only to the person who must act on it');
});

test('the gate is ON when an operator configures nothing at all', async () => {
  // The product decision lives in a zod default, so it is asserted through the real config parse
  // rather than by reading the schema. An install with `{}` must already be closed.
  const h = harness({});
  const outcome = await h.form.handle(submission(REQUESTER));
  assert.equal(outcome.kind, 'fail', 'default-open would subsidise every stranger on day one');

  const health = await h.installed.health();
  assert.match(health.detail, /own build/u, 'and /status says which way the money flows');
});

test('THE OPERATOR IS NOT EXEMPT: an app owner with no credential is refused too', async () => {
  // The consequence of "no free builds", handled deliberately rather than papered over. An owner
  // bypass is one line, would be invisible in review, and would be discovered by a bill.
  const h = harness();

  const outcome = await h.form.handle(submission(REQUESTER, { isAppOwner: true }));

  assert.equal(outcome.kind, 'fail', 'the person holding the token pays like everybody else');
  assert.deepEqual(litter(h), { issues: 0, cards: 0, writes: [] });
});

test('no owner bypass exists to be reached: the module never reads isAppOwner', async () => {
  // The behavioural test above can only prove the bypass is not on THAT path. This proves there
  // is no such branch anywhere in the module, which is the claim actually being made.
  const source = readFileSync('src/modules/builder/module.ts', 'utf8');
  assert.ok(
    !/isAppOwner/u.test(source),
    'the builder must not branch on app ownership; "no free builds" means no exceptions',
  );
});

// ---------------------------------------------------------------------------------------
// The path that still works
// ---------------------------------------------------------------------------------------

test('a requester who brought a credential is filed exactly as before', async () => {
  const h = harness();
  bringACredential(h, REQUESTER);

  const outcome = await h.form.handle(submission(REQUESTER));

  assert.equal(outcome.kind, 'view', 'the gate must not cost a paying user anything');
  assert.equal(h.issues.created.length, 1, 'the issue is filed');
  assert.equal(h.discord.posted.length, 1, 'and the approval card is posted');
});

test('an API key funds a request exactly as much as a subscription token', async () => {
  // The bot must never care which of the two a user brought - the workflow passes both and lets
  // whichever exists resolve. A gate that recognised only one would lock out every Pro/Max
  // subscriber at the front door.
  const h = harness();
  h.builds.environments.set(buildEnvironmentName(REQUESTER), ['ANTHROPIC_API_KEY']);

  const outcome = await h.form.handle(submission(REQUESTER));
  assert.equal(outcome.kind, 'view');
  assert.equal(h.issues.created.length, 1);
});

test('an EMPTY environment is refused at the door, not accepted and failed later', async () => {
  // `/credentials clear` deletes the environment; a revoked or hand-deleted secret leaves it
  // present and empty. Both mean "cannot pay", and only the sentence differs.
  const h = harness();
  h.builds.environments.set(buildEnvironmentName(REQUESTER), []);

  const message = failure(await h.form.handle(submission(REQUESTER)));

  assert.match(message, /no longer stored/u, 'the diagnosis names what actually happened');
  assert.match(message, /\/credentials set/u, 'and the fix is still the same command');
  assert.deepEqual(litter(h), { issues: 0, cards: 0, writes: [] });
});

test('a GitHub outage does not read as "you have no credentials"', async () => {
  // Telling a user to configure something they already configured is worse than saying nothing:
  // they will do it, it will not help, and the real cause stays hidden.
  const h = harness();
  h.builds.environmentCredentials = async () => ({
    ok: false,
    error: {
      kind: 'upstream',
      code: 'upstream.github.500',
      service: 'github',
      status: 500,
      userDetail: 'An upstream service rejected that request.',
      nextStep: 'Try again in a minute.',
      internal: null,
      retryable: true,
    },
  });

  const message = failure(await h.form.handle(submission(REQUESTER)));

  assert.ok(!message.includes('/credentials set'), 'a 500 is not a missing credential');
  assert.deepEqual(litter(h), { issues: 0, cards: 0, writes: [] }, 'and it still files nothing');
});

// ---------------------------------------------------------------------------------------
// requireOwnCredentials: false — the operator who WANTS to fund a private server
// ---------------------------------------------------------------------------------------

test('with the gate off, a requester who brought nothing is filed, exactly as today', async () => {
  // Requirement 4: the shared path is gated, not deleted. One config field is the only
  // difference between this test and the first one in the file.
  const h = harness({ requireOwnCredentials: false });

  const outcome = await h.form.handle(submission(REQUESTER));

  assert.equal(outcome.kind, 'view', 'an operator may still subsidise their own server');
  assert.equal(h.issues.created.length, 1, 'the issue is filed');
  assert.equal(h.discord.posted.length, 1, 'and the approval card is posted');
});

test('with the gate off, the front door does not even ask GitHub who is paying', async () => {
  // The reads cost a rate-limit token each and answer a question nobody is asking in this
  // configuration. `dispatched`/`signed` stay empty because filing an issue spends nothing.
  const h = harness({ requireOwnCredentials: false });
  const asked: string[] = [];
  const real = h.builds.environmentCredentials.bind(h.builds);
  h.builds.environmentCredentials = async (name) => {
    asked.push(name);
    return real(name);
  };

  await h.form.handle(submission(REQUESTER));

  assert.deepEqual(asked, [], 'no credential read happens when no credential is required');
  assert.equal(h.builds.dispatched.length, 0, 'and submitting a request still dispatches nothing');
});

test('with the gate off, /status says the operator is the one paying', async () => {
  const h = harness({ requireOwnCredentials: false });
  const health = await h.installed.health();
  assert.match(health.detail, /ai-agent/u, 'the shared environment is named, so the bill is not a surprise');
});

// ---------------------------------------------------------------------------------------
// WHICH REPOSITORY (RFC-001 PR 2.1): the front door builds in `ReposPort.resolve(guild)`
// ---------------------------------------------------------------------------------------

/** The builder over a TWO-repository set, each repository with its own fakes. */
function twoRepoHarness(defaultKey: 'main' | 'events' | null) {
  const set = fakeRepoSet([
    { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: defaultKey === 'main' },
    { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: defaultKey === 'events' },
  ]);
  const repos = {
    main: { issues: fakeIssues(), builds: fakeBuilds() },
    events: { issues: fakeIssues(), builds: fakeBuilds() },
  };
  const discord = fakeDiscord();
  const r = builder.install({
    ports: {
      db: fakeDb('m_builder_'),
      audit: fakeAudit(),
      clock: fakeClock(NOW),
      jobs: fakeJobs(),
      discord,
      access: fakeAccess(),
      repos: fakeRepos(set),
      issues: fakeScopedByKey<IssuesPort>(set, { main: repos.main.issues, events: repos.events.issues }),
      builds: fakeScopedByKey<BuildsPort>(set, { main: repos.main.builds, events: repos.events.builds }),
    },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(r.ok, 'the builder installs over a repository set');
  if (!r.ok) throw new Error('unreachable');
  const form = r.value.forms.find((f) => f.name === 'request');
  if (form === undefined) throw new Error('unreachable');
  for (const k of ['main', 'events'] as const) repos[k].builds.environments.set(buildEnvironmentName(REQUESTER), ['CLAUDE_CODE_OAUTH_TOKEN']);
  return { installed: r.value, form, repos, discord };
}

test('REPO SET: a request is filed, gated and credential-checked in the guild\'s repository (the default), and nowhere else', async () => {
  const h = twoRepoHarness('main');
  const outcome = await h.form.handle(submission(REQUESTER));
  assert.equal(outcome.kind, 'view', 'filed');
  assert.equal(h.repos.main.issues.created.length, 1, 'into the default repository');
  assert.equal(h.repos.events.issues.created.length, 0, 'and not into its neighbour');
  assert.equal(h.repos.main.builds.gateChecks, 1, 'the gate checked is the gate of the repository it lands in');
  assert.equal(h.repos.events.builds.gateChecks, 0);
});

test('REPO SET: drifted gates in ANOTHER repository do not stop a request in this one (scoped refusal)', async () => {
  const h = twoRepoHarness('main');
  h.repos.events.builds.gateAnswer = Err(errors.config('github.gates', 'Builds are disabled: drift in acme/events-modules.', 'Run template apply.'));
  const outcome = await h.form.handle(submission(REQUESTER));
  assert.equal(outcome.kind, 'view');
  assert.equal(h.repos.main.issues.created.length, 1);

  // And the other way round: drift in the repository this guild builds in refuses, filing nothing.
  const g = twoRepoHarness('events');
  g.repos.events.builds.gateAnswer = Err(errors.config('github.gates', 'Builds are disabled: drift in acme/events-modules.', 'Run template apply.'));
  assert.equal((await g.form.handle(submission(REQUESTER))).kind, 'fail');
  assert.equal(g.repos.events.issues.created.length + g.repos.main.issues.created.length, 0);
});

test('REPO SET: several repositories and NO default refuses at the front door with the unmapped sentence, filing nothing', async () => {
  const h = twoRepoHarness(null);
  const outcome = await h.form.handle(submission(REQUESTER));
  assert.equal(outcome.kind, 'fail');
  if (outcome.kind !== 'fail') return;
  assert.equal(outcome.error.code, 'config.repos.unmapped');
  assert.equal(outcome.error.internal, 'This server is not linked to a repository yet, so nothing can be built from it.');
  assert.equal(h.repos.main.issues.created.length + h.repos.events.issues.created.length, 0, 'nothing filed anywhere');
  assert.equal(h.discord.posted.length, 0);
  const health = await h.installed.health();
  assert.equal(health.status, 'down', '/status says builds have nowhere to go');
  assert.match(health.detail, /"default": true in GITHUB_REPOS_JSON/u);
});

test('REPO SET: /status reports the default repository, and each other repository\'s readiness against THAT repository', async () => {
  const h = twoRepoHarness('main');
  h.repos.events.builds.gateAnswer = Err(errors.config('github.gates', 'Builds are disabled: drift in acme/events-modules.', 'Run template apply.'));
  await h.repos.events.builds.verifyGates();
  const health = await h.installed.health();
  assert.equal(health.status, 'ok', 'the repository builds land in is ready');
  assert.match(health.detail, /builds land in main \(acme\/bot-modules\); other repositories: events \(acme\/events-modules\): down - /u);

  // A one-repository install's line carries none of that: unchanged from phase 1.
  const one = harness();
  assert.doesNotMatch((await one.installed.health()).detail, /other repositories/u);
});
