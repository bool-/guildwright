/**
 * THE TEST THAT ANSWERS "DOES IT ACTUALLY WORK".
 *
 * Every other test in this module is a unit or a narrow integration: one card, one query, one
 * job arm. Nothing walked the machine. So the flagship feature - the entire reason this
 * repository exists - was assembled from pieces that were each individually proven and had
 * never once been run end to end. This file walks it:
 *
 *     /request new -> credential check -> GitHub issue -> approval card posted
 *       -> Approve clicked -> compare-and-set to `dispatching` -> job enqueued
 *       -> dispatch -> polled queued, then in-progress, then success
 *       -> pull request found -> card edited -> REQUESTER ACTUALLY NOTIFIED
 *       -> row terminal -> THE CONCURRENCY SLOT COMES BACK
 *
 * and then the six branches that decide whether it is safe as well as working.
 *
 * WHAT IS REAL HERE, because the value of this file is exactly the list of things it does NOT
 * stub:
 *
 *   - THE REAL MODULE, through `builder.install(...)`. Not a hand-built closure. The manifest
 *     is what declares the jobs, the actions, the form and the four commands, and a manifest
 *     that stopped declaring one of them would fail here rather than in production.
 *   - A REAL SQLITE DATABASE, with THE REAL MIGRATION FILES applied in ledger order. Every
 *     state transition below is SQLite's answer, not a fake's opinion. `fakeDb.execute` reports
 *     one row changed no matter what it was asked, which is how a `SELECT *` defect once
 *     survived 255 green tests - a compare-and-set cannot be proven against a fake that always
 *     says the caller won.
 *   - THE REAL REPO, the real state machine, and the real `activeCounts` arithmetic that
 *     decides whether a guild can file another request.
 *
 * WHAT IS FAKED, and why that is honest: the four things on the other side of the network -
 * Discord, GitHub issues, GitHub Actions, and the job RUNNER. Those are adapters with their own
 * tests. This file is about the module's behaviour when they answer.
 *
 * THE ONE THING THIS FILE EMULATES RATHER THAN CALLS, stated plainly rather than hidden: the
 * ROUTER. `handoff` is an outcome the module RETURNS; the router is what posts the card and
 * enqueues the job with the resulting `SurfaceRef` injected under `SURFACE_KEY`. `deliver()`
 * below does that in four lines and is commented with the router line it mirrors
 * (`router.ts`: `payload: { ...job.payload, [SURFACE_KEY]: surface }`). Driving the real router
 * would mean standing up a Discord gateway client, which would test discord.js rather than
 * this. That the router is not covered anywhere is a known gap, recorded in
 * docs/KNOWN-ISSUES.md; it is not fixed by pretending here.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import builder, { buildRepo, type BuildRepo, type CancelsRuns } from '#modules/builder/module';
import { buildDedupeKey, type BuildState } from '#modules/builder/rows';
import { openSqlite, type SqliteDb } from '#adapters/sqlite/db';
import { createEventBus } from '#core/events';
import { SURFACE_KEY, type ClickInvocation, type ErasedJob, type FormSubmission, type InstalledModule, type Invocation, type JobRuntime, type ProgressHandle } from '#core/module';
import type { AccessPort, BuildsPort, PrRef, RunStatus } from '#core/ports';
import type { Args, FormValues } from '#core/args';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import { Err, Ok } from '#core/result';
import type { JsonObject } from '#core/json';
import type { SurfaceRef, View, ViewNode } from '#core/view';
import { actionsToken, parseHttpsUrl, renderSafeMarkdown, toEnum, userTextForTest, type HttpsUrl } from '#core/text';
import {
  newCardNonce,
  newRequestId,
  toCardNonce,
  toChannelId,
  toGuildId,
  toUserId,
  type ChannelId,
  type GuildId,
  type RequestId,
  type UserId,
} from '#core/ids';
import {
  fakeAccess,
  fakeAudit,
  fakeBuilds,
  fakeClock,
  fakeDiscord,
  fakeIssues,
  fakeJobs,
  fakeLogger,
  type FakeAudit,
  type FakeBuilds,
  type FakeDiscord,
  type FakeIssues,
  type FakeJobs,
  oneRepoPorts,
} from '#testing/fakes';

const MIGRATIONS_DIR = 'src/modules/builder/migrations';
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';
const REQUESTER = '111111111111111111';
const APPROVER = '999999999999999999';
const SECOND_APPROVER = '888888888888888888';

const PR_URL = 'https://github.com/o/r/pull/7';
const RUN_URL = 'https://github.com/o/r/actions/runs/9';
/** What `fakeBuilds.dispatch` reports as the adopted run. First writer wins on `run_url`. */
const DISPATCH_RUN_URL = 'https://github.com/o/r/actions/runs/1';

// ---------------------------------------------------------------------------------------
// Branded-id doors. Every one of these is a `Result`, so a bad fixture fails here rather than
// somewhere confusing three frames later.
// ---------------------------------------------------------------------------------------

