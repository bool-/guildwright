/**
 * THE TEST THAT WAS MISSING.
 *
 * The builder shipped with two independent, fatal defects while `npm run check` was green with
 * 255 passing tests:
 *
 *   1. `migrations: true` and no `migrations/` directory, so `m_builder_requests` was never
 *      created and every query threw at runtime.
 *   2. `SELECT *` typed as `BuildRow`, so `row.issueNumber`, `row.runId`, `row.surfaceJson` and
 *      `row.requesterId` were ALWAYS `undefined` — SQLite returns `issue_number`, not
 *      `issueNumber`. No build could ever be dispatched.
 *
 * Neither was catchable by the existing suite, and that is the lesson worth keeping:
 * `db.queryOne<BuildRow>(...)` is an UNCHECKED generic. TypeScript takes the caller's word for
 * the row shape, so a query and its row type can disagree completely and still typecheck. The
 * fakes could not catch it either, because a fake returns whatever object the test author wrote.
 *
 * The only thing that catches this class of bug is a REAL database, running the REAL migrations,
 * through the REAL repo. That is all this file does — and it is why it is worth its runtime.
 *
 * IT NOW APPLIES EVERY MIGRATION IN THE DIRECTORY, not `0001` by name. A test pinned to one file
 * proves nothing about the file added next to it, and the columns `0002` adds — `issue_url`,
 * `run_url`, `succeeded_at` — are read by `selectRow` on every query in this module. A missing
 * one is `undefined` everywhere, silently, which is precisely the defect above.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildRepo, type NewBuildRow } from '#modules/builder/module';
import { openSqlite } from '#adapters/sqlite/db';
import { newCardNonce, newFenceNonce, newRequestId, type RequestId } from '#core/ids';

const MIGRATIONS_DIR = 'src/modules/builder/migrations';
const NOW = 1_700_000_000_000;
/** A cap high enough that claiming the slot is never what a fixture here is testing. */
const SEED_SLOTS = 1_000;
const HOUR = 3_600_000;

/** Every shipped migration, in the order the real applier would run them. */
function migrationSql(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
}

/** A real on-disk-shaped database, with the real migrations applied. */
function freshDb() {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok, 'the in-memory database must open');
  if (!opened.ok) throw new Error('unreachable');

  const db = opened.value;
  // Apply the shipped migrations verbatim. If a file drifts from what the repo queries, this
  // test fails — which is the entire point.
  for (const sql of migrationSql()) db.connection.exec(sql);
  return db;
}

const SURFACE = { guildId: '222222222222222222', channelId: '333333333333333333', messageId: '444444444444444444' };
const ISSUE_URL = 'https://github.com/o/r/issues/42';
const RUN_URL = 'https://github.com/o/r/actions/runs/9';

function seed(repo: ReturnType<typeof buildRepo>, id: RequestId, guildId = '222222222222222222'): NewBuildRow {
  const row: NewBuildRow = {
    id,
    state: 'draft',
    version: 1,
    guildId,
    repoKey: 'default',
    requesterId: '111111111111111111',
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
  };
  assert.ok(repo.claimSlot(row, NOW, SEED_SLOTS), 'fixture: the seeded request must claim a slot');
  return row;
}

/** Filed and posted: the state a card sits in while it waits for an approver. */
function awaitingApproval(repo: ReturnType<typeof buildRepo>, id: RequestId, issueNumber: number, at = NOW): void {
  repo.recordIssue(id, issueNumber, ISSUE_URL, SURFACE, at);
}

test('the shipped migrations create exactly the table the repo queries', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);

  // Before the fix this threw "no such table: m_builder_requests".
  const got = repo.get(id);
  assert.ok(got !== undefined, 'the row must be readable back');
});

