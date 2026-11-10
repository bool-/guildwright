/**
 * Runtime proof for the SQLite adapter.
 *
 * Every test here runs against a REAL file-backed database in a temp directory, not
 * `:memory:`, because two of the claims being proven - that WAL is actually on, and that a
 * `-wal` sidecar exists - are only true of a file. The directory is removed afterwards.
 *
 * THE TEST THAT MATTERS MOST is `compare-and-set`. A double-clicked Approve is two
 * interactions racing for the same row, and the ONLY thing that stops the second one
 * dispatching a build is that its guarded UPDATE reports `changes === 0`. It is asserted here
 * as two exact numbers rather than "truthy/falsy", because "changes is 1 both times" is the
 * shape of the bug.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { AppError } from '#core/errors';
import { sql, type SqlIdent } from '#core/sql';

import { DbPortError, isDbPortError, openSqlite, type SqliteDb, type SqliteOptions } from '#adapters/sqlite/db';

const FIXED_NOW = 1_700_000_000_000;

/** Open a real database in a temp directory, and remove the whole directory afterwards. */
function tempDb(t: TestContext, options: SqliteOptions = {}): SqliteDb {
  const dir = mkdtempSync(join(tmpdir(), 'bot-sqlite-'));
  const opened = openSqlite(join(dir, 'bot.sqlite'), { now: () => FIXED_NOW, ...options });
  if (!opened.ok) throw new Error(`openSqlite failed: ${opened.error.code}`);
  const db = opened.value;
  t.after(() => {
    // The file must be closed before Windows will let the directory go.
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** The `AppError` behind a `DbPortError`, or a failure if something else was thrown. */
function appErrorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (cause: unknown) {
    if (isDbPortError(cause)) return cause.appError;
    throw cause;
  }
  throw new Error('expected the call to throw');
}

// ---------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------

test('a file database opens in WAL, with foreign keys on and a real busy timeout', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-sqlite-'));
  const path = join(dir, 'bot.sqlite');
  const opened = openSqlite(path, { busyTimeoutMs: 4321, now: () => FIXED_NOW });
  if (!opened.ok) throw new Error('openSqlite failed');
  const db = opened.value;
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(db.journalMode, 'wal', 'WAL is what bounds a hard kill to the in-flight transaction');
  // Read through the raw connection, so these assertions cannot be satisfied by the adapter.
  assert.equal(db.connection.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1);
  assert.equal(db.connection.prepare('PRAGMA busy_timeout').get()?.['timeout'], 4321, 'the default is 0: fail instantly');

  // Force a write so the sidecar appears, then prove WAL is a property of the file.
  db.connection.exec('CREATE TABLE m_x_probe (id INTEGER PRIMARY KEY) STRICT');
  assert.ok(existsSync(`${path}-wal`), 'a WAL database has a -wal sidecar');
});

test('openSqlite creates the parent directory rather than failing on a fresh checkout', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-sqlite-'));
  const opened = openSqlite(join(dir, 'data', 'nested', 'bot.sqlite'), { now: () => FIXED_NOW });
  if (!opened.ok) throw new Error('openSqlite failed');
  const db = opened.value;
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(db.journalMode, 'wal');
});