function userId(raw: string): UserId {
  const r = toUserId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a user id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function guildId(raw: string): GuildId {
  const r = toGuildId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a guild id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function channelId(raw: string): ChannelId {
  const r = toChannelId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a channel id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function httpsUrl(raw: string): HttpsUrl {
  const r = parseHttpsUrl(raw);
  assert.ok(r.ok, `fixture: ${raw} is not an https url`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

/**
 * The one cast in this file, and it is structural rather than lazy. `ProgressHandle` carries a
 * module-private symbol ON PURPOSE - that is what makes it unserialisable, so a live
 * interaction token cannot be written into a durable job payload. A test cannot build one by
 * writing the fields, and the router performs this same cast for this same reason. Nothing on
 * any path below reads it.
 */
function progress(surface: SurfaceRef): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => surface,
  };
  return stub as unknown as ProgressHandle;
}

// ---------------------------------------------------------------------------------------
// THE WORLD: one database, and a module that can be installed over it more than once
// ---------------------------------------------------------------------------------------

/**
 * A run of GitHub Actions, scripted.
 *
 * WHY A QUEUE AND NOT A CONSTANT: the whole point of the poll loop is that it is called
 * repeatedly and must behave DIFFERENTLY each time - `queued`, then `in-progress`, then
 * `success` - while returning `retry` (which consumes no attempt) for the first two. A fake that
 * answered `success` on the first poll would skip the only interesting part.
 */
interface RunScript {
  /** Statuses handed out in order; the last one repeats once exhausted. */
  statuses: RunStatus[];
  pr: PrRef | null;
}

interface World {
  readonly db: SqliteDb;
  readonly repo: BuildRepo;
  readonly discord: FakeDiscord;
  readonly issues: FakeIssues;
  readonly audit: FakeAudit;
  readonly jobs: FakeJobs;
  readonly builds: FakeBuilds;
  /** Every run id the bot asked GitHub to cancel. The proof that a cancel reaches the money. */
  readonly cancelledRuns: readonly number[];
  readonly script: RunScript;
  /**
   * Install the module AGAIN over the SAME database.
   *
   * This is what makes the restart test possible, and it is the reason this file does not reuse
   * `harness.test.ts`: that rig opens and closes a database per install, so "the bot restarted"
   * could only ever have been simulated by seeding a row into a fresh process's fresh database -
   * which proves nothing, because the interesting claim is that a row a PREVIOUS process left
   * behind is picked up by a NEW one.
   */
  boot(): Booted;
  setNow(ms: number): void;
  now(): number;
  setApprover(allowed: boolean): void;
  close(): void;
}

interface Booted {
  readonly installed: InstalledModule;
  readonly build: ErasedJob;
  readonly expire: ErasedJob;
}

function migrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}

function world(rawConfig: unknown = {}): World {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok, 'the in-memory database must open');
  if (!opened.ok) throw new Error('unreachable');
  const db = opened.value;

  // THE REAL MIGRATIONS, in ledger order. Not a hand-written CREATE TABLE: a fixture schema is
  // a schema production does not have, and every column `selectRow` aliases has to exist here
  // or the row comes back with `undefined` in it and nothing complains.
  for (const sql of migrationFiles()) db.connection.exec(sql);

  const clock = fakeClock(NOW);
  const discord = fakeDiscord();
  const issues = fakeIssues();
  const audit = fakeAudit();
  const jobs = fakeJobs();
  const base = fakeBuilds();

  const script: RunScript = { statuses: [{ kind: 'in-progress', runUrl: null }], pr: null };
  const cancelledRuns: number[] = [];

  const builds: BuildsPort & CancelsRuns = {
    ...base,
    // THE PORT THIS ROUND ASKED FOR, modelled here because the lifecycle claim being tested is
    // that a withdrawal reaches the RUN, not merely the row. See `#modules/builder/ports`.
    async cancelRun(runId) {
      cancelledRuns.push(runId);
      return Ok({ kind: 'requested' });
    },
    async runStatus() {
      const next = script.statuses.length > 1 ? script.statuses.shift() : script.statuses[0];
      assert.ok(next !== undefined, 'the run script must never be empty');
      if (next === undefined) throw new Error('unreachable');
      return Ok(next);
    },
    async findPrForBranch() {
      return Ok(script.pr);
    },
    async runsSince() {
      return Ok(base.runsToday);
    },
  };

  let approver = true;
  const access: AccessPort = {
    ...fakeAccess(),
    check: () =>
      approver
        ? { allowed: true, layer: 'L1-allowlist' }
        : { allowed: false, layer: 'L3-deny', grantableBy: 'an admin' },
  };

  return {
    db,
    repo: buildRepo(db.moduleDb('builder')),
    discord,
    issues,
    audit,
    jobs,
    builds: base,
    cancelledRuns,
    script,
    boot() {
      const r = builder.install({
        ports: { db: db.moduleDb('builder'), audit, clock, jobs, discord, access, ...oneRepoPorts({ issues, builds }) },
        rawConfig,
        bus: createEventBus(() => undefined),
        logger: fakeLogger(),
      });
      assert.ok(r.ok, 'the builder module must install');
      if (!r.ok) throw new Error('unreachable');
      const jobOf = (type: string): ErasedJob => {
        const found = r.value.jobs.find((j) => j.type === type);
        assert.ok(found !== undefined, `the builder must declare a "${type}" job`);
        if (found === undefined) throw new Error('unreachable');
        return found;
      };
      return { installed: r.value, build: jobOf('build'), expire: jobOf('expire') };
    },
    setNow: (ms) => clock.set(ms),
    now: () => clock.now(),
    setApprover: (allowed) => {
      approver = allowed;
    },
    close: () => db.close(),
  };
}

/** Bring-your-own-credentials, satisfied - the state a requester reaches by running
 *  `/credentials set`. The branch where they have NOT is its own test below. */
function fund(w: World, who = REQUESTER): void {
  w.builds.environments.set(`user-${who}`, ['ANTHROPIC_API_KEY']);
}

function runtime(attempt = 1, deadlineAtMs = NOW + 6 * HOUR): JobRuntime {
  return {
    attempt,
    deadlineAtMs,
    signal: new AbortController().signal,
    heartbeat: (): void => undefined,
    sleep: async (): Promise<void> => undefined,
  };
}

// ---------------------------------------------------------------------------------------
// Driving the module the way the router does
// ---------------------------------------------------------------------------------------

function formValues(fields: Readonly<Record<string, string>>): FormValues {
  return {
    names: Object.keys(fields),
    text: (name) => (fields[name] === undefined ? undefined : userTextForTest(String(fields[name]))),
    textRequired(name) {
      const raw = fields[name];
      if (raw === undefined) throw new Error(`no field "${name}" was submitted`);
      return userTextForTest(raw);
    },
    choice(name, allowed) {
      const raw = fields[name];
      return raw === undefined ? Ok(undefined) : toEnum(userTextForTest(raw), allowed);
    },
  };
}

function argsOf(raw: Readonly<Record<string, string | boolean>> = {}): Args {
  const cannot = (name: string): Err<AppError> =>
    Err(errors.validation(name, 'not modelled by this fixture', 'Use text or bool.'));
  return {
    names: Object.keys(raw),
    text: (name) => (typeof raw[name] === 'string' ? userTextForTest(String(raw[name])) : undefined),
    textRequired(name) {
      const v = raw[name];
      if (typeof v !== 'string') throw new Error(`no option "${name}" was supplied`);
      return userTextForTest(v);
    },
    integer: (name) => cannot(name),
    bool: (name) => (typeof raw[name] === 'boolean' ? Boolean(raw[name]) : undefined),
    user: () => undefined,
    role: () => undefined,
    channel: () => undefined,
    choice: (name) => cannot(name),
  };
}

const CARD_SURFACE: SurfaceRef = { guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' };

function submission(
  fields: Readonly<Record<string, string>> = {
    title: 'Dark mode for the dashboard',
    detail: 'The night shift is squinting. Respect the OS setting and add a manual toggle.',
  },
  actorId = REQUESTER,
): FormSubmission {
  return {
    id: newRequestId(NOW),
    actor: { userId: userId(actorId), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action: 'request', entityId: newRequestId(NOW), nonce: newCardNonce() },
    fields: formValues(fields),
    progress: progress(CARD_SURFACE),
    at: NOW,
  };
}

function invocation(opts: { actorId?: string; at?: number; args?: Readonly<Record<string, string | boolean>> } = {}): Invocation {
  const at = opts.at ?? NOW;
  return {
    id: newRequestId(at),
    actor: {
      userId: userId(opts.actorId ?? REQUESTER),
      roleIds: [],
      isAppOwner: false,
      memberPermissions: 0n,
      appPermissions: 0n,
    },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    args: argsOf(opts.args ?? {}),
    progress: progress(CARD_SURFACE),
    at,
  };
}

/**
 * A click on the Approve/Reject pair, carrying THE ROW'S OWN NONCE.
 *
 * That detail is not decoration: check (3) of the approve handler compares the stored nonce to
 * the one in the `custom_id`, and it is what makes a card superseded by `/request retry` inert.
 * A test that minted a fresh nonce would be testing the staleness fence instead of the approval.
 */
function click(w: World, id: RequestId, action: string, actorId: string, at = NOW): ClickInvocation {
  const row = w.repo.get(id);
  assert.ok(row !== undefined, 'the request row must exist before it can be clicked');
  if (row === undefined) throw new Error('unreachable');
  const nonce = toCardNonce(row.nonce);
  assert.ok(nonce.ok, 'the persisted nonce must be a card nonce');
  if (!nonce.ok) throw new Error('unreachable');
  return {
    id: newRequestId(at),
    actor: { userId: userId(actorId), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action, entityId: id, nonce: nonce.value },
    surface: CARD_SURFACE,
    progress: progress(CARD_SURFACE),
    at,
  };
}

function actionOf(b: Booted, name: string): { handle(click: ClickInvocation): Promise<{ kind: string }> } {
  const found = b.installed.actions.find((a) => a.name === name);
  assert.ok(found !== undefined, `the builder must expose a "${name}" action`);
  if (found === undefined) throw new Error('unreachable');
  return found;
}

function formOf(b: Booted): { handle(sub: FormSubmission): Promise<{ kind: string }> } {
  const found = b.installed.forms.find((f) => f.name === 'request');
  assert.ok(found !== undefined, 'the builder must expose a "request" form handler');
  if (found === undefined) throw new Error('unreachable');
  return found;
}

function commandOf(b: Booted, name: string) {
  const found = b.installed.commands.find((c) => c.name === name);
  assert.ok(found !== undefined, `the builder must declare a "${name}" command`);
  if (found === undefined) throw new Error('unreachable');
  return found;
}

// ---------------------------------------------------------------------------------------
// Reading what the bot said
// ---------------------------------------------------------------------------------------

function headings(view: View): readonly string[] {
  return view.nodes.filter((n): n is Extract<ViewNode, { kind: 'heading' }> => n.kind === 'heading').map((n) => n.text);
}
function textOf(view: View): string {
  return view.nodes.map((n) => (n.kind === 'text' || n.kind === 'field' ? renderSafeMarkdown(n.md) : '')).join(' ');
}
function lastEdit(w: World): View {
  const last = w.discord.drawn.at(-1);
  assert.ok(last !== undefined, 'the bot must have drawn the card');
  if (last === undefined) throw new Error('unreachable');
  return last;
}
function lastPost(w: World): View {
  const last = w.discord.posted.at(-1);
  assert.ok(last !== undefined, 'the bot must have posted a message');
  if (last === undefined) throw new Error('unreachable');
  return last.view;
}
/** Every message the bot POSTED that would actually notify somebody. */
function notifications(w: World): readonly View[] {
  return w.discord.posted.filter((p) => p.view.mentionUserId !== undefined).map((p) => p.view);
}
function auditActions(w: World): readonly string[] {
  return w.audit.entries.map((e) => e.action);
}
function stateOf(w: World, id: RequestId): BuildState {
  const row = w.repo.get(id);
  assert.ok(row !== undefined, 'the row must exist');
  if (row === undefined) throw new Error('unreachable');
  return row.state;
}

/** The run id a row is tracking, so a cancel assertion names the real thing rather than a literal. */
function runIdOf(w: World, id: RequestId): number {
  const runId = w.repo.get(id)?.runId;
  assert.ok(typeof runId === 'number', 'the row must be tracking a run by now');
  if (typeof runId !== 'number') throw new Error('unreachable');
  return runId;
}

/** The row `/request new` just created. There is exactly one per submission. */
function newestRequest(w: World): RequestId {
  const rows = w.repo.recentForRequester(GUILD, REQUESTER, 5);
  const first = rows[0];
  assert.ok(first !== undefined, 'a request row must have been inserted');
  if (first === undefined) throw new Error('unreachable');
  return first.id;
}

/**
 * WHAT THE ROUTER DOES WITH A `handoff`, in four lines.
 *
 * `router.ts` posts the card, then enqueues the job with the resulting `SurfaceRef` injected:
 *
 *     io.enqueueJob(moduleId, { ...job, payload: { ...job.payload, [SURFACE_KEY]: surface } })
 *
 * The injection is the load-bearing part. It is why the poll job thirty minutes later can edit
 * a card without any interaction token, and it is why the payload below is built this way
 * rather than by hand.
 */
async function deliver(w: World, outcome: { kind: string }): Promise<JsonObject> {
  assert.equal(outcome.kind, 'handoff', 'Approve must hand off durable work rather than answering inline');
  const handoff = outcome as unknown as { readonly view: View; readonly job: { readonly payload: JsonObject; readonly dedupeKey?: string } };
  const posted = await w.discord.post(channelId(CHANNEL), handoff.view);
  assert.ok(posted.ok, 'the interim card must post');
  if (!posted.ok) throw new Error('unreachable');
  w.jobs.enqueue({
    type: 'build',
    payload: { ...handoff.job.payload, [SURFACE_KEY]: CARD_SURFACE },
    runAfterMs: w.now(),
    deadlineAtMs: w.now() + 6 * HOUR,
    // `dedupeKey` is REQUIRED on `JobRequest` and nullable, deliberately: a job with no fence
    // has to say so rather than omit it. The module always supplies one here.
    dedupeKey: handoff.job.dedupeKey ?? null,
  });
  return { ...handoff.job.payload, [SURFACE_KEY]: CARD_SURFACE };
}

function prRef(isDraft: boolean): PrRef {
  return { number: 7, url: httpsUrl(PR_URL), branch: 'agent/req-x', isDraft };
}

// =======================================================================================
// THE LIFECYCLE
// =======================================================================================

test('THE WHOLE LIFECYCLE: submit -> approve -> dispatch -> poll -> PR -> notified -> slot freed', async () => {
  const w = world();
  fund(w);
  try {
    const boot = w.boot();

    // -- 1. THE SLOT LEDGER STARTS EMPTY ------------------------------------------------
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 }, 'a fresh guild owes nothing');

    // -- 2. /request new: credential check, GitHub issue, approval card ------------------
    const filed = await formOf(boot).handle(submission());
    assert.equal(filed.kind, 'view', 'a funded requester must be accepted');

    assert.equal(w.issues.created.length, 1, 'exactly one GitHub issue is filed');
    assert.match(w.issues.created[0]?.title ?? '', /Dark mode/u, 'and it carries what was asked for');

    const id = newestRequest(w);
    assert.equal(stateOf(w, id), 'awaiting_approval', 'the row is parked for a human');

    const card = lastPost(w);
    assert.deepEqual(headings(card), ['Build request'], 'the approval card is posted to the channel');
    assert.match(textOf(card), /Dark mode for the dashboard/u, 'an approver can see WHAT they are funding');
    assert.match(textOf(card), /night shift is squinting/u, 'including the request in the requester’s own words');
    assert.equal(card.mentionUserId, undefined, 'and it pings nobody - the approver is reading it right now');

    // THE SLOT IS NOW HELD. This is the number that used to leak forever.
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 1, running: 0, filing: 0 });

    // -- 3. Approve: compare-and-set, then a handoff ------------------------------------
    const before = w.repo.get(id);
    assert.ok(before !== undefined);
    if (before === undefined) return;

    const approved = await actionOf(boot, 'approve').handle(click(w, id, 'approve', APPROVER));
    const payload = await deliver(w, approved);

    assert.equal(stateOf(w, id), 'dispatching', 'the CAS moved the row, and only the CAS could have');
    assert.ok((w.repo.get(id)?.version ?? 0) > before.version, 'and it burned the version token it raced on');
    assert.equal(w.jobs.enqueued.length, 1, 'exactly one poller was queued');
    assert.equal(
      w.jobs.enqueued[0]?.dedupeKey,
      buildDedupeKey(id, 0),
      'under the retry-aware key, so a later /request retry cannot be dropped as a duplicate of this one',
    );
    // The slot has MOVED from waiting to running, not been released - a build in flight still
    // occupies the guild, which is the whole point of counting them separately.
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 0, running: 1, filing: 0 });

    // -- 4. First job pass: DISPATCH ----------------------------------------------------
    const first = await boot.build.run(payload, runtime());
    assert.equal(first.kind, 'retry', 'a dispatch is not an answer; it starts the wait');
    assert.equal(w.builds.dispatched.length, 1, 'exactly one workflow run was dispatched');

    const inputs = w.builds.dispatched[0] ?? {};
    assert.equal(inputs['issue_number'], 1, 'the run is bound to the issue that was filed');
    // COMPARED AGAINST THE SAME PRODUCER THE MODULE USES, not against a string this test typed.
    // `environment_name` is an `ActionsToken` - an opaque branded object, because
    // `ActionsInput = number | boolean | ActionsToken` is what makes a raw string unable to
    // reach a workflow input at all (SC-1). Reading the brand open here would be inventing a
    // second way to build the value, which is exactly what the type exists to prevent.
    assert.deepEqual(
      inputs['environment_name'],
      actionsToken.buildEnvironment(REQUESTER),
      'the build is funded by the REQUESTER’s environment, not the operator’s shared one',
    );
    assert.deepEqual(
      inputs['request_id'],
      actionsToken.ulid(id),
      'and the run is correlated to THIS request - that substring is how findRunByName adopts it',
    );
    assert.equal(w.repo.get(id)?.state, 'running', 'the run id came back, so the row advanced');
    assert.equal(w.repo.get(id)?.dispatchAttempts, 1, 'and the attempt was counted BEFORE the network call');

    // -- 5. Poll: queued, then in-progress, then success --------------------------------
    w.script.statuses = [
      { kind: 'queued', runUrl: null },
      { kind: 'in-progress', runUrl: httpsUrl(RUN_URL) },
      { kind: 'success', runUrl: httpsUrl(RUN_URL) },
    ];

    const queued = await boot.build.run(payload, runtime(2));
    assert.equal(queued.kind, 'retry', 'a queued run is a wait');
    const inProgress = await boot.build.run(payload, runtime(3));
    assert.equal(inProgress.kind, 'retry', 'so is a running one');
    // THE RUN LOG URL IS PERSISTED, and it was learned at DISPATCH rather than from this poll.
    // `recordRunUrl` guards on `WHERE run_url IS NULL`, so the first writer wins and a later
    // poll cannot churn it. What matters is that it is on the row at all: the frame that draws
    // the failure card is `onDead`, which holds no `RunStatus` and could not look it up.
    assert.equal(w.repo.get(id)?.runUrl, DISPATCH_RUN_URL, 'the link that turns three manual hops into one click');
    // ONE edit so far, and it is not an ending: the building card re-drawn with the run link
    // the moment dispatch learned the run, so the person waiting can click through and watch.
    assert.equal(w.discord.edited.length, 1, 'only the run link has been drawn: a wait must not look like an ending');
    const waiting = w.discord.edited[0]?.view;
    assert.equal(waiting?.accent, 'pending', 'still the pending building card, not an outcome');
    assert.ok(
      waiting?.nodes.some((n) => n.kind === 'buttons' && n.links.some((l) => l.label === 'Run log' && l.url === DISPATCH_RUN_URL)),
      'with a Run log button pointing at the run dispatch adopted',
    );

    // -- 6. Success, and the pull request ------------------------------------------------
    w.script.pr = prRef(false);
    const done = await boot.build.run(payload, runtime(4));
    assert.deepEqual(done, { kind: 'done' }, 'the poller stops - a finished run must not be polled again');

    // -- 7. THE FINAL CARD ---------------------------------------------------------------
    const finalCard = lastEdit(w);
    assert.deepEqual(headings(finalCard), ['Pull request ready']);
    assert.match(textOf(finalCard), /pull\/7/u, 'with the address of the thing that was asked for');

    // -- 8. AND SOMEBODY IS ACTUALLY TOLD ------------------------------------------------
    //
    // Discord notifies on message CREATE, so an edit renders the mention and notifies nobody.
    // The final card is therefore POSTED - once - and the stale card deleted, so the requester
    // gets one ping and the channel holds one message for the request.
    const told = notifications(w);
    assert.equal(told.length, 1, 'exactly one message was POSTED carrying a mention');
    assert.equal(told[0], finalCard, 'and it IS the final card, not a second message repeating it');
    assert.equal(told[0]?.mentionUserId, REQUESTER, 'and it names the requester, from the persisted snowflake');
    assert.equal(w.discord.deleted.length, 1, 'the stale card is deleted');

    // -- 9. TERMINAL, AND THE SLOT COMES BACK -------------------------------------------
    assert.equal(stateOf(w, id), 'pr_open');
    assert.equal(w.repo.get(id)?.prUrl, PR_URL, 'the PR URL is kept, so /request list can link the OUTCOME');
    assert.deepEqual(
      w.repo.activeCounts(GUILD),
      { waiting: 0, running: 0, filing: 0 },
      'THE SLOT IS RELEASED. A finished build that keeps counting is how a guild bricks itself.',
    );

    // -- 10. And the whole thing is on the record ---------------------------------------
    const trail = auditActions(w);
    for (const expected of ['builder.request', 'builder.approve', 'builder.dispatch.environment']) {
      assert.ok(trail.includes(expected), `the audit trail must record ${expected}; it recorded ${trail.join(', ')}`);
    }

    // -- 11. THE GUILD CAN FILE AGAIN ---------------------------------------------------
    const again = await formOf(boot).handle(submission({ title: 'Another idea', detail: 'And another one.' }));
    assert.equal(again.kind, 'view', 'a released slot is one the next requester can actually use');
  } finally {
    w.close();
  }
});

