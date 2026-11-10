/**
 * Runtime proof for the reconciler.
 *
 * Every test here is a production incident this system is supposed to make impossible:
 * a retried build that hammered GitHub with no backoff, a poison payload that survived every
 * deploy, a double-clicked Approve that dispatched twice, and a build that "disappeared"
 * because the process restarted while it was running.
 *
 * They run against a REAL SQLite database (`testdb.ts`), because compare-and-set, a partial
 * UNIQUE index and "the row is still there after the restart" are database behaviours - a fake
 * that answers `changes: 1` to everything proves none of them.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { errors, type AppError } from '#core/errors';
import { Ok } from '#core/result';
import type { JsonObject } from '#core/json';
import type { JobId } from '#core/ids';
import { newJobId } from '#core/ids';
import type { DiscordPermission } from '#core/permissions';
import { missingPermissions } from '#core/permissions';
import { sql } from '#core/sql';
import type { Backoff, ClockPort, DbPort, LoggerPort } from '#core/ports';
import type { ErasedJob, JobRuntime } from '#core/module';
import type { JobOutcome } from '#core/command';
import { SURFACE_KEY } from '#core/command';
import { backoffDelayMs, createJobSystem, type JobSystem } from '#adapters/system/jobs';
import { createTestDb, type TestDb } from '#adapters/system/testdb';
import { manualClock, type ManualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';
import { intCol, textCol, type Row } from '#adapters/system/rows';

const HOUR = 3_600_000;
const BACKOFF: Backoff = { initialMs: 1_000, factor: 2, maxMs: 10_000, jitter: 0 };

interface JobStub {
  readonly moduleId?: string;
  readonly type?: string;
  readonly maxAttempts?: number;
  readonly deadlineMs?: number;
  readonly backoff?: Backoff;
  readonly needs?: readonly DiscordPermission[];
  readonly schedule?: { readonly everyMs: number } | null;
  run(payload: JsonObject, runtime: JobRuntime): Promise<JobOutcome>;
  onDead?(payload: JsonObject, last: AppError, runtime: JobRuntime): Promise<void>;
  onUnparseable?(payload: JsonObject, runtime: JobRuntime): Promise<void>;
}

function makeJob(stub: JobStub): ErasedJob {
  return {
    moduleId: stub.moduleId ?? 'builder',
    type: stub.type ?? 'poll',
    maxAttempts: stub.maxAttempts ?? 3,
    deadlineMs: stub.deadlineMs ?? HOUR,
    backoff: stub.backoff ?? BACKOFF,
    needs: stub.needs ?? [],
    schedule: stub.schedule ?? null,
    run: (payload, runtime) => stub.run(payload, runtime),
    onDead: (payload, last, runtime) => stub.onDead?.(payload, last, runtime) ?? Promise.resolve(),
    onUnparseable: (payload, runtime) => stub.onUnparseable?.(payload, runtime) ?? Promise.resolve(),
  };
}

/** A promise a test opens by hand, so "still running" is a state and not a sleep. */
function gate(): { readonly wait: Promise<void>; open(): void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, open: () => release() };
}

interface Harness {
  readonly db: TestDb;
  readonly clock: ManualClock;
  readonly logger: LoggerPort;
  readonly system: JobSystem;
}

function harness(jobs: readonly ErasedJob[], overrides: { readonly ownerId?: string; readonly db?: TestDb; readonly clock?: ManualClock } = {}): Harness {
  const db = overrides.db ?? createTestDb();
  const clock = overrides.clock ?? manualClock();
  const logger = silentLogger();
  const map = new Map<string, ErasedJob>(jobs.map((j) => [`${j.moduleId}:${j.type}`, j]));
  const system = createJobSystem({
    db,
    clock,
    logger,
    jobs: map,
    random: () => 0,
    ...(overrides.ownerId === undefined ? {} : { ownerId: overrides.ownerId }),
  });
  return { db, clock, logger, system };
}

