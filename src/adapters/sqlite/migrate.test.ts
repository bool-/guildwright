/**
 * Runtime proof for the migration runner.
 *
 * The two claims that matter here and cannot be proven by `#core/migrate`'s pure unit tests:
 *
 *  1. A REJECTED migration leaves NOTHING behind - not the table it created, not a ledger row.
 *     A half-applied migration with a ledger entry is unrecoverable without hand-editing the
 *     database, which is the failure this whole mechanism exists to prevent.
 *  2. An ordinary `UNIQUE(...)` constraint does not trip the ownership check. SQLite creates
 *     `sqlite_autoindex_*` for it, and a naive `sqlite_master` diff reads that as "the module
 *     created an object outside its namespace" and refuses to boot.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { MigrationFile } from '#core/migrate';
import { sql } from '#core/sql';

import { openSqlite, type SqliteDb } from '#adapters/sqlite/db';
import {
  CORE_LEDGER_ID,
  appliedMigrations,
  forgetMigrations,
  migrationChecksum,
  readMigrationDir,
  runCoreMigrations,
  runMigrations,
} from '#adapters/sqlite/migrate';
import { CORE_TABLE_PREFIX, coreMigrationsDir } from '#adapters/system/schema';

const FIXED_NOW = 1_700_000_000_000;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'bot-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempDb(t: TestContext): SqliteDb {
  // NOT `tempDir(t)`: `after` hooks run in registration order, so a directory registered
  // first would be removed while the database file is still open - EPERM on Windows. One
  // hook, closing before removing, is the only ordering that works on every platform.
  const dir = mkdtempSync(join(tmpdir(), 'bot-migrate-'));
  const opened = openSqlite(join(dir, 'bot.sqlite'), { now: () => FIXED_NOW });
  if (!opened.ok) throw new Error(`openSqlite failed: ${opened.error.code}`);
  const db = opened.value;
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** A `MigrationFile` whose checksum is honestly computed, as the loader would. */
function file(name: string, text: string): MigrationFile {
  return { name, sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'), sql: text };
}

const CREATE_REQUESTS = file(
  '0001_requests.sql',
  `CREATE TABLE m_builder_requests (
     id         TEXT    NOT NULL PRIMARY KEY,
     guild_id   TEXT    NOT NULL,
     state      TEXT    NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX m_builder_requests_by_state ON m_builder_requests (state);`,
);

const ADD_RUNS = file(
  '0002_runs.sql',
  `CREATE TABLE m_builder_runs (
     run_id     INTEGER NOT NULL PRIMARY KEY,
     request_id TEXT    NOT NULL REFERENCES m_builder_requests(id)
   ) STRICT;`,
);

function tableNames(db: SqliteDb): readonly string[] {
  return db.connection
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => String(r['name']));
}

// ---------------------------------------------------------------------------------------

test('the runner applies pending migrations in name order and records them', (t) => {
  const db = tempDb(t);

  // Deliberately out of order on the way in: `planMigrations` sorts.
  const applied = runMigrations(db, 'builder', [ADD_RUNS, CREATE_REQUESTS]);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(applied.value, ['0001_requests.sql', '0002_runs.sql']);

  assert.deepEqual(tableNames(db), ['core_docs', 'core_migrations', 'm_builder_requests', 'm_builder_runs']);

  const ledger = appliedMigrations(db);
  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map((a) => ({ moduleId: a.moduleId, name: a.name, appliedAt: a.appliedAt })),
    [
      { moduleId: 'builder', name: '0001_requests.sql', appliedAt: FIXED_NOW },
      { moduleId: 'builder', name: '0002_runs.sql', appliedAt: FIXED_NOW },
    ],
  );
  assert.equal(ledger[0]?.sha256, CREATE_REQUESTS.sha256);
});

