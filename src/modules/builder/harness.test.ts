/**
 * THE SHARED RIG for the builder's durable paths, plus the assertions that prove the rig itself
 * is wired to the real thing.
 *
 * WHY A REAL DATABASE AND NOT `fakeDb`: every behaviour under test here is a STATE MACHINE
 * question - does an unclicked request release its slot, does a dispatch attempt actually get
 * counted, does the poller stop calling a finished run. `fakeDb.queryOne` returns `undefined`
 * and `fakeDb.execute` reports one row changed no matter what was asked, so a test built on it
 * would assert against the fake's opinions rather than against SQLite's. That is exactly how the
 * `SELECT *` defect survived 255 green tests.
 *
 * WHY THE MODULE IS REALLY INSTALLED: the jobs under test are reached through `ErasedJob`, which
 * is what the runner actually calls, with the capability tuple already discharged. Calling a
 * hand-built closure instead would prove nothing about the manifest - including the one line
 * that makes the expiry sweep run at all, `schedule: { everyMs }`.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import builder, { buildRepo, APPROVAL_SWEEP_EVERY_MS, type BuildRepo } from '#modules/builder/module';
import type { ErasedJob, InstalledModule, JobRuntime } from '#core/module';
import { createEventBus } from '#core/events';
import { Ok, type Result } from '#core/result';
import type { AppError } from '#core/errors';
import type { JsonObject } from '#core/json';
import { openSqlite } from '#adapters/sqlite/db';
import { newApprovalId, newCardNonce, newFenceNonce, newRequestId, type RequestId } from '#core/ids';
import type { BuildsPort, IssuesPort, PrRef, RunStatus } from '#core/ports';
import type { CancelsRuns, ReopensIssues } from '#modules/builder/module';
import type { SurfaceRef, View, ViewNode } from '#core/view';
import { parseHttpsUrl, renderSafeMarkdown, toEnum, userTextForTest } from '#core/text';
import { toChannelId, toGuildId, toUserId, type ChannelId, type GuildId, type UserId } from '#core/ids';
import type { Args, FormValues } from '#core/args';
import type { FormHandlerSpec, FormSubmission, Invocation, ProgressHandle } from '#core/module';
import { Err } from '#core/result';
import { errors } from '#core/errors';
import { fakeAccess, fakeAudit, fakeBuilds, fakeClock, fakeDiscord, fakeIssues, fakeJobs, fakeLogger, type FakeAudit, type FakeBuilds, type FakeDiscord, type FakeIssues, type FakeJobs } from '#testing/fakes';
import type { AccessPort } from '#core/ports';
import type { CommandSpec } from '#core/module';

export const NOW = 1_700_000_000_000;
export const HOUR = 3_600_000;
export const GUILD = '222222222222222222';
export const REQUESTER = '111111111111111111';
export const CHANNEL = '333333333333333333';
export const ISSUE_URL = 'https://github.com/o/r/issues/42';
export const RUN_URL = 'https://github.com/o/r/actions/runs/9';
export const PR_URL = 'https://github.com/o/r/pull/7';
export const SURFACE = { guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' };

const MIGRATIONS_DIR = 'src/modules/builder/migrations';

/** Overrides for the pieces of `BuildsPort` a given scenario cares about. */
export interface BuildsOverrides {
  dispatch?: BuildsPort['dispatch'];
  findRunByName?: BuildsPort['findRunByName'];
  runStatus?: BuildsPort['runStatus'];
  findPrForBranch?: BuildsPort['findPrForBranch'];
  runsSince?: BuildsPort['runsSince'];
  /**
   * ON `BuildsPort` NOW, and supplied by `fakeBuilds()` by default.
   *
   * These were optional companions while `#core/ports` was still being written, and the default
   * harness deliberately left them ABSENT so untouched tests exercised the degraded wording that
   * shipped in the meantime. The port landed, so the fake answers them for real - seed
   * `h.builds.finishedRuns` for the 409 arm and `h.builds.variables` for the cap - and an
   * override here is now only for forcing a FAILURE that the fake has no seam for.
   */
  cancelRun?: BuildsPort['cancelRun'];
  /** Only needed to force a FAILURE; seed `h.builds.variables` for every ordinary value. */
  repositoryVariable?: BuildsPort['repositoryVariable'];
  /**
   * The containment gate (RFC-001 5.4). `fakeBuilds()` answers from `h.builds.gateAnswer`; pass
   * the REAL adapter's pair here to drive the gate-file check end to end (`containment.test.ts`).
   */
  verifyGates?: BuildsPort['verifyGates'];
  readiness?: BuildsPort['readiness'];
}