// =======================================================================================
// THE BRANCHES
// =======================================================================================

test('no credentials: refused at the front door, and NO GitHub issue is created', async () => {
  const w = world();
  // Deliberately NOT funded: this models somebody who has never run `/credentials set`.
  try {
    const boot = w.boot();
    const out = await formOf(boot).handle(submission());

    assert.equal(out.kind, 'fail', 'a requester who brought nothing must be refused');
    const failure = out as unknown as { readonly error: AppError };
    assert.match(
      `${failure.error.userDetail} ${failure.error.nextStep}`,
      /\/credentials set/u,
      'and told exactly how to fix it - "you need credentials" with no instruction is the dead end nextStep exists to prevent',
    );

    // THE ASSERTION THAT MATTERS. Refusing later would leave a permanent GitHub issue and a
    // card demanding a human decision, both describing a build that could never have run.
    assert.deepEqual(w.issues.created, [], 'nothing was written to the repository');
    assert.deepEqual(w.discord.posted, [], 'and no approval card was posted');
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 }, 'and no slot was taken');
  } finally {
    w.close();
  }
});

test('two approvers race: the second loses the compare-and-set, and NOTHING is dispatched twice', async () => {
  const w = world();
  fund(w);
  try {
    const boot = w.boot();
    await formOf(boot).handle(submission());
    const id = newestRequest(w);

    // BOTH CLICKS ARE BUILT FIRST, from the same row version - which is what actually happens
    // when two approvers are looking at the same card. Building the second one after the first
    // has landed would be testing a stale-card refusal instead of a race.
    const firstClick = click(w, id, 'approve', APPROVER);
    const secondClick = click(w, id, 'approve', SECOND_APPROVER);

    const won = await actionOf(boot, 'approve').handle(firstClick);
    const payload = await deliver(w, won);

    const lost = await actionOf(boot, 'approve').handle(secondClick);
    assert.equal(lost.kind, 'fail', 'the second approver must be refused');
    const failure = lost as unknown as { readonly error: AppError };
    assert.match(
      failure.error.userDetail,
      /not waiting for approval|approved this a moment before/u,
      'and told what happened, rather than seeing nothing at all',
    );

    // Drive the job to a dispatch and prove the money was spent exactly once.
    await boot.build.run(payload, runtime());
    assert.equal(w.builds.dispatched.length, 1, 'ONE workflow run. A double dispatch is a double bill.');
    assert.equal(w.jobs.enqueued.length, 1, 'and one poller');
    assert.equal(
      auditActions(w).filter((a) => a === 'builder.approve').length,
      1,
      'and one approval on the record - two would make the trail lie about who authorised the spend',
    );
  } finally {
    w.close();
  }
});