test('every BuildRow field round-trips — the snake_case/camelCase defect', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  const written = seed(repo, id);

  const got = repo.get(id);
  assert.ok(got !== undefined);
  if (got === undefined) return;

  // Each of these was `undefined` before the aliases were added, and nothing failed.
  assert.equal(got.id, id, 'id');
  assert.equal(got.guildId, written.guildId, 'guildId <- guild_id');
  assert.equal(got.requesterId, written.requesterId, 'requesterId <- requester_id');
  assert.equal(got.fenceNonce, written.fenceNonce, 'fenceNonce <- fence_nonce');
  assert.equal(got.dispatchAttempts, 0, 'dispatchAttempts <- dispatch_attempts');
  assert.equal(got.state, 'draft', 'state');
  assert.equal(got.version, 1, 'version');
  // The columns 0002 adds. Every card link, and the refusal/PR split, read these.
  assert.equal(got.issueUrl, null, 'issueUrl <- issue_url');
  assert.equal(got.runUrl, null, 'runUrl <- run_url');
  assert.equal(got.succeededAt, null, 'succeededAt <- succeeded_at');

  // And no key arrives under its raw column name, which is how the bug hid.
  const rawNames = ['guild_id', 'requester_id', 'fence_nonce', 'issue_number', 'run_id', 'surface_json', 'issue_url', 'run_url', 'succeeded_at'];
  for (const raw of rawNames) {
    assert.ok(!(raw in got), `"${raw}" must be aliased, not leaked as a raw column name`);
  }
});

test('recordIssue and recordRun actually populate the fields the dispatch path reads', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);

  assert.ok(repo.recordIssue(id, 42, ISSUE_URL, SURFACE, NOW), 'draft -> awaiting_approval must apply');

  const afterIssue = repo.get(id);
  assert.equal(afterIssue?.issueNumber, 42, 'issueNumber is what the dispatch input is built from');
  assert.equal(afterIssue?.issueUrl, ISSUE_URL, 'and the issue URL, which every card now links to');
  assert.equal(afterIssue?.state, 'awaiting_approval');
  assert.ok(afterIssue?.surfaceJson !== null, 'the delivery surface must persist — the PR link depends on it');

  assert.ok(repo.compareAndSet(id, afterIssue?.version ?? 0, 'dispatching', NOW), 'approve');
  assert.ok(repo.recordRun(id, 99_999, RUN_URL, NOW), 'dispatching -> running');
  assert.equal(repo.get(id)?.runId, 99_999, 'runId is what the poller polls');
  assert.equal(repo.get(id)?.runUrl, RUN_URL, 'and the run log URL the failure card links to');
});

test('the run log URL is learned once and never overwritten by a later, emptier answer', () => {
  // `recordRunUrl` is the poll path filling in what a blind dispatch could not, and `recordRun`
  // coalesces — so a correlation that found no URL must not erase one already recorded.
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);
  awaitingApproval(repo, id, 7);
  repo.compareAndSet(id, repo.get(id)?.version ?? 0, 'dispatching', NOW);

  assert.ok(repo.recordRun(id, 1, null, NOW), 'a blind dispatch may know the run id and no URL');
  assert.equal(repo.get(id)?.runUrl, null);

  assert.equal(repo.recordRunUrl(id, RUN_URL, NOW), true, 'the poller fills it in');
  assert.equal(repo.get(id)?.runUrl, RUN_URL);

  assert.equal(repo.recordRunUrl(id, 'https://github.com/o/r/actions/runs/999', NOW), false, 'and never re-writes it');
  assert.equal(repo.get(id)?.runUrl, RUN_URL, 'the first URL stands');
});

test('compare-and-set: the second approver loses, against a real database', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);
  awaitingApproval(repo, id, 7);

  const version = repo.get(id)?.version ?? 0;

  // Two approvers click at the same instant, both holding the same version.
  const first = repo.compareAndSet(id, version, 'dispatching', NOW);
  const second = repo.compareAndSet(id, version, 'dispatching', NOW);

  assert.equal(first, true, 'the first approver wins');
  assert.equal(second, false, 'the second must lose, or the build is dispatched — and paid for — twice');
});