function jobRow(db: DbPort, id: string): Row {
  const row = db.queryOne<Row>(sql`SELECT * FROM ${db.table('jobs')} WHERE id = ${id}`);
  assert.ok(row !== undefined, 'the job row must still exist');
  return row;
}

function enqueueOne(system: JobSystem, clock: ClockPort, opts: { readonly type?: string; readonly dedupeKey?: string | null; readonly deadlineMs?: number; readonly payload?: JsonObject } = {}): JobId {
  const now = clock.now();
  const r = system.portFor('builder').enqueue({
    type: opts.type ?? 'poll',
    payload: opts.payload ?? {},
    runAfterMs: now,
    deadlineAtMs: now + (opts.deadlineMs ?? HOUR),
    dedupeKey: opts.dedupeKey === undefined ? 'req-1' : opts.dedupeKey,
  });
  assert.ok(r.ok, 'enqueue must succeed');
  return r.value.id;
}

// ---------------------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------------------

test('backoff grows exponentially and then stops growing at the cap', () => {
  const b: Backoff = { initialMs: 1_000, factor: 3, maxMs: 20_000, jitter: 0 };
  const delays = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(b, n, () => 0));
  assert.deepEqual(delays, [1_000, 3_000, 9_000, 20_000, 20_000, 20_000]);
  // A huge attempt count overflows `Math.pow` to Infinity; the cap is what makes that safe.
  assert.equal(backoffDelayMs(b, 5_000, () => 0), 20_000);
});

test('jitter is added on top of the delay, never subtracted from it', () => {
  const b: Backoff = { initialMs: 1_000, factor: 2, maxMs: 10_000, jitter: 0.5 };
  assert.equal(backoffDelayMs(b, 1, () => 0), 1_000, 'no jitter at random()=0');
  assert.equal(backoffDelayMs(b, 1, () => 1), 1_500, 'full jitter at random()=1');
  // The point: N restarted pollers spread out, but none of them retries SOONER than initialMs.
  for (const r of [0, 0.25, 0.5, 0.75, 1]) assert.ok(backoffDelayMs(b, 1, () => r) >= 1_000);
});

// ---------------------------------------------------------------------------------------
// Attempts, backoff and the dead-letter path
// ---------------------------------------------------------------------------------------

test('a failing job backs off between attempts, stops at maxAttempts, and dead-letters once', async () => {
  const seen: number[] = [];
  const dead: AppError[] = [];
  const j = makeJob({
    maxAttempts: 3,
    run: async (_p, rt) => {
      seen.push(rt.attempt);
      return { kind: 'failed', error: errors.upstream('github', 500, 'Try again shortly.') };
    },
    onDead: async (_p, last) => {
      dead.push(last);
    },
  });
  const { db, clock, system } = harness([j]);
  const id = enqueueOne(system, clock);

  await system.tick();
  await system.drain();
  assert.deepEqual(seen, [1]);
  assert.equal(textCol(jobRow(db, id), 'state'), 'queued');
  assert.equal(intCol(jobRow(db, id), 'run_after_ms'), clock.now() + 1_000, 'first backoff is initialMs');

  // Not due yet: the whole point of a backoff is that the next tick does nothing.
  await system.tick();
  await system.drain();
  assert.deepEqual(seen, [1]);

  clock.advance(1_000);
  await system.tick();
  await system.drain();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(intCol(jobRow(db, id), 'run_after_ms'), clock.now() + 2_000, 'second backoff is initialMs * factor');

  clock.advance(2_000);
  await system.tick();
  await system.drain();
  assert.deepEqual(seen, [1, 2, 3], 'exactly maxAttempts attempts, never a fourth');
  assert.equal(dead.length, 1, 'onDead runs exactly once');
  assert.equal(dead[0]?.kind, 'upstream', 'onDead receives the LAST error, not a generic one');
  assert.equal(textCol(jobRow(db, id), 'state'), 'dead');

  clock.advance(HOUR);
  const report = await system.tick();
  assert.equal(report.claimed, 0, 'a dead job is never claimed again');
  assert.deepEqual(seen, [1, 2, 3]);
});