test('the bot RESTARTS mid-build: a fresh module over the same database re-adopts the row and the poll continues', async () => {
  const w = world();
  fund(w);
  try {
    // ---- the process that files and approves ----------------------------------------
    const first = w.boot();
    await formOf(first).handle(submission());
    const id = newestRequest(w);
    const payload = await deliver(w, await actionOf(first, 'approve').handle(click(w, id, 'approve', APPROVER)));
    await first.build.run(payload, runtime());
    assert.equal(stateOf(w, id), 'running', 'a run is in flight when the lights go out');

    // ---- the crash: the enqueue is lost, so nothing is left polling ------------------
    //
    // This models the one window the types cannot close - a crash between `dispatch()`
    // returning and the enqueue committing. Emptying the queue is what makes the row an ORPHAN:
    // state says `running` and no job exists to move it.
    (w.jobs.enqueued as { length: number }).length = 0;
    // The reconciler only adopts rows that have gone STALE, so nudge the clock past
    // RECONCILE_STALE_MS. A row touched a second ago is one a live poller is probably on.
    w.setNow(NOW + 10 * 60_000);

    // ---- the process that comes back up ---------------------------------------------
    const second = w.boot();
    assert.ok(second.installed.reconcile !== undefined, 'the module must declare a reconciler');
    await second.installed.reconcile?.();

    assert.equal(w.jobs.enqueued.length, 1, 'the orphan was re-adopted');
    const readopted = w.jobs.enqueued[0];
    assert.ok(readopted !== undefined);
    if (readopted === undefined) return;
    assert.equal(readopted.type, 'build');
    assert.equal(
      readopted.dedupeKey,
      buildDedupeKey(id, 0),
      'under the key RECOMPUTED FROM THE ROW - a hardcoded one would enqueue a second poller for a retried request and race itself on one card',
    );
    assert.equal(
      (readopted.payload as JsonObject)['requestId'],
      id,
      'and it points at the request that was actually stranded',
    );

    // ---- and the NEW process finishes the build -------------------------------------
    w.script.statuses = [{ kind: 'success', runUrl: httpsUrl(RUN_URL) }];
    w.script.pr = prRef(false);
    const out = await second.build.run(readopted.payload, runtime());
    assert.deepEqual(out, { kind: 'done' }, 'the poll continues in a process that never saw the click');

    assert.deepEqual(headings(lastEdit(w)), ['Pull request ready']);
    assert.equal(notifications(w).at(-1)?.mentionUserId, REQUESTER, 'and the requester is still told');
    assert.equal(stateOf(w, id), 'pr_open');
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 }, 'and the slot still comes back');
  } finally {
    w.close();
  }
});