test('re-running is a no-op, which is the boot path on every restart', (t) => {
  const db = tempDb(t);
  const first = runMigrations(db, 'builder', [CREATE_REQUESTS]);
  assert.equal(first.ok, true);

  // Write a row, then re-run: an idempotent runner must not touch it.
  db.moduleDb('builder').execute(
    sql`INSERT INTO ${db.moduleDb('builder').table('requests')} (id, guild_id, state, updated_at)
        VALUES (${'r1'}, ${'g1'}, ${'pending'}, ${FIXED_NOW})`,
  );

  const second = runMigrations(db, 'builder', [CREATE_REQUESTS]);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.value, [], 'nothing pending means nothing applied');
  assert.equal(appliedMigrations(db).length, 1, 'and no duplicate ledger row');

  const n = db.moduleDb('builder').queryOne<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${db.moduleDb('builder').table('requests')}`,
  );
  assert.equal(n?.n, 1, 'existing data survives a re-run');
});

test('a third boot picks up only the newly added file', (t) => {
  const db = tempDb(t);
  assert.equal(runMigrations(db, 'builder', [CREATE_REQUESTS]).ok, true);
  const next = runMigrations(db, 'builder', [CREATE_REQUESTS, ADD_RUNS]);
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.deepEqual(next.value, ['0002_runs.sql']);
});

test('an edited applied migration aborts boot instead of diverging silently', (t) => {
  const db = tempDb(t);
  assert.equal(runMigrations(db, 'builder', [CREATE_REQUESTS]).ok, true);

  const edited = file('0001_requests.sql', `${CREATE_REQUESTS.sql}\n-- an innocent-looking tweak`);
  const out = runMigrations(db, 'builder', [edited]);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.kind, 'config');
  assert.equal(out.error.code, 'config.migrations.builder.0001_requests.sql');
  assert.match(out.error.nextStep, /Add a new numbered file/u);
});

test('a migration that creates an object outside its namespace is rejected AND rolled back', (t) => {
  const db = tempDb(t);
  const bad = file(
    '0001_bad.sql',
    `CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY) STRICT;
     CREATE TABLE requests (id TEXT PRIMARY KEY) STRICT;`,
  );

  const out = runMigrations(db, 'builder', [bad]);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.kind, 'config');
  assert.match(out.error.internal ?? '', /requests/u);

  // THE POINT OF THE TEST: nothing survived. Not the legal table, not the illegal one, and
  // above all not a ledger row that would make the next boot think it had been applied.
  assert.deepEqual(tableNames(db), ['core_docs', 'core_migrations']);
  assert.deepEqual(appliedMigrations(db), []);
  assert.equal(db.connection.isTransaction, false);
});

test('a syntactically broken migration is a config error, not a crash, and applies nothing', (t) => {
  const db = tempDb(t);
  const broken = file(
    '0001_broken.sql',
    `CREATE TABLE m_builder_requests (id TEXT PRIMARY KEY) STRICT;
     CREATE TABLE m_builder_oops (;`,
  );
  const out = runMigrations(db, 'builder', [broken]);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error.kind, 'config');
  assert.deepEqual(tableNames(db), ['core_docs', 'core_migrations']);
  assert.deepEqual(appliedMigrations(db), []);
});

test('a UNIQUE constraint does not trip the ownership check', (t) => {
  const db = tempDb(t);
  // SQLite silently creates `sqlite_autoindex_m_tags_tags_1` for this. A snapshot that did
  // not exclude the reserved `sqlite_` namespace would call that a foreign object and refuse
  // the single most ordinary migration in the repo.
  const withUnique = file(
    '0001_tags.sql',
    `CREATE TABLE m_tags_tags (
       guild_id TEXT NOT NULL,
       name     TEXT NOT NULL,
       body     TEXT NOT NULL,
       UNIQUE (guild_id, name)
     ) STRICT;`,
  );
  const out = runMigrations(db, 'tags', [withUnique]);
  assert.equal(out.ok, true, 'a UNIQUE constraint is not an ownership violation');
  assert.ok(
    db.connection.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_autoindex%'`).all().length > 0,
    'the autoindex really is created - the test would be vacuous otherwise',
  );
});