test('a non-retryable failure dead-letters immediately instead of burning attempts on a 403', async () => {
  const seen: number[] = [];
  let deadCount = 0;
  const j = makeJob({
    maxAttempts: 5,
    run: async (_p, rt) => {
      seen.push(rt.attempt);
      // 401/403 are never retried anywhere in this repo: hammering them risks a Cloudflare ban.
      return { kind: 'failed', error: errors.upstream('github', 403, 'Ask an admin to fix the token scope.') };
    },
    onDead: async () => {
      deadCount += 1;
    },
  });
  const { db, clock, system } = harness([j]);
  const id = enqueueOne(system, clock);
  await system.tick();
  await system.drain();
  assert.deepEqual(seen, [1]);
  assert.equal(deadCount, 1);
  assert.equal(textCol(jobRow(db, id), 'state'), 'dead');
});

test('retry does NOT consume an attempt, so a 30-minute build cannot exhaust maxAttempts', async () => {
  const attemptsSeen: number[] = [];
  let calls = 0;
  const j = makeJob({
    // Deliberately SMALLER than the number of polls: a poll is not a failure.
    maxAttempts: 2,
    run: async (_p, rt) => {
      calls += 1;
      attemptsSeen.push(rt.attempt);
      return calls < 5 ? { kind: 'retry', afterMs: 15_000, why: 'workflow still running' } : { kind: 'done' };
    },
  });
  const { db, clock, system } = harness([j]);
  const id = enqueueOne(system, clock);

  for (let i = 0; i < 5; i += 1) {
    await system.tick();
    await system.drain();
    clock.advance(15_000);
  }

  assert.equal(calls, 5, 'the poller ran five times');
  assert.deepEqual(attemptsSeen, [1, 1, 1, 1, 1], 'every poll was still attempt 1');
  assert.equal(textCol(jobRow(db, id), 'state'), 'done');
  assert.equal(intCol(jobRow(db, id), 'attempts'), 1);
});

test('a poller cannot outlive its deadline by retrying', async () => {
  // WHY an array and not a `let`: a value assigned only inside a callback is narrowed to its
  // initialiser by control-flow analysis, and the assertion then reads as `never`.
  const dead: AppError[] = [];
  const j = makeJob({
    run: async () => ({ kind: 'retry', afterMs: 60_000, why: 'still building' }),
    onDead: async (_p, last) => {
      dead.push(last);
    },
  });
  const { db, clock, system } = harness([j]);
  const id = enqueueOne(system, clock, { deadlineMs: 30_000 });

  await system.tick();
  await system.drain();

  assert.equal(textCol(jobRow(db, id), 'state'), 'dead');
  assert.equal(dead.length, 1, 'the user is told, rather than the card saying "building..." forever');
  assert.equal(dead[0]?.kind, 'timeout');
});

// ---------------------------------------------------------------------------------------
// The double-click fence, and one job key at a time
// ---------------------------------------------------------------------------------------

test('a second enqueue of a live dedupe key returns the FIRST job id and created:false', async () => {
  const g = gate();
  let entered = 0;
  const j = makeJob({
    run: async () => {
      entered += 1;
      await g.wait;
      return { kind: 'done' };
    },
  });
  const { db, clock, system } = harness([j]);
  const port = system.portFor('builder');
  const first = enqueueOne(system, clock, { dedupeKey: 'request:01J' });

  // Queued, not yet running: the second Approve click lands here.
  const queuedDuplicate = port.enqueue({
    type: 'poll',
    payload: {},
    runAfterMs: clock.now(),
    deadlineAtMs: clock.now() + HOUR,
    dedupeKey: 'request:01J',
  });
  assert.ok(queuedDuplicate.ok);
  assert.equal(queuedDuplicate.value.created, false, 'a duplicate is a routine outcome, not an error');
  assert.equal(queuedDuplicate.value.id, first, 'and it names the job that already exists');
  assert.equal(port.findByDedupeKey('request:01J'), first);

  await system.tick();
  assert.equal(entered, 1, 'the handler has started');

  // Running, and clicked again.
  const runningDuplicate = port.enqueue({
    type: 'poll',
    payload: {},
    runAfterMs: clock.now(),
    deadlineAtMs: clock.now() + HOUR,
    dedupeKey: 'request:01J',
  });
  assert.ok(runningDuplicate.ok);
  assert.equal(runningDuplicate.value.created, false);
  assert.equal(runningDuplicate.value.id, first);

  await system.tick();
  assert.equal(entered, 1, 'no second instance of the same job key, ever');

  g.open();
  await system.drain();
  assert.equal(entered, 1);
  assert.equal(textCol(jobRow(db, first), 'state'), 'done');

  // Now that the key is free, the next request really does get its own job.
  const after = port.enqueue({
    type: 'poll',
    payload: {},
    runAfterMs: clock.now(),
    deadlineAtMs: clock.now() + HOUR,
    dedupeKey: 'request:01J',
  });
  assert.ok(after.ok);
  assert.equal(after.value.created, true);
  assert.notEqual(after.value.id, first);
});