test('the run FAILS: the card says so, the requester is pinged, and the slot is released', async () => {
  const w = world();
  fund(w);
  try {
    const boot = w.boot();
    await formOf(boot).handle(submission());
    const id = newestRequest(w);
    const payload = await deliver(w, await actionOf(boot, 'approve').handle(click(w, id, 'approve', APPROVER)));
    await boot.build.run(payload, runtime());

    w.script.statuses = [{ kind: 'failure', runUrl: httpsUrl(RUN_URL), detail: 'the agent step exited 1' }];
    const out = await boot.build.run(payload, runtime(2));

    assert.equal(out.kind, 'failed', 'a finished failure is an ANSWER, not a wait');
    const failed = out as unknown as { readonly error: AppError };
    assert.equal(
      failed.error.retryable,
      false,
      'and it must NOT be retryable: a retryable error here re-polled a dead run for four hours while the card said "Building"',
    );
    assert.equal(stateOf(w, id), 'failed', 'the row is terminal even though the JOB will still be dead-lettered');
    assert.deepEqual(
      w.repo.activeCounts(GUILD),
      { waiting: 0, running: 0, filing: 0 },
      'THE SLOT IS RELEASED ON FAILURE TOO - the leak that matters most is the one on the unhappy path',
    );

    // The runner now dead-letters it, which is the frame that draws the card and tells anybody.
    await boot.build.onDead?.(payload, failed.error, runtime(2));
    assert.deepEqual(headings(lastEdit(w)), ['Build failed']);
    assert.match(textOf(lastEdit(w)), /\/request retry/u, 'a failure is no longer a dead end');

    const told = notifications(w);
    assert.equal(told.length, 1, 'and the person who waited is POSTED to, not silently edited at');
    assert.equal(told[0]?.mentionUserId, REQUESTER);
    assert.match(textOf(told[0] ?? { accent: 'ok', nodes: [] }), /failed/u);
  } finally {
    w.close();
  }
});