test('openSqlite reports a bad path as a config error instead of throwing', () => {
  // A directory is not a SQLite file; SQLITE_CANTOPEN must surface as an `AppError`.
  const dir = mkdtempSync(join(tmpdir(), 'bot-sqlite-'));
  const opened = openSqlite(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(opened.ok, false);
  if (opened.ok) return;
  assert.equal(opened.error.kind, 'config');
  assert.equal(opened.error.location, 'DATABASE_PATH');
  assert.ok(opened.error.nextStep.length > 0, 'every AppError must say what to do next');
});

// ---------------------------------------------------------------------------------------
// THE compare-and-set proof
// ---------------------------------------------------------------------------------------

test('compare-and-set: the first guarded UPDATE changes 1 row, the second changes 0', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec(`
    CREATE TABLE m_builder_requests (
      id     TEXT NOT NULL PRIMARY KEY,
      state  TEXT NOT NULL,
      run_id INTEGER
    ) STRICT`);

  const db = sqliteDb.moduleDb('builder');
  const requests = db.table('requests');
  db.execute(sql`INSERT INTO ${requests} (id, state, run_id) VALUES (${'req-1'}, ${'pending'}, ${null})`);

  // Two Approve clicks racing for the same row. Both statements are byte-identical, which is
  // the realistic case: they are the same handler, run twice.
  const first = db.execute(
    sql`UPDATE ${requests} SET state = ${'approved'} WHERE id = ${'req-1'} AND state = ${'pending'}`,
  );
  const second = db.execute(
    sql`UPDATE ${requests} SET state = ${'approved'} WHERE id = ${'req-1'} AND state = ${'pending'}`,
  );

  assert.equal(first.changes, 1, 'the click that wins the race must see exactly one row change');
  assert.equal(second.changes, 0, 'the second click MUST see zero, or the build is dispatched twice');
  assert.equal(typeof first.changes, 'number', 'changes is narrowed from number|bigint at the adapter');

  const row = db.queryOne<{ state: string }>(sql`SELECT state FROM ${requests} WHERE id = ${'req-1'}`);
  assert.equal(row?.state, 'approved', 'exactly one transition happened');
});

test('a guarded UPDATE that matches nothing is a benign 0, not a throw', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('builder');
  const r = db.execute(sql`UPDATE ${db.table('requests')} SET state = ${'x'} WHERE id = ${'absent'}`);
  assert.equal(r.changes, 0);
});

// ---------------------------------------------------------------------------------------
// Reads, writes and binding
// ---------------------------------------------------------------------------------------

test('query, queryOne and execute round-trip every SqlValue the tag admits', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec(`
    CREATE TABLE m_tags_items (
      name  TEXT NOT NULL PRIMARY KEY,
      flag  INTEGER NOT NULL,
      score REAL,
      blob  BLOB,
      note  TEXT
    ) STRICT`);
  const db = sqliteDb.moduleDb('tags');
  const items = db.table('items');

  // `boolean` is the interesting one: node:sqlite refuses to bind it natively, so the adapter
  // maps it to 1/0. Without that line this insert throws.
  const w = db.execute(
    sql`INSERT INTO ${items} (name, flag, score, blob, note)
        VALUES (${'a'}, ${true}, ${1.5}, ${new Uint8Array([1, 2, 3])}, ${null})`,
  );
  assert.equal(w.changes, 1);
  assert.equal(Number(w.lastInsertRowid) > 0, true);

  db.execute(sql`INSERT INTO ${items} (name, flag, score, blob, note) VALUES (${'b'}, ${false}, ${2.5}, ${null}, ${'hi'})`);

  const all = db.query<{ name: string; flag: number }>(sql`SELECT name, flag FROM ${items} ORDER BY ${db.column('name')}`);
  assert.deepEqual(all, [
    { name: 'a', flag: 1 },
    { name: 'b', flag: 0 },
  ]);

  const one = db.queryOne<{ note: string | null }>(sql`SELECT note FROM ${items} WHERE flag = ${true}`);
  assert.deepEqual(one, { note: null });

  assert.equal(db.queryOne(sql`SELECT name FROM ${items} WHERE name = ${'absent'}`), undefined);
  assert.deepEqual(db.query(sql`SELECT name FROM ${items} WHERE name = ${'absent'}`), []);
});

test('rows come back as ORDINARY objects, not the null-prototype ones node:sqlite returns', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_tags_items (name TEXT PRIMARY KEY) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const items = db.table('items');
  db.execute(sql`INSERT INTO ${items} (name) VALUES (${'a'})`);

  // The driver's own row has NO prototype. That is what makes `assert.deepStrictEqual` print
  // a diff of two objects that look identical, and it would land in every module's first
  // repo test rather than here.
  const raw = sqliteDb.connection.prepare('SELECT name FROM m_tags_items').get();
  assert.equal(Object.getPrototypeOf(raw), null, 'if this ever changes, the copy in rowAs can go');

  const row = db.queryOne<{ name: string }>(sql`SELECT name FROM ${items}`);
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepEqual(row, { name: 'a' }, 'deepStrictEqual against a literal must simply work');
});