test('an expired lease is never reclaimed from the process that is still running the job', async () => {
  const g = gate();
  let entered = 0;
  const j = makeJob({
    run: async () => {
      entered += 1;
      await g.wait;
      return { kind: 'done' };
    },
  });
  const { clock, system } = harness([j]);
  enqueueOne(system, clock);

  await system.tick();
  assert.equal(entered, 1);

  // Far past any lease. A naive reclaimer would hand this job to itself a second time.
  clock.advance(10 * 60_000);
  const report = await system.tick();
  assert.equal(report.reclaimed, 0, 'the in-flight attempt is excluded from the reclaimer');
  assert.equal(report.claimed, 0);
  assert.equal(entered, 1);

  g.open();
  await system.drain();
  assert.equal(entered, 1);
});

test('overlapping ticks do not double-start a job', async () => {
  const g = gate();
  let entered = 0;
  const j = makeJob({
    run: async () => {
      entered += 1;
      await g.wait;
      return { kind: 'done' };
    },
  });
  const { clock, system } = harness([j]);
  enqueueOne(system, clock);

  const [a, b] = await Promise.all([system.tick(), system.tick()]);
  assert.equal(entered, 1);
  assert.equal(a.claimed + b.claimed, 1, 'exactly one of the two ticks claimed the row');

  g.open();
  await system.drain();
});

// ---------------------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------------------

test('a job that was in flight when the process died is re-queued at boot and runs again', async () => {
  const g = gate();
  const attemptsSeen: number[] = [];
  const j = makeJob({
    maxAttempts: 5,
    run: async (_p, rt) => {
      attemptsSeen.push(rt.attempt);
      if (rt.attempt === 1) {
        await g.wait; // The "process" dies here.
        return { kind: 'done' };
      }
      return { kind: 'done' };
    },
  });

  const db = createTestDb();
  const clock = manualClock();
  const before = harness([j], { db, clock, ownerId: 'process-a' });
  const id = enqueueOne(before.system, clock);
  await before.system.tick();
  assert.deepEqual(attemptsSeen, [1], 'attempt 1 is in flight');
  assert.equal(textCol(jobRow(db, id), 'state'), 'running');
  assert.equal(textCol(jobRow(db, id), 'lease_owner'), 'process-a');

  // --- the process dies here. Nothing is drained, nothing is stopped, no lease is released.

  const after = harness([j], { db, clock, ownerId: 'process-b' });
  const report = after.system.recover();
  assert.equal(report.requeued, 1, 'the dead process left one attempt behind');
  assert.deepEqual(report.orphaned, []);
  assert.equal(textCol(jobRow(db, id), 'state'), 'queued');
  assert.equal(textCol(jobRow(db, id), 'lease_owner'), null);

  await after.system.tick();
  await after.system.drain();
  assert.deepEqual(attemptsSeen, [1, 2], 'the crash consumed an attempt - that is what bounds a poison job');
  assert.equal(textCol(jobRow(db, id), 'state'), 'done');

  // The zombie from the dead process finishes late. Its settle is a CAS on its own lease, so
  // it cannot resurrect or re-finish a row the new process now owns.
  g.open();
  await before.system.drain();
  assert.equal(textCol(jobRow(db, id), 'state'), 'done');
  assert.equal(intCol(jobRow(db, id), 'attempts'), 2);
});