test('the agent REFUSED on purpose: reported as a refusal, never as a crash', async () => {
  const w = world({ prGraceMs: 1_000 });
  fund(w);
  try {
    const boot = w.boot();
    await formOf(boot).handle(submission());
    const id = newestRequest(w);
    const payload = await deliver(w, await actionOf(boot, 'approve').handle(click(w, id, 'approve', APPROVER)));
    await boot.build.run(payload, runtime());

    // A run that SUCCEEDED and opened no pull request. That is what the prompt tells the agent
    // to do when a request asks it to read secrets, edit `.github`, or weaken authentication.
    // The agent's own report is what says "refused" - a clean run with no PR is not enough.
    w.script.statuses = [{ kind: 'success', runUrl: httpsUrl(RUN_URL) }];
    w.script.pr = null;
    w.builds.report = {
      failedStep: null,
      stop: 'success',
      turns: 5,
      agent: { status: 'refused', summary: 'Made no changes.', remaining: 'The request asked me to edit .github.' },
    };

    const out = await boot.build.run(payload, runtime(2));
    assert.deepEqual(out, { kind: 'done' }, 'a deliberate refusal is a completed job, not a failed one');

    const card = lastEdit(w);
    assert.deepEqual(headings(card), ['Refused - nothing changed']);
    assert.match(textOf(card), /edit \.github/u, 'with the agent\'s reason on the card');
    assert.match(
      textOf(card),
      /will be refused again/u,
      'THE DISTINCTION THAT MATTERS: "it broke" invites a retry, "it refused" makes one the wrong move',
    );

    assert.equal(stateOf(w, id), 'done', 'terminal as `done`, NOT `failed` - the run did what it was asked to');
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 });

    const told = notifications(w);
    assert.equal(told[0]?.mentionUserId, REQUESTER, 'and a refusal is still an ending somebody is waiting for');
    assert.ok(auditActions(w).includes('builder.refused'), 'and it is distinguishable in the audit trail');
  } finally {
    w.close();
  }
});