/** Overrides for `IssuesPort`. `reopen` is on the port now and `fakeIssues()` implements it. */
export interface IssuesOverrides {
  create?: IssuesPort['create'];
  close?: IssuesPort['close'];
  /** Only needed to force a failure; the fake reopens for real and records it in `reopened`. */
  reopen?: IssuesPort['reopen'];
}

export interface Harness {
  readonly installed: InstalledModule;
  readonly repo: BuildRepo;
  readonly build: ErasedJob;
  readonly expire: ErasedJob;
  readonly discord: FakeDiscord;
  readonly issues: FakeIssues;
  readonly audit: FakeAudit;
  readonly jobs: FakeJobs;
  /** The real `fakeBuilds`, so a test can seed `runsToday` for the daily-cap path. */
  readonly builds: FakeBuilds;
  readonly dispatched: readonly Readonly<Record<string, unknown>>[];
  /** Every `builder.pr_opened` this module published, so a subscriber's view can be asserted. */
  readonly prOpened: readonly { readonly requestId: string; readonly prUrl: string }[];
  setNow(ms: number): void;
  /**
   * Make every `discord.post` fail until it is cleared.
   *
   * WHY IT EXISTS: "the card could not be posted" is a real branch with real consequences - the
   * request has nowhere to deliver its outcome, so the slot has to come back and the issue that
   * was just filed has to be closed. `fakeDiscord` always succeeds, so without this the branch is
   * unreachable and its cleanup is untested.
   */
  failPosts(error: AppError | null): void;
  /**
   * WHETHER THE CALLER IS AN APPROVER, which `fakeAccess` cannot express - it says yes to
   * everything. `/request cancel` and `/request list all` both hinge on the answer, and a fake
   * that only ever allows would make the refusal branch unreachable in every test.
   */
  setApprover(allowed: boolean): void;
  close(): void;
}

function job(installed: InstalledModule, type: string): ErasedJob {
  const found = installed.jobs.find((j) => j.type === type);
  assert.ok(found !== undefined, `the builder must declare a "${type}" job`);
  if (found === undefined) throw new Error('unreachable');
  return found;
}

/** The real module, really installed, over a real SQLite file with the real migrations. */
export function harness(
  rawConfig: unknown = {},
  overrides: BuildsOverrides = {},
  issuesOverrides: IssuesOverrides = {},
): Harness {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok, 'the in-memory database must open');
  if (!opened.ok) throw new Error('unreachable');
  const db = opened.value;

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort((a, b) => a.localeCompare(b))) {
    db.connection.exec(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
  }

  const clock = fakeClock(NOW);
  const discordBase = fakeDiscord();
  let postFailure: AppError | null = null;
  // The arrays are shared by reference through the spread, so `h.discord.posted` still records
  // everything the module really posted.
  const discord: FakeDiscord = {
    ...discordBase,
    async post(channelId, view) {
      return postFailure === null ? discordBase.post(channelId, view) : Err(postFailure);
    },
  };
  const issueBase = fakeIssues();
  const issues: FakeIssues & ReopensIssues = { ...issueBase, ...issuesOverrides };
  const audit = fakeAudit();
  const base = fakeBuilds();
  // Bring-your-own-credentials, satisfied. Every path below is about outcomes, not funding, and
  // `payer.test.ts`/`gate.test.ts` already own the funding decision.
  base.environments.set(`user-${REQUESTER}`, ['ANTHROPIC_API_KEY']);
  const builds: BuildsPort & CancelsRuns = { ...base, ...overrides };

  let approver = true;
  const access: AccessPort = {
    ...fakeAccess(),
    check: () => (approver ? { allowed: true, layer: 'L1-allowlist' } : { allowed: false, layer: 'L3-deny', grantableBy: 'an admin' }),
  };
  const jobs = fakeJobs();

  const prOpened: { requestId: string; prUrl: string }[] = [];
  const bus = createEventBus(() => undefined);
  bus.on('builder.pr_opened', (e) => void prOpened.push({ requestId: e.requestId, prUrl: e.prUrl }));

  const r = builder.install({
    ports: { db: db.moduleDb('builder'), audit, clock, jobs, discord, issues, builds, access },
    rawConfig,
    bus,
    logger: fakeLogger(),
  });
  assert.ok(r.ok, 'the builder must install');
  if (!r.ok) throw new Error('unreachable');

  return {
    installed: r.value,
    repo: buildRepo(db.moduleDb('builder')),
    build: job(r.value, 'build'),
    expire: job(r.value, 'expire'),
    discord,
    issues,
    audit,
    jobs,
    builds: base,
    dispatched: base.dispatched,
    prOpened,
    setNow: (ms) => clock.set(ms),
    failPosts: (error) => {
      postFailure = error;
    },
    setApprover: (allowed) => {
      approver = allowed;
    },
    close: () => db.close(),
  };
}