test('a column aliased __proto__ cannot pollute anything', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_tags_items (name TEXT PRIMARY KEY) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const items = db.table('items');
  db.execute(sql`INSERT INTO ${items} (name) VALUES (${'a'})`);

  // `rowAs` spreads, and spread DEFINES rather than assigns - `Object.assign` here would set
  // through the prototype setter instead.
  const row = db.queryOne<Record<string, unknown>>(sql`SELECT name AS ${db.column('__proto__')} FROM ${items}`);
  assert.equal(Object.getPrototypeOf(row), Object.prototype, 'the prototype must be untouched');
  assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__')?.value, 'a', 'it is a plain own key');
});

test('a bigint bound value survives past 2^53', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_tags_ids (snowflake INTEGER NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const t2 = db.table('ids');
  db.execute(sql`INSERT INTO ${t2} (snowflake) VALUES (${9_007_199_254_740_993n})`);
  const row = db.queryOne<{ n: number }>(sql`SELECT count(*) AS n FROM ${t2} WHERE snowflake = ${9_007_199_254_740_993n}`);
  assert.equal(row?.n, 1, 'the bigint must round-trip as an exact integer comparison');
});

// ---------------------------------------------------------------------------------------
// Table ownership - what makes `capabilities: ['db']` a bounded grant
// ---------------------------------------------------------------------------------------

/** `SqlIdent`'s payload sits behind a module-private symbol, so read it the only public way. */
function renderIdent(id: SqlIdent): string {
  return sql`${id}`.text;
}

test('table() and tablePrefix mint only this module’s namespace', (t) => {
  const sqliteDb = tempDb(t);
  const db = sqliteDb.moduleDb('feature-builder');
  assert.equal(db.tablePrefix, 'm_feature_builder_', 'a hyphen in the module id is not a legal SQL identifier');
  assert.equal(renderIdent(db.table('requests')), 'm_feature_builder_requests');
  assert.equal(renderIdent(db.column('created_at')), 'created_at');
  assert.throws(() => db.column('name) OR 1=1 --'), TypeError, 'ident refuses anything that is not an identifier');
});

test('a module cannot read another module’s tables', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_secrets_vault (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const e = appErrorOf(() => db.query(sql`SELECT v FROM m_secrets_vault`));
  assert.equal(e.kind, 'config');
  assert.equal(e.code, 'config.db.table');
});

test('a module cannot write core_access, which is the privilege escalation this closes', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE core_access (subject TEXT NOT NULL, perm TEXT NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const e = appErrorOf(() => db.execute(sql`INSERT INTO core_access (subject, perm) VALUES (${'u1'}, ${'builder.approve'})`));
  assert.equal(e.kind, 'config');
  // The row must not exist: the statement is refused BEFORE it is prepared, let alone run.
  assert.equal(sqliteDb.connection.prepare('SELECT count(*) AS n FROM core_access').get()?.['n'], 0);
});

test('a module cannot issue DDL or a PRAGMA through the port', (t) => {
  const sqliteDb = tempDb(t);
  const db = sqliteDb.moduleDb('tags');
  for (const q of [
    sql`CREATE TABLE m_tags_sneaky (x TEXT)`,
    sql`DROP TABLE m_tags_items`,
    sql`ALTER TABLE m_tags_items ADD COLUMN y TEXT`,
    sql`PRAGMA journal_mode = DELETE`,
    sql`ATTACH DATABASE ${'/tmp/other.sqlite'} AS other`,
  ]) {
    const e = appErrorOf(() => db.execute(q));
    assert.equal(e.kind, 'config', `must refuse: ${q.text.trim().split(' ')[0] ?? ''}`);
  }
});