test('a payload that survives more attempts than it may is dead-lettered rather than re-queued forever', async () => {
  // Simulates the poison case directly: the row comes back from a crash with its attempts
  // already spent, exactly as `recover()` would leave it.
  const j = makeJob({ maxAttempts: 2, run: async () => ({ kind: 'done' }) });
  const { db, clock, system } = harness([j]);
  const id = newJobId(clock.now());
  db.execute(
    sql`INSERT INTO ${db.table('jobs')} (id, module_id, type, payload, run_after_ms, deadline_at_ms, dedupe_key, state, attempts, last_error, lease_owner, lease_until_ms, created_at_ms, updated_at_ms)
        VALUES (${id}, 'builder', 'poll', '{}', ${clock.now()}, ${clock.now() + HOUR}, NULL, 'queued', 2, 'crashed', NULL, NULL, ${clock.now()}, ${clock.now()})`,
  );
  await system.tick();
  await system.drain();
  assert.equal(textCol(jobRow(db, id), 'state'), 'dead');
});

test('a payload this version cannot read goes to onUnparseable and is never retried', async () => {
  let unparseable = 0;
  let ran = 0;
  const j = makeJob({
    run: async () => {
      ran += 1;
      return { kind: 'done' };
    },
    onUnparseable: async () => {
      unparseable += 1;
    },
  });
  const { db, clock, system } = harness([j]);
  const id = newJobId(clock.now());
  db.execute(
    sql`INSERT INTO ${db.table('jobs')} (id, module_id, type, payload, run_after_ms, deadline_at_ms, dedupe_key, state, attempts, last_error, lease_owner, lease_until_ms, created_at_ms, updated_at_ms)
        VALUES (${id}, 'builder', 'poll', 'this is not json', ${clock.now()}, ${clock.now() + HOUR}, NULL, 'queued', 0, NULL, NULL, NULL, ${clock.now()}, ${clock.now()})`,
  );

  await system.tick();
  await system.drain();
  assert.equal(unparseable, 1);
  assert.equal(ran, 0, 'the handler never sees a payload it cannot read');
  assert.equal(textCol(jobRow(db, id), 'state'), 'dead');

  clock.advance(HOUR / 2);
  await system.tick();
  await system.drain();
  assert.equal(unparseable, 1, 'reported once, not once per attempt');
});

test('a job type with no handler after a rename is reported and parked, not silently stuck', async () => {
  const j = makeJob({ run: async () => ({ kind: 'done' }) });
  const { db, clock, system } = harness([j]);
  const id = enqueueOne(system, clock);

  // The deploy that dropped the module.
  system.registerJobs(new Map());
  const report = system.recover();
  assert.deepEqual(report.orphaned, ['builder:poll']);

  await system.tick();
  await system.drain();
  assert.equal(textCol(jobRow(db, id), 'state'), 'orphaned');
  assert.equal(system.stats().orphaned, 1);
});

// ---------------------------------------------------------------------------------------
// "IS ANYTHING STUCK?" - the question `/admin jobs` exists to answer, and could not.
//
// `stats()` was counts only. "1 running" is the same sentence for a build that started four
// seconds ago and a build wedged since Tuesday, so an operator who read the card learned
// nothing. These pin the one field that separates those two, and the trap that made the
// obvious implementation wrong.
// ---------------------------------------------------------------------------------------