/** What the job runner supplies per attempt. */
export function runtime(attempt = 1, deadlineAtMs = NOW + 6 * HOUR): JobRuntime {
  return {
    attempt,
    deadlineAtMs,
    signal: new AbortController().signal,
    heartbeat: (): void => undefined,
    sleep: async (): Promise<void> => undefined,
  };
}

/**
 * A cap high enough that CLAIMING the slot is never what a fixture is testing.
 *
 * WHY A FIXTURE HAS TO PASS ONE AT ALL: there is no unguarded insert any more. `claimSlot` is
 * the only way a row enters this table, and the cap is an argument to it - so a test that wants
 * to seed five rows says so, and a test that wants the cap to bite passes the real number.
 */
export const SEED_SLOTS = 1_000;

/**
 * A SUBMISSION MID-FLIGHT: the slot is claimed and no issue has been filed.
 *
 * WHY IT IS A FIXTURE AND NOT A CURIOSITY: `draft` is a real state that occupies a real slot,
 * and it is the state a crashed submission leaves behind. Two sweeps exist to reclaim it, and
 * neither can be tested without being able to produce one.
 */
export function seedDraft(repo: BuildRepo, at = NOW, guildId = GUILD, maxConcurrent = SEED_SLOTS): RequestId | null {
  const id = newRequestId(at);
  return repo.claimSlot(
    {
      id,
      state: 'draft',
      version: 1,
      guildId,
      requesterId: REQUESTER,
      nonce: newCardNonce(),
      fenceNonce: newFenceNonce(),
      title: 'Add a /ping command',
      issueNumber: null,
      issueUrl: null,
      runId: null,
      runUrl: null,
      dispatchAttempts: 0,
      succeededAt: null,
      surfaceJson: null,
    },
    at,
    maxConcurrent,
  )
    ? id
    : null;
}

/** A request that has been filed and posted, i.e. one waiting for an approver. */
export function seedAwaiting(repo: BuildRepo, issueNumber: number, at = NOW, guildId = GUILD): RequestId {
  const id = newRequestId(at);
  const claimed = repo.claimSlot(
    {
      id,
      state: 'draft',
      version: 1,
      guildId,
      requesterId: REQUESTER,
      nonce: newCardNonce(),
      fenceNonce: newFenceNonce(),
      title: 'Add a /ping command',
      issueNumber: null,
      issueUrl: null,
      runId: null,
      runUrl: null,
      dispatchAttempts: 0,
      succeededAt: null,
      surfaceJson: null,
    },
    at,
    SEED_SLOTS,
  );
  assert.ok(claimed, 'fixture: the seeded request must claim a slot');
  repo.recordIssue(id, issueNumber, ISSUE_URL, SURFACE, at);
  return id;
}

/**
 * ...and then approved, so the build job's poll path is the one under test.
 *
 * APPROVED THE WAY THE APPROVE CLICK APPROVES: with an approval id written in the CAS. A row in
 * `dispatching` with no id is the one legacy shape the dispatch pass refuses, so a fixture that
 * omitted it would be testing the refusal rather than the build.
 */