test('the core port may touch core_ tables and still not a module’s', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec(`
    CREATE TABLE core_audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL) STRICT;
    CREATE TABLE m_tags_items (name TEXT PRIMARY KEY) STRICT;`);
  const core = sqliteDb.coreDb();
  assert.equal(core.tablePrefix, 'core_');
  assert.equal(core.execute(sql`INSERT INTO core_audit (action) VALUES (${'boot'})`).changes, 1);
  const e = appErrorOf(() => core.query(sql`SELECT name FROM m_tags_items`));
  assert.equal(e.kind, 'config', 'core is not a skeleton key either');
});

test('a table name in a string literal is not mistaken for a table reference', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_tags_items (name TEXT PRIMARY KEY, note TEXT) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const items = db.table('items');
  db.execute(sql`INSERT INTO ${items} (name, note) VALUES (${'a'}, ${'select * from core_access'})`);
  const row = db.queryOne<{ note: string }>(sql`SELECT note FROM ${items} WHERE name = ${'a'}`);
  assert.equal(row?.note, 'select * from core_access', 'a VALUE is bound, never parsed as SQL');
});

// ---------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------

test('a throw inside a transaction rolls the whole thing back', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('builder');
  const requests = db.table('requests');

  assert.throws(
    () =>
      db.transaction(() => {
        db.execute(sql`INSERT INTO ${requests} (id, state) VALUES (${'a'}, ${'pending'})`);
        db.execute(sql`INSERT INTO ${requests} (id, state) VALUES (${'b'}, ${'pending'})`);
        throw new Error('the enqueue failed');
      }),
    /the enqueue failed/u,
    'the original cause must survive the rollback',
  );

  const n = db.queryOne<{ n: number }>(sql`SELECT count(*) AS n FROM ${requests}`);
  assert.equal(n?.n, 0, 'a state change and its job enqueue are all-or-nothing');
  assert.equal(sqliteDb.connection.isTransaction, false, 'the connection must not be left mid-transaction');
});

test('a transaction that returns commits, and returns its value', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('builder');
  const requests = db.table('requests');
  const out = db.transaction(() => {
    db.execute(sql`INSERT INTO ${requests} (id, state) VALUES (${'a'}, ${'pending'})`);
    return 'done';
  });
  assert.equal(out, 'done');
  assert.equal(db.queryOne<{ n: number }>(sql`SELECT count(*) AS n FROM ${requests}`)?.n, 1);
  assert.equal(sqliteDb.connection.isTransaction, false);
});

test('a nested transaction is a savepoint: the inner unwinds, the outer still commits', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT');
  const db = sqliteDb.moduleDb('builder');
  const requests = db.table('requests');

  db.transaction(() => {
    db.execute(sql`INSERT INTO ${requests} (id, state) VALUES (${'outer'}, ${'pending'})`);
    try {
      db.transaction(() => {
        db.execute(sql`INSERT INTO ${requests} (id, state) VALUES (${'inner'}, ${'pending'})`);
        throw new Error('inner failed');
      });
    } catch (ignored: unknown) {
      void ignored;
    }
  });

  const ids = db.query<{ id: string }>(sql`SELECT id FROM ${requests} ORDER BY ${db.column('id')}`);
  assert.deepEqual(ids, [{ id: 'outer' }], 'only the inner savepoint may be lost');
  assert.equal(sqliteDb.connection.isTransaction, false);
});

test('a transaction can be re-entered after one rolled back', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY) STRICT');
  const db = sqliteDb.moduleDb('builder');
  const requests = db.table('requests');
  assert.throws(() =>
    db.transaction(() => {
      throw new Error('boom');
    }),
  );
  // The depth counter must have been restored, or this second BEGIN issues a SAVEPOINT with
  // no surrounding transaction and the write is silently outside any transaction.
  db.transaction(() => db.execute(sql`INSERT INTO ${requests} (id) VALUES (${'a'})`));
  assert.equal(db.queryOne<{ n: number }>(sql`SELECT count(*) AS n FROM ${requests}`)?.n, 1);
});

// ---------------------------------------------------------------------------------------
// Constraint and busy handling
// ---------------------------------------------------------------------------------------