test('stats reports the oldest RUNNING job, with the time its attempt actually started', async () => {
  const held = gate();
  const j = makeJob({
    run: async () => {
      await held.wait;
      return { kind: 'done' };
    },
  });
  const { clock, system } = harness([j]);

  assert.equal(system.stats().oldestRunning, null, 'nothing running, nothing to report');

  const startedAt = clock.now();
  enqueueOne(system, clock);
  await system.tick();

  const running = system.stats().oldestRunning;
  assert.deepEqual(running, { moduleId: 'builder', type: 'poll', startedAtMs: startedAt, ageMs: 0 });

  // AND THE TRAP. Twenty minutes later the runner has renewed this job's lease on every tick -
  // which rewrites `updated_at_ms`. An implementation that read that column would report a job
  // that started twenty minutes ago as having started just now: reassuring, and false.
  clock.advance(20 * 60_000);
  await system.tick();
  assert.equal(system.stats().oldestRunning?.startedAtMs, startedAt, 'a lease renewal is not a restart');
  // AND THE AGE IS COMPUTED HERE, by the layer that owns a clock. `admin`'s `health()` is
  // called with no time and declares no `clock` capability, so if this arrived as an instant
  // alone `/status` could never say `degraded` about a wedged job - which is the entire reason
  // the column exists.
  assert.equal(system.stats().oldestRunning?.ageMs, 20 * 60_000, 'twenty minutes of running, reported as twenty minutes');

  held.open();
  await system.drain();
  assert.equal(system.stats().oldestRunning, null, 'and it is gone once the job finishes');
});

test('the OLDEST wins, which is the only sample that can be alarming', async () => {
  const held = gate();
  const run = async (): Promise<JobOutcome> => {
    await held.wait;
    return { kind: 'done' };
  };
  const { clock, system } = harness([makeJob({ type: 'poll', run }), makeJob({ type: 'expire', run })]);

  const firstAt = clock.now();
  enqueueOne(system, clock, { type: 'poll', dedupeKey: 'a' });
  await system.tick();

  clock.advance(HOUR);
  enqueueOne(system, clock, { type: 'expire', dedupeKey: 'b' });
  await system.tick();

  assert.equal(system.stats().running, 2);
  const oldest = system.stats().oldestRunning;
  assert.equal(oldest?.type, 'poll', 'the newer job must not hide the older one');
  assert.equal(oldest?.startedAtMs, firstAt);

  held.open();
  await system.drain();
});

test('a row claimed before the column existed is skipped, not reported with no start time', () => {
  // THE FAILURE THIS PREVENTS IS A SORTING ONE, and it is silent. `started_at_ms` arrived in
  // core migration 0002, so a row claimed by the previous release carries NULL - and SQLite
  // sorts NULL FIRST in an ascending ORDER BY. Without the `IS NOT NULL` filter the single row
  // this query returns would be that one, every time, for as long as it existed: the command
  // would answer "nothing is stuck" by way of the one row it can say nothing about.
  const { db, clock, system } = harness([makeJob({ run: async () => ({ kind: 'done' }) })]);
  const now = clock.now();
  db.exec(
    `INSERT INTO core_jobs (id, module_id, type, payload, run_after_ms, deadline_at_ms, dedupe_key, state, attempts, last_error, lease_owner, lease_until_ms, created_at_ms, updated_at_ms, started_at_ms)
     VALUES ('legacy', 'builder', 'poll', '{}', ${now}, ${now + HOUR}, NULL, 'running', 1, NULL, 'someone', ${now + 60_000}, ${now}, ${now}, NULL)`,
  );

  assert.equal(system.stats().running, 1, 'it is counted...');
  assert.equal(system.stats().oldestRunning, null, '...and it is never the answer to "how long"');
});

// ---------------------------------------------------------------------------------------
// Cancellation, scheduling, permissions
// ---------------------------------------------------------------------------------------

test('cancel stops a queued job once, and says so the second time', async () => {
  let ran = 0;
  const j = makeJob({
    run: async () => {
      ran += 1;
      return { kind: 'done' };
    },
  });
  const { db, clock, system } = harness([j]);
  const port = system.portFor('builder');
  const id = enqueueOne(system, clock);
  assert.equal(port.findByDedupeKey('req-1'), id);

  const first = port.cancel(id);
  assert.ok(first.ok);
  assert.equal(first.value, true);

  await system.tick();
  await system.drain();
  assert.equal(ran, 0);
  assert.equal(textCol(jobRow(db, id), 'state'), 'cancelled');

  const second = port.cancel(id);
  assert.ok(second.ok);
  assert.equal(second.value, false, 'cancelling a finished job is a routine false, not an error');
});