export function seedRunning(repo: BuildRepo, issueNumber: number, runId: number, at = NOW): RequestId {
  const id = seedAwaiting(repo, issueNumber, at);
  repo.compareAndSet(id, repo.get(id)?.version ?? 0, 'dispatching', at, { approvalId: newApprovalId() });
  repo.recordRun(id, runId, RUN_URL, at);
  return id;
}

/** ...or approved and not yet dispatched, which is where the attempt counter lives. */
export function seedDispatching(repo: BuildRepo, issueNumber: number): RequestId {
  const id = seedAwaiting(repo, issueNumber);
  repo.compareAndSet(id, repo.get(id)?.version ?? 0, 'dispatching', NOW, { approvalId: newApprovalId() });
  return id;
}

export function payloadFor(id: RequestId, issueNumber: number): JsonObject {
  return { requestId: id, issueNumber, surface: SURFACE };
}

/** Every heading on a card, so an assertion names the ENDING rather than a node index. */
export function headings(view: View): readonly string[] {
  return view.nodes.filter((n): n is Extract<ViewNode, { kind: 'heading' }> => n.kind === 'heading').map((n) => n.text);
}

/** Every link label/url pair on a card. */
export function links(view: View): readonly { readonly label: string; readonly url: string }[] {
  return view.nodes
    .filter((n): n is Extract<ViewNode, { kind: 'buttons' }> => n.kind === 'buttons')
    .flatMap((n) => n.links.map((l) => ({ label: l.label, url: String(l.url) })));
}

/** Field NAMES. A list row states its state there, and `textOf` only reads field VALUES. */
export function fieldNames(view: View): readonly string[] {
  return view.nodes
    .filter((n): n is Extract<ViewNode, { kind: 'field' }> => n.kind === 'field')
    .map((n) => n.name);
}

/** Every rendered text/field body, joined - for asserting on what a card SAYS. */
export function textOf(view: View): string {
  return view.nodes
    .map((n) => (n.kind === 'text' || n.kind === 'field' ? renderSafeMarkdown(n.md) : ''))
    .join(' ');
}

/** The last card the bot drew. */
export function lastEdit(h: Harness): View {
  const last = h.discord.drawn.at(-1);
  assert.ok(last !== undefined, 'the bot must have drawn the card');
  if (last === undefined) throw new Error('unreachable');
  return last;
}

/** One declared command, by its full name. `/request new` and its three siblings live here. */
export function commandOf(h: Harness, name: string): CommandSpec {
  const found = h.installed.commands.find((c) => c.name === name);
  assert.ok(found !== undefined, `the builder must declare a "${name}" command`);
  if (found === undefined) throw new Error('unreachable');
  return found;
}

// ---------------------------------------------------------------------------------------
// Calling a command or a form the way the router does
// ---------------------------------------------------------------------------------------

export function userId(raw: string): UserId {
  const r = toUserId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a user id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
export function guildId(raw: string): GuildId {
  const r = toGuildId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a guild id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
export function channelId(raw: string): ChannelId {
  const r = toChannelId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a channel id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

/**
 * The one cast in this rig, and it is structural rather than lazy: `ProgressHandle` carries a
 * module-private symbol so that a live interaction token cannot be smuggled into a durable job
 * payload. A test therefore cannot build one by writing the fields, and the router does exactly
 * this same cast for exactly this reason. Nothing on the paths below reads it.
 */
export function progress(): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => SURFACE,
  };
  return stub as unknown as ProgressHandle;
}

/**
 * The option bag a command handler reads.
 *
 * WHY every textual accessor yields `UserText` rather than a string: so does the real one, and
 * that is the whole point of `#core/args` - a handler that wants characters has to name a
 * sanitiser. A fake handing back plain strings would let a test pass against code that could not
 * compile in production.
 */
export function argsOf(raw: Readonly<Record<string, string | boolean>> = {}): Args {
  const cannot = (name: string) => Err(errors.validation(name, 'not modelled by this fixture', 'Use text or bool.'));
  return {
    names: Object.keys(raw),
    text(name) {
      const v = raw[name];
      return typeof v === 'string' ? userTextForTest(v) : undefined;
    },
    textRequired(name) {
      const v = raw[name];
      if (typeof v !== 'string') throw new Error(`no option "${name}" was supplied`);
      return userTextForTest(v);
    },
    integer: (name) => cannot(name),
    bool(name) {
      const v = raw[name];
      return typeof v === 'boolean' ? v : undefined;
    },
    user: () => undefined,
    role: () => undefined,
    channel: () => undefined,
    choice: (name) => cannot(name),
  };
}

export function invocation(
  opts: {
    readonly actorId?: string;
    readonly at?: number;
    readonly args?: Readonly<Record<string, string | boolean>>;
  } = {},
): Invocation {
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
    progress: progress(),
    at,
  };
}