test('two modules keep separate ledgers', (t) => {
  const db = tempDb(t);
  assert.equal(runMigrations(db, 'builder', [CREATE_REQUESTS]).ok, true);
  const tags = runMigrations(db, 'tags', [file('0001_tags.sql', 'CREATE TABLE m_tags_tags (name TEXT PRIMARY KEY) STRICT;')]);
  assert.equal(tags.ok, true);
  if (!tags.ok) return;
  assert.deepEqual(tags.value, ['0001_tags.sql'], "another module's ledger row must not count as ours");
  assert.deepEqual(
    appliedMigrations(db).map((a) => `${a.moduleId}/${a.name}`),
    ['builder/0001_requests.sql', 'tags/0001_tags.sql'],
  );
});

test('forgetMigrations removes exactly one module’s ledger rows', (t) => {
  const db = tempDb(t);
  assert.equal(runMigrations(db, 'builder', [CREATE_REQUESTS, ADD_RUNS]).ok, true);
  assert.equal(runMigrations(db, 'tags', [file('0001_tags.sql', 'CREATE TABLE m_tags_tags (name TEXT PRIMARY KEY) STRICT;')]).ok, true);

  assert.equal(forgetMigrations(db, 'builder'), 2);
  assert.deepEqual(
    appliedMigrations(db).map((a) => a.moduleId),
    ['tags'],
  );
});

test('the migration ledger and the docs table exist on a freshly opened database', (t) => {
  const db = tempDb(t);
  assert.deepEqual(tableNames(db), ['core_docs', 'core_migrations']);
  assert.deepEqual(appliedMigrations(db), []);
});

// ---------------------------------------------------------------------------------------
// Reading the files off disk
// ---------------------------------------------------------------------------------------

test('readMigrationDir sorts by name, checksums bytes and ignores non-SQL files', (t) => {
  const dir = join(tempDir(t), 'migrations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE m_x_b (id TEXT PRIMARY KEY) STRICT;', 'utf8');
  writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE m_x_a (id TEXT PRIMARY KEY) STRICT;', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# not a migration', 'utf8');

  const out = readMigrationDir(dir);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(
    out.value.map((f) => f.name),
    ['0001_a.sql', '0002_b.sql'],
  );
  assert.equal(
    out.value[0]?.sha256,
    migrationChecksum(Buffer.from('CREATE TABLE m_x_a (id TEXT PRIMARY KEY) STRICT;', 'utf8')),
  );
  assert.match(out.value[1]?.sql ?? '', /m_x_b/u);
});

test('readMigrationDir treats a missing directory as "no migrations yet"', (t) => {
  const out = readMigrationDir(join(tempDir(t), 'does-not-exist'));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.value, []);
});

test('files read off disk apply end to end', (t) => {
  const dir = join(tempDir(t), 'migrations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0001_items.sql'), 'CREATE TABLE m_tags_items (name TEXT PRIMARY KEY) STRICT;', 'utf8');

  const files = readMigrationDir(dir);
  assert.equal(files.ok, true);
  if (!files.ok) return;

  const db = tempDb(t);
  const out = runMigrations(db, 'tags', files.value);
  assert.equal(out.ok, true);
  assert.ok(tableNames(db).includes('m_tags_items'));

  // And the same directory, read again, is now a no-op - the checksum is stable across reads.
  const again = readMigrationDir(dir);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  const second = runMigrations(db, 'tags', again.value);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.value, []);
});

// ---------------------------------------------------------------------------------------
// CORE AS A PSEUDO-MODULE.
//
// Core schema used to be one `CREATE TABLE IF NOT EXISTS` blob re-executed on every boot. That
// is idempotent and it is a dead end: an idempotent CREATE has nowhere to put an ALTER, so no
// core column could ever be added, renamed or dropped - not by a migration (core had no ledger)
// and not by editing the blob (a CREATE on an existing table is a silent no-op that leaves the
// old shape in place while the code believes the new one).
//
// The tests below pin the three properties that make the ledger real for core: it applies, it
// records, and a SECOND boot does nothing at all.
// ---------------------------------------------------------------------------------------