test('a scheduled job is armed once at boot and re-arms itself after every run', async () => {
  let runs = 0;
  const j = makeJob({
    type: 'sweep',
    schedule: { everyMs: 60_000 },
    run: async () => {
      runs += 1;
      return { kind: 'done' };
    },
  });
  const { clock, system } = harness([j]);

  const first = system.recover();
  assert.equal(first.scheduled, 1);
  // Idempotent: a second boot-time arm must not create a second live occurrence.
  const second = system.recover();
  assert.equal(second.scheduled, 0);

  await system.tick();
  await system.drain();
  assert.equal(runs, 1);
  assert.equal(system.stats().queued, 1, 'the next occurrence is already queued');

  await system.tick();
  await system.drain();
  assert.equal(runs, 1, 'and it is not due yet');

  clock.advance(60_000);
  await system.tick();
  await system.drain();
  assert.equal(runs, 2);
});

test('a job that needs a Discord permission it lacks tells the human instead of provoking a 403', async () => {
  let ran = 0;
  const dead: AppError[] = [];
  const j = makeJob({
    needs: ['SendMessages'],
    run: async () => {
      ran += 1;
      return { kind: 'done' };
    },
    onDead: async (_p, last) => {
      dead.push(last);
    },
  });
  const db = createTestDb();
  const clock = manualClock();
  const map = new Map<string, ErasedJob>([[`${j.moduleId}:${j.type}`, j]]);
  const system = createJobSystem({
    db,
    clock,
    logger: silentLogger(),
    jobs: map,
    random: () => 0,
    discord: {
      // The bot has ViewChannel here and nothing else.
      botPermissionsIn: async () => Ok(1n << 10n),
      missingFromAppPermissions: (bits, needs) => missingPermissions(bits, needs),
    },
  });

  const now = clock.now();
  const r = system.portFor('builder').enqueue({
    type: 'poll',
    payload: { [SURFACE_KEY]: { guildId: '111111111111111111', channelId: '222222222222222222', messageId: '333333333333333333' } },
    runAfterMs: now,
    deadlineAtMs: now + HOUR,
    dedupeKey: null,
  });
  assert.ok(r.ok);

  await system.tick();
  await system.drain();

  assert.equal(ran, 0, 'the attempt is refused before it can provoke a 403 from a background task');
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.kind, 'missing-bot-permission');
  assert.equal(textCol(jobRow(db, r.value.id), 'state'), 'dead');
});

test('enqueueing a job type this module never declared fails at the enqueue, not at 2am', () => {
  const j = makeJob({ run: async () => ({ kind: 'done' }) });
  const { clock, system } = harness([j]);
  const r = system.portFor('builder').enqueue({
    type: 'typo',
    payload: {},
    runAfterMs: clock.now(),
    deadlineAtMs: clock.now() + HOUR,
    dedupeKey: null,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, 'config');
});

test('stop() releases the lease and hands the attempt back, because a SIGTERM is not a failure', async () => {
  const g = gate();
  const j = makeJob({
    run: async (_p, rt) => {
      await rt.sleep(HOUR); // Returns as soon as the signal aborts.
      g.open();
      return { kind: 'retry', afterMs: 1_000, why: 'shutting down' };
    },
  });
  const { db, clock, system } = harness([j]);
  const id = enqueueOne(system, clock);
  await system.tick();
  assert.equal(textCol(jobRow(db, id), 'state'), 'running');

  await system.stop({ graceMs: 1_000 });
  await g.wait;

  const state = textCol(jobRow(db, id), 'state');
  assert.equal(state, 'queued', 'the work is queued again for the next boot');
  assert.equal(intCol(jobRow(db, id), 'attempts'), 0, 'and the interrupted attempt was handed back');
});