test('nobody approves for 48 hours: the sweep expires it, closes the issue, and frees the slot', async () => {
  const w = world();
  fund(w);
  try {
    const boot = w.boot();
    await formOf(boot).handle(submission());
    const id = newestRequest(w);
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 1, running: 0, filing: 0 }, 'the unclicked request holds a slot');

    // THE BUG THIS SWEEP EXISTS FOR: before it, `expired` was declared in the state union, in
    // the SQL CHECK and in the terminal list, and written by NOTHING. Two unclicked requests
    // exhausted a guild's default concurrency of 2 permanently.
    const stillWaiting = await boot.expire.run({}, runtime());
    assert.deepEqual(stillWaiting, { kind: 'done' });
    assert.equal(stateOf(w, id), 'awaiting_approval', 'a request inside its TTL is left alone');

    w.setNow(NOW + 49 * HOUR);
    const swept = await boot.expire.run({}, runtime());
    assert.deepEqual(swept, { kind: 'done' });

    assert.equal(stateOf(w, id), 'expired', 'past the TTL it lets go on its own');
    assert.deepEqual(w.issues.closed, [1], 'and the GitHub issue is closed, not left open forever');
    assert.deepEqual(
      w.repo.activeCounts(GUILD),
      { waiting: 0, running: 0, filing: 0 },
      'THE SLOT IS BACK. This is the assertion that stops a guild bricking itself.',
    );

    const card = lastEdit(w);
    assert.deepEqual(headings(card), ['Expired - nobody approved this']);
    assert.match(textOf(card), /48 hours/u, 'and it says how long it waited');
    assert.match(textOf(card), /\/request retry/u, 'and points at the way back, not at retyping it');

    // Expiry is the ending NOBODY CHOSE, so it is the one nobody would ever go back and look
    // for - which makes the posted notice matter more here than anywhere else.
    const told = notifications(w);
    assert.equal(told.length, 1);
    assert.equal(told[0]?.mentionUserId, REQUESTER);
    assert.match(textOf(told[0] ?? { accent: 'ok', nodes: [] }), /expired/u);

    // And the guild can file again.
    const again = await formOf(boot).handle(submission({ title: 'Second try', detail: 'Now that a slot is free.' }));
    assert.equal(again.kind, 'view');
  } finally {
    w.close();
  }
});