/** The tables the core ports read. If any of these is missing, the bot is a brick. */
const CORE_OWNED_TABLES = ['core_audit', 'core_jobs', 'core_ratelimits', 'core_settings', 'core_access'];

/**
 * Every core migration on disk, in ledger order.
 *
 * READ OFF THE DIRECTORY rather than typed out, because these tests are about the LEDGER - that
 * files apply once, in order, and record themselves. A hard-coded list would turn every future
 * `0003_*.sql` into a red test that says nothing about the property under test, which is how a
 * suite teaches people to edit assertions without reading them.
 */
function coreMigrationNames(): readonly string[] {
  const files = readMigrationDir(coreMigrationsDir());
  if (!files.ok) throw new Error('the core migrations directory is unreadable');
  return files.value.map((f) => f.name);
}

/** The columns of one table, as SQLite reports them. */
function columnsOf(db: SqliteDb, table: string): readonly string[] {
  const rows = db.connection.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((r) => String(r['name']));
}

function objectsIn(db: SqliteDb): readonly string[] {
  const rows = db.connection.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).all();
  return rows.map((r) => String(r['name']));
}

test('core migrations create every core-owned table and record a ledger row each', (t) => {
  const db = tempDb(t);
  const applied = runCoreMigrations(db);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual([...applied.value], [...coreMigrationNames()], 'every file on disk applies, in order');
  assert.equal(applied.value[0], '0001_init.sql', 'and 0001 is still first');

  const names = objectsIn(db);
  for (const table of CORE_OWNED_TABLES) {
    assert.ok(names.includes(table), `${table} must exist after the core migration`);
  }

  // THE LEDGER ROW IS THE POINT. Without it there is no "core is at 0001", so there is no
  // meaningful 0002, so a core column can never change. 0002 is the proof that was not
  // theoretical: it is an ALTER, which the old re-executed CREATE blob had nowhere to put.
  const ledger = appliedMigrations(db).filter((a) => a.moduleId === CORE_LEDGER_ID);
  assert.deepEqual(ledger.map((a) => a.name), [...coreMigrationNames()]);
  for (const row of ledger) assert.equal(row.sha256.length, 64);

  assert.ok(
    columnsOf(db, 'core_jobs').includes('started_at_ms'),
    '0002 adds the column /admin jobs needs to say how long the oldest running job has been running',
  );
});

test('a second boot applies nothing: the ledger, not the IF NOT EXISTS, is what makes it a no-op', (t) => {
  const db = tempDb(t);
  assert.equal(runCoreMigrations(db).ok, true);
  const again = runCoreMigrations(db);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual([...again.value], [], 'nothing pending on the second call');
  assert.equal(
    appliedMigrations(db).filter((a) => a.moduleId === CORE_LEDGER_ID).length,
    coreMigrationNames().length,
    'one ledger row per file, and no second copy of any of them',
  );
  // WHY THIS MATTERS MORE AT 0002 THAN IT DID AT 0001: `ALTER TABLE ... ADD COLUMN` has no
  // `IF NOT EXISTS` in SQLite, so a second application of 0002 does not no-op - it throws
  // "duplicate column name". The ledger is the ONLY thing between a restart and a boot failure,
  // which is exactly the property this test pins.
});