test('the state CHECK constraint refuses a state the machine does not define', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);

  // A typo'd state must be a database error, not a row that no code path can ever move again.
  assert.throws(() => repo.compareAndSet(id, 1, 'dispatchng' as never, NOW), /CHECK|constraint/iu);
});

test('every object the migrations create is inside the module namespace', () => {
  const conn = new DatabaseSync(':memory:');
  for (const sql of migrationSql()) conn.exec(sql);

  const objects = conn
    .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all() as unknown as ReadonlyArray<{ name: string }>;

  assert.ok(objects.length > 0, 'the migrations must create something');
  for (const o of objects) {
    assert.ok(
      o.name.startsWith('m_builder_'),
      `"${o.name}" escapes the module namespace; boot asserts m_builder_* and would refuse to start`,
    );
  }
  conn.close();
});

// ---------------------------------------------------------------------------------------
// The concurrency ledger, and the two very different ways a slot is occupied
// ---------------------------------------------------------------------------------------

test('a finished build RELEASES its concurrency slot', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const guildId = '222222222222222222';

  // Three requests that each reach 'running', the way a real approved build does.
  const ids = [0, 1, 2].map((i) => {
    const id = newRequestId(NOW + i);
    seed(repo, id, guildId);
    awaitingApproval(repo, id, 100 + i);
    repo.compareAndSet(id, repo.get(id)?.version ?? 0, 'dispatching', NOW);
    repo.recordRun(id, 900 + i, RUN_URL, NOW);
    return id;
  });

  assert.deepEqual(repo.activeCounts(guildId), { waiting: 0, running: 3, filing: 0 }, 'three builds are genuinely in flight');

  // Each one completes successfully.
  for (const id of ids) repo.finish(id, 'pr_open', NOW);

  assert.deepEqual(
    repo.activeCounts(guildId),
    { waiting: 0, running: 0, filing: 0 },
    'a COMPLETED build must not keep occupying a slot, or the guild locks itself out after N requests',
  );
});

test('activeCounts SEPARATES what is building from what nobody has approved', () => {
  // THE DISTINCTION THE REFUSAL MESSAGE IS BUILT ON. One number could not tell a requester
  // whether waiting would help — and in the case that actually bricked guilds, where every slot
  // was held by an unclicked request, waiting was the one action that could never work.
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const guildId = '222222222222222222';

  const waiting = newRequestId(NOW);
  seed(repo, waiting, guildId);
  awaitingApproval(repo, waiting, 1);

  const running = newRequestId(NOW + 1);
  seed(repo, running, guildId);
  awaitingApproval(repo, running, 2);
  repo.compareAndSet(running, repo.get(running)?.version ?? 0, 'dispatching', NOW);
  repo.recordRun(running, 5, RUN_URL, NOW);

  assert.deepEqual(repo.activeCounts(guildId), { waiting: 1, running: 1, filing: 0 });

  // And another guild's rows are never counted here.
  assert.deepEqual(repo.activeCounts('999999999999999999'), { waiting: 0, running: 0, filing: 0 });
});

test('activeCounts reports zero — not NULL — for a guild that has never used the bot', () => {
  // `sum()` over zero rows is NULL in SQLite, and a NULL arriving as `waiting` would compare
  // false against every threshold by accident rather than by decision.
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  assert.deepEqual(repo.activeCounts('222222222222222222'), { waiting: 0, running: 0, filing: 0 });
});

// ---------------------------------------------------------------------------------------
// Expiry — the query behind the release valve
// ---------------------------------------------------------------------------------------

test('expiring() selects unclicked requests older than the cutoff, and NOTHING else', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const guildId = '222222222222222222';

  const old = newRequestId(NOW);
  seed(repo, old, guildId);
  awaitingApproval(repo, old, 1, NOW - 72 * HOUR);

  const recent = newRequestId(NOW + 1);
  seed(repo, recent, guildId);
  awaitingApproval(repo, recent, 2, NOW - HOUR);

  // An OLD row that is already building must never be swept: it is spending money right now.
  const building = newRequestId(NOW + 2);
  seed(repo, building, guildId);
  awaitingApproval(repo, building, 3, NOW - 72 * HOUR);
  repo.compareAndSet(building, repo.get(building)?.version ?? 0, 'dispatching', NOW - 72 * HOUR);
  repo.recordRun(building, 5, RUN_URL, NOW - 72 * HOUR);

  const found = repo.expiring(NOW - 48 * HOUR, 50).map((r) => r.id);
  assert.deepEqual(found, [old], 'only the unclicked, over-age request');
});