// =======================================================================================
// The two commands the lifecycle is only useful WITH
// =======================================================================================

test('/request list shows the finished request with its outcome, so the history is real', async () => {
  const w = world();
  fund(w);
  try {
    const boot = w.boot();
    await formOf(boot).handle(submission());
    const id = newestRequest(w);
    const payload = await deliver(w, await actionOf(boot, 'approve').handle(click(w, id, 'approve', APPROVER)));
    await boot.build.run(payload, runtime());
    w.script.statuses = [{ kind: 'success', runUrl: httpsUrl(RUN_URL) }];
    w.script.pr = prRef(false);
    await boot.build.run(payload, runtime(2));

    const out = await commandOf(boot, 'request list').handle(invocation());
    assert.equal(out.kind, 'view');
    const view = (out as unknown as { readonly view: View }).view;
    const said = textOf(view);
    assert.match(said, /Dark mode for the dashboard/u, 'the TITLE, because a list of issue numbers is not actionable');
    assert.match(said, /pull\/7/u, 'and the PR - the OUTCOME, not just the input');
    assert.equal(view.ephemeral, true, 'privately: somebody else’s request history is not channel content');
  } finally {
    w.close();
  }
});

test('/request cancel on a live build stops the bot, STOPS THE RUN, and frees the slot', async () => {
  const w = world();
  fund(w);
  try {
    const boot = w.boot();
    await formOf(boot).handle(submission());
    const id = newestRequest(w);
    const payload = await deliver(w, await actionOf(boot, 'approve').handle(click(w, id, 'approve', APPROVER)));
    await boot.build.run(payload, runtime());
    assert.equal(stateOf(w, id), 'running');

    const out = await commandOf(boot, 'request cancel').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view', 'a requester may withdraw their own request');
    assert.equal(stateOf(w, id), 'cancelled');
    assert.deepEqual(w.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 }, 'and the slot comes back immediately');

    // THE MONEY, ACTUALLY STOPPED. Until this round `/request cancel` freed the slot, stopped
    // the poller and left the Actions run going - spending the REQUESTER'S OWN Anthropic
    // credentials for another twenty minutes on a result nobody would ever open. The card was
    // honest about it, which made it an honest description of the wrong behaviour.
    assert.deepEqual(w.cancelledRuns, [runIdOf(w, id)], 'the run the row is actually tracking');

    const receipt = (out as unknown as { readonly view: View }).view;
    assert.match(
      textOf(receipt),
      /GitHub is stopping the run/u,
      'and it still does not overpromise: a cancel is a request to GitHub, and a step already running finishes',
    );

    // THE MONEY GUARD. A cancelled row must never walk into the dispatch branch on a later
    // attempt - `jobs.cancel` cannot reach an attempt the runner has already leased.
    const spentBefore = w.builds.dispatched.length;
    const after = await boot.build.run(payload, runtime(2));
    assert.deepEqual(after, { kind: 'done' }, 'the job stops, and reports `done` rather than drawing over the card');
    assert.equal(w.builds.dispatched.length, spentBefore, 'AND NOTHING MORE WAS SPENT');
  } finally {
    w.close();
  }
});
