/**
 * THE OBSERVABILITY PORT, END TO END - the door, and the fact that it is a narrow one.
 *
 * `AuditLog.recent`, `AuditLog.forGuild` and `JobSystem.stats` were all written, all tested, and
 * all called by nothing outside their own test files. So the append-only table that exists to
 * answer "who approved this, and which layer let them?" was answerable only by opening the
 * SQLite file on the host - which is not something anyone does at 3am, and is impossible for
 * the person who is being asked.
 *
 * WHAT IS UNDER TEST HERE is the assembly the composition root performs, written out against
 * the REAL adapters rather than against fakes: the `guildId === null` branch, the fact that
 * scoping is honoured, and - the part that would be a security bug rather than a defect - that
 * a module holding `admin` receives EXACTLY those two reads and nothing that can write.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ALL_CAPABILITIES, oldestRunningJob, portsFor, type AdminPort, type Capability } from '#core/ports';
import type { ErasedJob } from '#core/module';
import type { JobOutcome } from '#core/command';
import { createAuditLog } from '#adapters/system/audit';
import { createJobSystem, type JobSystem } from '#adapters/system/jobs';
import { createTestDb } from '#adapters/system/testdb';
import { manualClock, type ManualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';
import { fakeAdmin, fakePorts, fakePortsOnly } from '#testing/fakes';

const GUILD_A = '100000000000000001';
const GUILD_B = '100000000000000002';

interface AdminHarness {
  readonly admin: AdminPort;
  readonly record: (guildId: string | null, action: string) => void;
  /** The real runner behind `jobStats`, so a test can put a job into `running` honestly. */
  readonly jobs: JobSystem;
  readonly clock: ManualClock;
}

/** Exactly the wiring `src/main.ts` performs, so the branch under test is the shipped one. */
function adminOver(): AdminHarness {
  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const auditLog = createAuditLog({ db, clock, logger });
  const jobs = createJobSystem({ db, clock, logger });
  const admin: AdminPort = {
    recentAudit: (guildId, limit) => (guildId === null ? auditLog.recent(limit) : auditLog.forGuild(guildId, limit)),
    jobStats: () => jobs.stats(),
  };
  return {
    admin,
    jobs,
    clock,
    record: (guildId, action) => auditLog.portFor('builder').record({ action, actorId: '1', guildId, detail: {} }),
  };
}

test('recentAudit(null) spans every guild; a guild id scopes it to that guild', () => {
  const { admin, record } = adminOver();
  record(GUILD_A, 'builder.request');
  record(GUILD_B, 'builder.request');
  record(GUILD_A, 'builder.approve');
  record(null, 'builder.expire');

  const all = admin.recentAudit(null, 10);
  assert.equal(all.length, 4);
  assert.equal(all[0]?.action, 'builder.expire', 'newest first, the way an investigation reads');

  // THE FAILURE THIS ARGUMENT EXISTS TO PREVENT: one server's audit history rendered into
  // another server's channel. The scoping is not advisory.
  const scoped = admin.recentAudit(GUILD_A, 10);
  assert.deepEqual(scoped.map((r) => r.action), ['builder.approve', 'builder.request']);
  for (const row of scoped) assert.equal(row.guildId, GUILD_A);
});

test('the limit is honoured and clamped, so a huge number is a small answer', () => {
  const { admin, record } = adminOver();
  for (let i = 0; i < 5; i += 1) record(GUILD_A, 'builder.request');
  assert.equal(admin.recentAudit(null, 2).length, 2);
  // Nonsense clamps rather than throwing, and it clamps DOWNWARD - a limit nobody meant must
  // not become a table scan that blocks the interaction it was asked from.
  assert.equal(admin.recentAudit(null, 0).length, 1, 'zero clamps up to one');
  assert.equal(admin.recentAudit(null, Number.POSITIVE_INFINITY).length, 1, 'and so does infinity');
  assert.equal(admin.recentAudit(GUILD_A, 1_000_000).length, 5, 'a big finite limit just returns everything there is');
});

test('jobStats reports a count per state, including the two that only matter alone', () => {
  const { admin } = adminOver();
  const stats = admin.jobStats();
  // `dead` is a build nobody will ever hear about again and `orphaned` is a queued row whose
  // module is gone - the card still says "Building..." and nothing is left to move it. Both are
  // invisible in a total, which is why every state is a named field.
  assert.deepEqual(stats, {
    queued: 0,
    running: 0,
    done: 0,
    dead: 0,
    cancelled: 0,
    orphaned: 0,
    // Present and `null`, not absent: an empty queue has no oldest job, and that is a state the
    // renderer has to be given rather than left to infer from a missing property.
    oldestRunning: null,
  });
});