function formValues(fields: Readonly<Record<string, string>>): FormValues {
  return {
    names: Object.keys(fields),
    text(name) {
      const raw = fields[name];
      return raw === undefined ? undefined : userTextForTest(raw);
    },
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

/** A modal submission, as the router builds one. */
export function submission(
  fields: Readonly<Record<string, string>> = { title: 'Add a /ping command', detail: 'It should reply pong.' },
  actorId = REQUESTER,
): FormSubmission {
  return {
    id: newRequestId(NOW),
    actor: { userId: userId(actorId), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action: 'request', entityId: newRequestId(NOW), nonce: newCardNonce() },
    fields: formValues(fields),
    progress: progress(),
    at: NOW,
  };
}

export function requestForm(h: Harness): FormHandlerSpec {
  const form = h.installed.forms.find((f) => f.name === 'request');
  assert.ok(form !== undefined, 'the builder must expose a "request" form handler');
  if (form === undefined) throw new Error('unreachable');
  return form;
}

/** The last card the bot POSTED (as opposed to edited). */
export function lastPost(h: Harness): View {
  const last = h.discord.posted.at(-1);
  assert.ok(last !== undefined, 'the bot must have posted a card');
  if (last === undefined) throw new Error('unreachable');
  return last.view;
}

export function url(raw: string) {
  const parsed = parseHttpsUrl(raw);
  assert.ok(parsed.ok, `${raw} must be an https url`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

/**
 * A pull request as `findPrForBranch` reports one.
 *
 * `PrRef` NOW DECLARES `isDraft`: the widening this module asked for was granted during
 * integration, so `readPrDraft` returns a real boolean in production and `draftPrCard` is
 * reachable for the first time.
 *
 * WHY THE `null` CASE SURVIVES ANYWAY: `readPrDraft` is a TOLERANT read, and its fallback
 * branch is what runs if a fixture, a replayed row, or some future adapter ever hands back an
 * object without the field. `null` here builds exactly that object — the property absent at
 * RUNTIME, which no type can express — so the branch stays covered instead of rotting into
 * untested code that first executes the day something upstream regresses.
 */
export function prRef(isDraft: boolean | null): PrRef {
  const full: PrRef = { number: 7, url: url(PR_URL), branch: 'agent/req-x', isDraft: isDraft === true };
  if (isDraft !== null) return full;
  // Strip the field the way an adapter that predates the widening would never have set it. The
  // cast IS the point: it is the only way to produce the shape the tolerant branch defends.
  const { isDraft: _absent, ...older } = full;
  return older as PrRef;
}

export function okStatus(kind: 'queued' | 'in-progress' | 'success' | 'cancelled', runUrl: string | null): Promise<Result<RunStatus, AppError>> {
  return Promise.resolve(Ok({ kind, runUrl: runUrl === null ? null : url(runUrl) }));
}

// ---------------------------------------------------------------------------------------
// The rig is only worth anything if it is attached to the real manifest
// ---------------------------------------------------------------------------------------

test('the builder declares a SCHEDULED expiry job, which is what makes `expired` reachable', () => {
  // `JobSpec.schedule` was supported by the runner and used by nobody, so nothing in the bot ran
  // on a timer and `expired` - a state the union, the CHECK constraint and `finish` all knew
  // about - was written by no code path at all.
  const h = harness();
  try {
    assert.deepEqual(h.expire.schedule, { everyMs: APPROVAL_SWEEP_EVERY_MS }, 'an hourly sweep');
    assert.equal(APPROVAL_SWEEP_EVERY_MS, 3_600_000);
    assert.deepEqual(h.build.schedule, null, 'the build job is enqueued by an approval, never scheduled');
  } finally {
    h.close();
  }
});