test('a foreign key violation is enforced and surfaces as a conflict, not a raw SQLite message', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec(`
    CREATE TABLE m_tags_owners (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE m_tags_items (
      name  TEXT NOT NULL PRIMARY KEY,
      owner INTEGER NOT NULL REFERENCES m_tags_owners(id)
    ) STRICT;`);
  const db = sqliteDb.moduleDb('tags');
  const e = appErrorOf(() => db.execute(sql`INSERT INTO ${db.table('items')} (name, owner) VALUES (${'a'}, ${99})`));
  assert.equal(e.kind, 'conflict', 'PRAGMA foreign_keys = ON must actually be on');
  assert.equal(e.internal, null, 'a user-visible conflict carries no SQLite text at all');
});

test('a unique violation is a conflict whose user text names no table', (t) => {
  const sqliteDb = tempDb(t);
  sqliteDb.connection.exec('CREATE TABLE m_tags_items (name TEXT NOT NULL PRIMARY KEY) STRICT');
  const db = sqliteDb.moduleDb('tags');
  const items = db.table('items');
  db.execute(sql`INSERT INTO ${items} (name) VALUES (${'a'})`);
  const e = appErrorOf(() => db.execute(sql`INSERT INTO ${items} (name) VALUES (${'a'})`));
  assert.equal(e.kind, 'conflict');
  assert.ok(!e.userDetail.includes('m_tags_items'), 'schema names are not user-facing');
});

test('a contended write waits out busy_timeout, then reports unavailable rather than throwing raw', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-sqlite-'));
  const path = join(dir, 'bot.sqlite');
  const openedA = openSqlite(path, { busyTimeoutMs: 200, now: () => FIXED_NOW });
  const openedB = openSqlite(path, { busyTimeoutMs: 200, now: () => FIXED_NOW });
  if (!openedA.ok || !openedB.ok) throw new Error('openSqlite failed');
  const [bot, other] = [openedA.value, openedB.value];
  t.after(() => {
    bot.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  });

  bot.connection.exec('CREATE TABLE m_tags_items (name TEXT PRIMARY KEY) STRICT');

  // A second process holds the write lock - e.g. a stray `npm run dev` on the same file.
  other.connection.exec('BEGIN IMMEDIATE');
  other.connection.prepare('INSERT INTO m_tags_items (name) VALUES (?)').run('held');

  const db = bot.moduleDb('tags');
  const startedAt = Date.now();
  const e = appErrorOf(() => db.execute(sql`INSERT INTO ${db.table('items')} (name) VALUES (${'mine'})`));
  const waitedMs = Date.now() - startedAt;
  other.connection.exec('ROLLBACK');

  assert.equal(e.kind, 'unavailable', 'SQLITE_BUSY is a dependency being unavailable, not a bug');
  assert.equal(e.retryable, true, 'a job may retry this one; the port itself never does');
  assert.ok(waitedMs >= 150, `busy_timeout must actually block: waited ${waitedMs}ms of 200ms`);
});

test('a malformed statement becomes an upstream AppError, and the SQLite text stays internal', (t) => {
  const sqliteDb = tempDb(t);
  const db = sqliteDb.moduleDb('tags');
  const e = appErrorOf(() => db.query(sql`SELECT nope FROM m_tags_missing`));
  assert.equal(e.kind, 'upstream');
  assert.equal(e.code, 'upstream.sqlite.0');
  assert.ok(e.internal !== null && e.internal.includes('m_tags_missing'), 'operators get the detail');
  assert.ok(!e.userDetail.includes('m_tags_missing'), 'users do not');
});

test('DbPortError is an Error, so an unhandled one still prints something useful', () => {
  const e = new DbPortError({
    kind: 'conflict',
    code: 'conflict.x',
    state: 'x',
    userDetail: 'u',
    nextStep: 'n',
    internal: null,
    retryable: false,
  });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'DbPortError');
  assert.equal(isDbPortError(e), true);
  assert.equal(isDbPortError(new Error('other')), false);
});

// ---------------------------------------------------------------------------------------
// The document store
// ---------------------------------------------------------------------------------------