test('an EXISTING database - tables already there, no ledger - adopts 0001 and then ALTERs', (t) => {
  // THE UPGRADE PATH EVERY DEPLOYED BOT TAKES, and 0002 is the first release where it does more
  // than bookkeeping. Such a database was built by the old `CORE_SCHEMA_SQL` blob - which is
  // 0001, byte for byte, and nothing else - so the fixture executes exactly that one file.
  // Executing the whole directory would model a database that had somehow already been
  // migrated, which is the one starting state this test is not about.
  const db = tempDb(t);
  db.connection.exec(readMigrationText('0001_init.sql'));
  db.connection
    .prepare(`INSERT INTO core_settings (guild_id, key, value_json, updated_at_ms) VALUES (?, ?, ?, ?)`)
    .run('g1', 'k', '{}', FIXED_NOW);

  const applied = runCoreMigrations(db);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual([...applied.value], [...coreMigrationNames()], 'the files apply, so the ledger records them');

  const kept = db.connection.prepare(`SELECT COUNT(*) AS n FROM core_settings`).get();
  assert.equal(Number(kept?.['n']), 1, 'every statement in 0001 is IF NOT EXISTS, so nothing was recreated');

  // AND THE WHOLE REASON THE LEDGER WAS BUILT: 0002 is an `ALTER TABLE`, and it lands on a
  // pre-existing table without disturbing what is already in the database.
  assert.ok(columnsOf(db, 'core_jobs').includes('started_at_ms'));
});

test('core migrations are held to the core_ namespace, exactly as a module is to its own', (t) => {
  // The ownership assertion is not skipped for core; it is pointed at a different prefix. Every
  // object 0001 creates has to be `core_*`, which is what makes a future core-scoped cleanup
  // complete rather than approximate.
  const db = tempDb(t);
  assert.equal(runCoreMigrations(db).ok, true);
  const created = objectsIn(db).filter((n) => n !== 'core_docs' && n !== 'core_migrations');
  for (const name of created) {
    assert.ok(name.startsWith(CORE_TABLE_PREFIX), `${name} is outside the core namespace`);
  }
});

test('the core ledger id cannot collide with a real module id', () => {
  // `MODULE_ID_RE` is /^[a-z][a-z0-9-]{1,30}$/, so a module may legally be called `core`. If the
  // runner branched on `moduleId === 'core'` that module would be handed the `core_` ownership
  // prefix - i.e. permission to create `core_access`. The leading `@` makes the collision
  // unspellable rather than merely unlikely.
  assert.equal(CORE_LEDGER_ID, '@core');
  assert.equal(/^[a-z][a-z0-9-]{1,30}$/u.test(CORE_LEDGER_ID), false);
});

test('editing an applied core migration aborts boot, like any other edited migration', (t) => {
  const db = tempDb(t);
  assert.equal(runCoreMigrations(db).ok, true);
  // Same file NAME, different bytes: the ledger checksum no longer matches.
  const tampered = runMigrations(db, CORE_LEDGER_ID, [file('0001_init.sql', 'SELECT 1;')], {
    prefix: CORE_TABLE_PREFIX,
  });
  assert.equal(tampered.ok, false);
  if (tampered.ok) return;
  assert.ok(tampered.error.nextStep.includes('Never edit an applied migration'));
});

test('runMigrations still defaults to the module namespace when no prefix is given', (t) => {
  // The override is for exactly one caller. A module must not be able to reach `core_` by
  // omitting an argument, so the default has to stay `m_<id>_`.
  const db = tempDb(t);
  const r = runMigrations(db, 'tags', [file('0001.sql', 'CREATE TABLE core_evil (x INTEGER);')]);
  assert.equal(r.ok, false, 'a module creating a core_ table must be refused');
  if (r.ok) return;
  assert.ok(r.error.internal?.includes('core_evil'));
  assert.equal(objectsIn(db).includes('core_evil'), false, 'and the transaction rolled it back');
});

/** One shipped core migration's SQL, read the way an older deploy would have executed it. */
function readMigrationText(name: string): string {
  const files = readMigrationDir(coreMigrationsDir());
  if (!files.ok) throw new Error('the core migrations directory is unreadable');
  const found = files.value.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no core migration named ${name}`);
  return found.sql;
}