test('an expired request releases its slot exactly as a rejected one does', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const guildId = '222222222222222222';
  const id = newRequestId(NOW);
  seed(repo, id, guildId);
  awaitingApproval(repo, id, 1, NOW - 72 * HOUR);

  assert.deepEqual(repo.activeCounts(guildId), { waiting: 1, running: 0, filing: 0 }, 'it holds a slot while it waits');

  const row = repo.expiring(NOW - 48 * HOUR, 50)[0];
  assert.ok(row !== undefined);
  if (row === undefined) return;
  assert.equal(repo.compareAndSet(row.id, row.version, 'expired', NOW), true);

  assert.deepEqual(repo.activeCounts(guildId), { waiting: 0, running: 0, filing: 0 }, 'and lets go of it when it expires');
  assert.equal(repo.get(id)?.state, 'expired', 'a state the CHECK constraint always allowed and nothing ever wrote');
});

test('the expiry sweep cannot expire a request an approver just approved', () => {
  // The CAS is what makes the human win. Approve bumps the version, so the sweep — holding the
  // version it read a moment earlier — changes zero rows and moves on.
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);
  awaitingApproval(repo, id, 1, NOW - 72 * HOUR);

  const row = repo.expiring(NOW - 48 * HOUR, 50)[0];
  assert.ok(row !== undefined);
  if (row === undefined) return;

  // The approver clicks between the sweep's SELECT and its UPDATE.
  assert.equal(repo.compareAndSet(row.id, row.version, 'dispatching', NOW), true, 'the human wins the race');
  assert.equal(repo.compareAndSet(row.id, row.version, 'expired', NOW), false, 'and the sweep changes nothing');
  assert.equal(repo.get(id)?.state, 'dispatching', 'the approved build is not expired underneath itself');
});

test('finish is idempotent and never resurrects a terminal row', () => {
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);

  assert.equal(repo.finish(id, 'pr_open', NOW), true, 'the first finish applies');
  assert.equal(repo.finish(id, 'failed', NOW), false, 'a second call is a no-op, not a downgrade');
  assert.equal(repo.get(id)?.state, 'pr_open', 'the terminal state stands');
});

// ---------------------------------------------------------------------------------------
// The counters the poll path reads
// ---------------------------------------------------------------------------------------

test('countDispatchAttempt actually raises the column the ceiling is compared against', () => {
  // The whole defect in one assertion: the INSERT wrote 0, the SELECT aliased it, the job
  // compared it — and nothing ever incremented it, so `maxDispatchAttempts` was unreachable.
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);

  assert.equal(repo.get(id)?.dispatchAttempts, 0);
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(repo.countDispatchAttempt(id, NOW + i), true);
    assert.equal(repo.get(id)?.dispatchAttempts, i, `attempt ${String(i)} must be persisted`);
  }
});

test('noteRunSucceeded stamps the FIRST success and never moves afterwards', () => {
  // It is a grace-period anchor. If a later poll overwrote it, the window would restart on every
  // poll and a deliberate refusal would never be recognised.
  const db = freshDb();
  after(() => db.close());

  const repo = buildRepo(db.moduleDb('builder'));
  const id = newRequestId(NOW);
  seed(repo, id);

  assert.equal(repo.noteRunSucceeded(id, NOW), true);
  assert.equal(repo.get(id)?.succeededAt, NOW);
  assert.equal(repo.noteRunSucceeded(id, NOW + 60_000), false, 'a second success is not a new deadline');
  assert.equal(repo.get(id)?.succeededAt, NOW);
});