test('docs.put is a compare-and-set on version, so two writers cannot both win', (t) => {
  const db = tempDb(t).moduleDb('builder');

  assert.equal(db.docs.put('requests', 'r1', { state: 'pending' }, 0), true, 'version 0 means "must not exist"');
  assert.equal(db.docs.put('requests', 'r1', { state: 'other' }, 0), false, 'a second create must lose');

  const got = db.docs.get('requests', 'r1');
  assert.deepEqual(got?.json, { state: 'pending' });
  assert.equal(got?.version, 1);
  assert.equal(got?.updatedAt, FIXED_NOW, 'updated_at comes from the injected clock, never Date.now');

  assert.equal(db.docs.put('requests', 'r1', { state: 'approved' }, 1), true);
  assert.equal(db.docs.put('requests', 'r1', { state: 'approved-again' }, 1), false, 'a stale version must lose');
  assert.deepEqual(db.docs.get('requests', 'r1')?.json, { state: 'approved' });
  assert.equal(db.docs.get('requests', 'r1')?.version, 2);
});

test('docs.get, del and list behave, and list is ordered and bounded', (t) => {
  const db = tempDb(t).moduleDb('builder');
  assert.equal(db.docs.get('requests', 'missing'), undefined);
  assert.equal(db.docs.del('requests', 'missing'), false);

  for (const k of ['c', 'a', 'b']) db.docs.put('requests', k, { k }, 0);
  assert.deepEqual(db.docs.list('requests', 10), [
    { key: 'a', json: { k: 'a' } },
    { key: 'b', json: { k: 'b' } },
    { key: 'c', json: { k: 'c' } },
  ]);
  assert.deepEqual(db.docs.list('requests', 2), [
    { key: 'a', json: { k: 'a' } },
    { key: 'b', json: { k: 'b' } },
  ]);
  assert.deepEqual(db.docs.list('other-collection', 10), []);

  assert.equal(db.docs.del('requests', 'b'), true);
  assert.equal(db.docs.get('requests', 'b'), undefined);
  assert.equal(db.docs.list('requests', 10).length, 2);
});

test('one module cannot see another module’s documents', (t) => {
  const sqliteDb = tempDb(t);
  const tags = sqliteDb.moduleDb('tags');
  const builder = sqliteDb.moduleDb('builder');

  tags.docs.put('shared', 'k', { who: 'tags' }, 0);
  builder.docs.put('shared', 'k', { who: 'builder' }, 0);

  assert.deepEqual(tags.docs.get('shared', 'k')?.json, { who: 'tags' });
  assert.deepEqual(builder.docs.get('shared', 'k')?.json, { who: 'builder' });
  assert.equal(tags.docs.list('shared', 10).length, 1, 'the module_id is bound, not spelled');
});

test('documents survive a close and re-open, which is the whole point of the store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-sqlite-'));
  const path = join(dir, 'bot.sqlite');

  const first = openSqlite(path, { now: () => FIXED_NOW });
  if (!first.ok) throw new Error('openSqlite failed');
  first.value.moduleDb('builder').docs.put('requests', 'r1', { state: 'building', runId: 7 }, 0);
  first.value.close();

  const second = openSqlite(path, { now: () => FIXED_NOW });
  if (!second.ok) throw new Error('re-open failed');
  // One hook, closing before removing: Windows refuses to delete an open database file.
  t.after(() => {
    second.value.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const back = second.value.moduleDb('builder').docs.get('requests', 'r1');
  assert.deepEqual(back?.json, { state: 'building', runId: 7 });
  assert.equal(back?.version, 1);
});

test('a docs write inside a rolled-back transaction is undone too', (t) => {
  const sqliteDb = tempDb(t);
  const db = sqliteDb.moduleDb('builder');
  assert.throws(() =>
    db.transaction(() => {
      db.docs.put('requests', 'r1', { state: 'pending' }, 0);
      throw new Error('nope');
    }),
  );
  assert.equal(db.docs.get('requests', 'r1'), undefined);
});
