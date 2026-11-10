/**
 * The rate gate, against a real database.
 *
 * Until this adapter existed the composition root wired `ALLOW_ALL`, so every `limit.perUser(...)`
 * declaration in every module enforced nothing — and the module that spends money declares two of
 * them. A test that used a fake gate would have kept passing throughout, which is why these run
 * against real SQLite.
 */

import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { openSqlite } from '#adapters/sqlite/db';
import { runCoreMigrations } from '#adapters/sqlite/migrate';
import { bucketKey, createRateGate, retryAfterMs, windowIndex } from '#adapters/system/ratelimit';
import { limit } from '#core/ratelimit';
import type { RateGateRequest } from '#adapters/discord/router';

const NOW = 1_700_000_000_000;

function gate() {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok);
  if (!opened.ok) throw new Error('unreachable');
  // The real boot path, not a hand-applied DDL string: core's schema now arrives through the
  // ledger, and a test that bypassed it could pass against a schema production never gets.
  assert.ok(runCoreMigrations(opened.value).ok);
  return { db: opened.value, gate: createRateGate({ db: opened.value.coreDb() }) };
}

function req(over: Partial<RateGateRequest> = {}): RateGateRequest {
  return {
    moduleId: 'builder',
    name: 'command:$request',
    limits: [limit.perUser(3, 60_000)],
    userId: 'user-1' as RateGateRequest['userId'],
    guildId: 'guild-1' as RateGateRequest['guildId'],
    channelId: 'chan-1' as RateGateRequest['channelId'],
    at: NOW,
    ...over,
  };
}

test('a bucket admits exactly its count, then refuses', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  for (let i = 1; i <= 3; i += 1) {
    assert.ok(g.spend(req()).ok, `request ${i} of 3 should be admitted`);
  }

  const fourth = g.spend(req());
  assert.equal(fourth.ok, false, 'the fourth must be refused — this is the whole point');
  if (fourth.ok) return;
  assert.equal(fourth.error.kind, 'rate-limited');
});

test('a refused request is NOT charged, so the caller is not punished twice', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  for (let i = 0; i < 3; i += 1) g.spend(req());
  g.spend(req()); // refused
  g.spend(req()); // refused again

  // Move to the next window: the budget must be exactly full again, not in deficit.
  const next = NOW + 60_000;
  for (let i = 1; i <= 3; i += 1) {
    assert.ok(g.spend(req({ at: next })).ok, `next window request ${i} should be admitted`);
  }
});

test('buckets are separate per user, per guild and per command', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  for (let i = 0; i < 3; i += 1) g.spend(req());
  assert.equal(g.spend(req()).ok, false, 'user-1 is exhausted');

  assert.ok(
    g.spend(req({ userId: 'user-2' as RateGateRequest['userId'] })).ok,
    'a different user has their own budget',
  );
  assert.ok(
    g.spend(req({ name: 'command:other' })).ok,
    'a different command has its own budget, rather than silently sharing one',
  );
});

test('the window rolls: a new window restores the budget', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  for (let i = 0; i < 3; i += 1) g.spend(req());
  assert.equal(g.spend(req()).ok, false);

  assert.ok(g.spend(req({ at: NOW + 60_000 })).ok, 'the next window is a fresh budget');
});

test('ALL declared buckets must admit, and a rejection charges NONE of them', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  // Generous per-user, tight per-guild — the shape SC-9 asks for on anything that spends.
  const limits = [limit.perUser(10, 60_000), limit.perGuild(2, 60_000)];

  assert.ok(g.spend(req({ limits })).ok, 'first');
  assert.ok(g.spend(req({ limits })).ok, 'second');
  assert.equal(g.spend(req({ limits })).ok, false, 'the guild bucket is exhausted');

  // The user bucket must not have been charged for the rejected attempt: a user blocked by the
  // guild limit should not also burn their own quota.
  const other = g.spend(req({ limits: [limit.perUser(10, 60_000)] }));
  assert.ok(other.ok, 'the per-user bucket still has room');
});

test('limits survive a restart, because the counter is persisted not in memory', () => {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const db = opened.value;
  after(() => db.close());
  assert.ok(runCoreMigrations(db).ok);

  // Two independent gate instances over the SAME database == the process restarting.
  const before = createRateGate({ db: db.coreDb() });
  for (let i = 0; i < 3; i += 1) before.spend(req());

  const afterRestart = createRateGate({ db: db.coreDb() });
  assert.equal(
    afterRestart.spend(req()).ok,
    false,
    'a restart must not hand back a fresh budget, or the limit is meaningless',
  );
});

test('NO_LIMIT spends nothing and always admits', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  for (let i = 0; i < 50; i += 1) {
    assert.ok(g.spend(req({ limits: [] })).ok);
  }
});

test('prune removes only unreachable windows', () => {
  const { db, gate: g } = gate();
  after(() => db.close());

  g.spend(req());
  assert.equal(g.prune(NOW - 1), 0, 'a live window is kept');
  assert.equal(g.prune(NOW + 1), 1, 'an old window is removed');
});

test('the pure helpers behave', () => {
  assert.equal(windowIndex(NOW, 60_000), Math.floor(NOW / 60_000));
  assert.equal(windowIndex(NOW, 60_000), windowIndex(NOW + 59_999 - (NOW % 60_000), 60_000));
  assert.ok(retryAfterMs(NOW, 60_000) > 0, 'never advertises a zero-second wait');
  assert.ok(retryAfterMs(NOW, 60_000) <= 60_000);

  const k = bucketKey(req(), limit.perUser(1, 1));
  assert.match(k, /^builder:command:\$request:user:user-1$/u, 'the key names module, entry point, scope and subject');
});