test('jobStats carries the oldest running job, so "1 running" can become "running for 3d"', async () => {
  // THE COMMAND'S WHOLE POINT, END TO END through the port the composition root assembles. Two
  // sentences that used to be identical - a build that started seconds ago and one wedged since
  // Tuesday - and one field that tells them apart.
  const { admin, jobs, clock } = adminOver();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  jobs.registerJobs(
    new Map([
      [
        'builder:build',
        {
          moduleId: 'builder',
          type: 'build',
          maxAttempts: 3,
          deadlineMs: 3_600_000,
          backoff: { initialMs: 1_000, factor: 2, maxMs: 10_000, jitter: 0 },
          needs: [],
          schedule: null,
          run: async (): Promise<JobOutcome> => {
            await held;
            return { kind: 'done' };
          },
          onDead: async () => undefined,
          onUnparseable: async () => undefined,
        } satisfies ErasedJob,
      ],
    ]),
  );

  const startedAt = clock.now();
  const enqueued = jobs.portFor('builder').enqueue({
    type: 'build',
    payload: {},
    runAfterMs: startedAt,
    deadlineAtMs: startedAt + 3_600_000,
    dedupeKey: 'rq_1',
  });
  assert.equal(enqueued.ok, true);
  await jobs.tick();

  clock.advance(3 * 24 * 3_600_000);
  const stats = admin.jobStats();
  assert.equal(stats.running, 1, 'the count that used to be the whole answer');
  assert.deepEqual(
    oldestRunningJob(stats),
    // `ageMs` IS THE FIELD `/status` LIVES OR DIES ON. `ModuleHandle.health()` is called with no
    // time argument and `admin` declares no `clock` capability, so a start instant alone could
    // be rendered on the `/admin jobs` card and could never turn `/status` from `ok` to
    // `degraded` - which is the one place an operator is watching. The adapter subtracts,
    // because the adapter is the layer that legitimately owns a clock.
    { moduleId: 'builder', type: 'build', startedAtMs: startedAt, ageMs: 3 * 24 * 3_600_000 },
    'and the part of the answer an operator can act on',
  );

  release();
  await jobs.drain();
  assert.equal(oldestRunningJob(admin.jobStats()), null);
});

test('a module declaring `admin` gets those two reads and NOTHING that can write', () => {
  // The REAL port, as the composition root assembles it - not the fake, whose seeding helpers
  // exist for tests and would make this assertion meaningless.
  const bag = { ...fakePorts('m_ops_'), admin: adminOver().admin };
  const narrowed = portsFor(bag, ['admin'] as const, 'ops');
  assert.equal(narrowed.ok, true);
  if (!narrowed.ok) return;

  const keys = Object.keys(narrowed.value).sort();
  assert.deepEqual(keys, ['admin'], 'the blast radius is exactly what was declared');

  // READ THE ABSENCE. There is no `deleteAudit`, no `clearJobs`, no `cancelJob`, no `grant`. The
  // audit log's whole value is that it is append-only; a port that could edit it would weaken
  // "the row is there" into "the row is there and nobody has been to it since".
  const surface = Object.keys(narrowed.value.admin).sort();
  assert.deepEqual(surface, ['jobStats', 'recentAudit']);
});

test('`admin` is a real capability: declared in ALL_CAPABILITIES and wired by fakePorts', () => {
  // The `satisfies readonly Capability[]` clause in #core/ports fails to compile if a port is
  // added and not listed. This is the runtime half - that a module can actually be handed one.
  assert.ok((ALL_CAPABILITIES as readonly Capability[]).includes('admin'));
  const only = fakePortsOnly('m_ops_', ['admin']);
  assert.notEqual(only.admin, undefined);
  // And the negative: a module that did NOT declare it cannot reach it, at runtime as well as
  // at type level, because `portsFor` deletes rather than merely re-typing.
  const without = portsFor(fakePorts('m_ops_'), ['clock'] as const, 'ops');
  assert.equal(without.ok, true);
  if (!without.ok) return;
  assert.equal(Object.hasOwn(without.value, 'admin'), false);
});

test('the fake reports the same shape, including a null oldest job on an empty queue', () => {
  // A fake that OMITTED the field would leave every renderer tested against it exercised only
  // on the absent case, while production only ever produces `null`. `oldestRunningJob` is the
  // one door that collapses the two, and it has to answer for the fake as well.
  const admin = fakeAdmin();
  assert.equal(oldestRunningJob(admin.jobStats()), null);

  admin.setJobStats({
    queued: 0,
    running: 1,
    done: 0,
    dead: 0,
    cancelled: 0,
    orphaned: 0,
    oldestRunning: { moduleId: 'builder', type: 'build', startedAtMs: 1_700_000_000_000, ageMs: 90_000 },
  });
  assert.deepEqual(oldestRunningJob(admin.jobStats()), {
    moduleId: 'builder',
    type: 'build',
    startedAtMs: 1_700_000_000_000,
    // THE FIELD THE INTEGRATION ADDED. `health()` is called with no clock and `admin` declares
    // no `clock` capability, so an instant alone could be rendered on the card and could never
    // degrade `/status` - which is the one place a wedged job needs to surface.
    ageMs: 90_000,
  });
});

test('the fake models the guild filter, so a leak between servers cannot pass against it', () => {
  const admin = fakeAdmin();
  const base = { id: 0, atMs: 0, moduleId: 'builder', action: 'builder.request', actorId: '1', decisionLayer: null, detail: {} };
  admin.seedAudit({ ...base, id: 1, guildId: GUILD_A });
  admin.seedAudit({ ...base, id: 2, guildId: GUILD_B });
  admin.seedAudit({ ...base, id: 3, guildId: GUILD_A });

  assert.deepEqual(admin.recentAudit(GUILD_A, 10).map((r) => r.id), [3, 1], 'scoped, and newest first');
  assert.deepEqual(admin.recentAudit(null, 10).map((r) => r.id), [3, 2, 1]);
  assert.deepEqual([...admin.queries], [
    { guildId: GUILD_A, limit: 10 },
    { guildId: null, limit: 10 },
  ]);
});
