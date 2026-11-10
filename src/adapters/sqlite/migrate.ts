/**
 * THE MIGRATION RUNNER - the SQLite half of `#core/migrate`.
 *
 * `planMigrations` decides WHAT to apply and `assertOwnership` decides whether what a
 * migration created was allowed. Both are pure and already unit-tested in core. This file
 * supplies the three things they cannot: the ledger, the transaction, and the two
 * `sqlite_master` snapshots the ownership diff is computed from.
 *
 * POSTMORTEMS THIS FILE CLOSES, beyond the ones core already closes:
 *
 *  (1) "The migration half-applied and the ledger row was written anyway."
 *      The DDL, the ownership check and the ledger INSERT are ONE transaction. SQLite is
 *      fully transactional for DDL, so a failure at statement 4 of 5 leaves nothing behind -
 *      verified by `migrate.test.ts`, which rolls back a bad migration and then asserts the
 *      table is absent AND the ledger is empty.
 *
 *  (2) "Ownership rejected a perfectly good migration because of an index nobody wrote."
 *      A `UNIQUE(a, b)` constraint makes SQLite create `sqlite_autoindex_m_x_t_1` - verified
 *      by execution. That name does NOT start with `m_<id>_`, so a naive snapshot makes
 *      `assertOwnership` reject the most ordinary migration there is. `objectNames` excludes
 *      the `sqlite_` reserved namespace, which is correct on its own terms: those objects are
 *      SQLite's, they are dropped with their table, and a module cannot name one.
 *
 *  (3) "Two machines disagreed about a checksum." The sha256 is over the file's BYTES. The
 *      repo pins `* text=auto eol=lf` in `.gitattributes` precisely so those bytes are the
 *      same on Windows and on a Linux runner; without it a CRLF checkout changes every
 *      checksum and `planMigrations` aborts boot on a file nobody edited.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { errors, type AppError } from '#core/errors';
import { assertOwnership, planMigrations, type AppliedMigration, type MigrationFile } from '#core/migrate';
import { Err, Ok, type Result } from '#core/result';
import { ident, sql, tablePrefixFor } from '#core/sql';

import { CORE_MIGRATIONS_TABLE, DbPortError, ensureCoreSchema, isDbPortError, type SqliteDb } from '#adapters/sqlite/db';
import { CORE_TABLE_PREFIX, coreMigrationsDir } from '#adapters/system/schema';

const LEDGER = ident(CORE_MIGRATIONS_TABLE);

/**
 * The ledger `module_id` under which CORE's own migrations are recorded.
 *
 * WHY `@core` AND NOT `core`: `MODULE_ID_RE` is `/^[a-z][a-z0-9-]{1,30}$/`, so a real module
 * may legally be called `core` - and if it were, it would share ledger rows with this
 * pseudo-module and, worse, any `moduleId === 'core'` branch in the runner would hand it the
 * `core_` ownership prefix, i.e. permission to create `core_access`. The leading `@` cannot
 * appear in a module id, so the collision is not merely unlikely, it is unspellable.
 *
 * The runner does not branch on this value at all; the prefix is passed explicitly by
 * `runCoreMigrations` below. This constant only names the ledger rows.
 */
export const CORE_LEDGER_ID = '@core';

/**
 * Every object in the database, EXCLUDING SQLite's own reserved namespace.
 *
 * WHY the exclusion is not a loophole: `sqlite_` is a reserved prefix - `CREATE TABLE
 * sqlite_anything` is refused by SQLite itself - so a module cannot hide an object here. What
 * it does exclude is `sqlite_autoindex_*`, which SQLite creates for a UNIQUE or non-INTEGER
 * PRIMARY KEY and destroys with the table.
 */
function objectNames(conn: DatabaseSync): readonly string[] {
  const rows = conn.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  const out: string[] = [];
  for (const row of rows) {
    const name = row['name'];
    if (typeof name === 'string') out.push(name);
  }
  return out;
}

/**
 * The whole ledger, for every module.
 * WHY not filtered by module here: `planMigrations` does that filtering itself, and reading
 * the lot makes `appliedMigrations` reusable by `/status` and by `drop:module`.
 */
export function appliedMigrations(db: SqliteDb): readonly AppliedMigration[] {
  ensureCoreSchema(db.connection);
  const rows = db.connection
    .prepare(`SELECT module_id, name, sha256, applied_at FROM ${CORE_MIGRATIONS_TABLE} ORDER BY module_id, name`)
    .all();
  const out: AppliedMigration[] = [];
  for (const row of rows) {
    const moduleId = row['module_id'];
    const name = row['name'];
    const sha256 = row['sha256'];
    const appliedAtRaw = row['applied_at'];
    if (typeof moduleId !== 'string' || typeof name !== 'string' || typeof sha256 !== 'string') continue;
    const appliedAt = typeof appliedAtRaw === 'bigint' ? Number(appliedAtRaw) : typeof appliedAtRaw === 'number' ? appliedAtRaw : 0;
    out.push({ moduleId, name, sha256, appliedAt });
  }
  return out;
}

export interface MigrationRunOptions {
  /**
   * The namespace every object these files create must be named in.
   *
   * DEFAULTS TO `tablePrefixFor(moduleId)`, which is what every module gets and what the
   * ownership rule has always meant. It is overridable for exactly one caller - core's own
   * migrations, which own `core_` - and it is an EXPLICIT PARAMETER rather than a branch on
   * `moduleId === 'core'` on purpose: a branch on the id would silently hand the `core_`
   * namespace to any module that managed to be called `core`, which is to say permission to
   * create `core_access`. Passing the prefix means the grant is written at the call site,
   * where a reviewer reads it.
   */
  readonly prefix?: string;
}

/**
 * Apply a module's pending migrations. Returns the names actually applied, in order.
 *
 * IDEMPOTENT BY CONSTRUCTION: a second call sees every file in the ledger with a matching
 * checksum, `planMigrations` returns an empty list, and this function does nothing at all -
 * no transaction, no DDL, no ledger write. That is the boot path on every restart.
 *
 * WHY it takes a `SqliteDb` and not a bare connection: `db.transaction` owns the savepoint
 * depth, so a migration run nested inside any other transaction still unwinds correctly.
 */
export function runMigrations(
  db: SqliteDb,
  moduleId: string,
  files: readonly MigrationFile[],
  options: MigrationRunOptions = {},
): Result<readonly string[], AppError> {
  ensureCoreSchema(db.connection);

  const plan = planMigrations(moduleId, files, appliedMigrations(db));
  if (!plan.ok) return plan;
  if (plan.value.length === 0) return Ok([]);

  const prefix = options.prefix ?? tablePrefixFor(moduleId);
  const applied: string[] = [];

  for (const file of plan.value) {
    const before = objectNames(db.connection);
    try {
      db.transaction((): void => {
        // Raw `exec`: this is DDL, and `DbPort` structurally refuses CREATE/DROP/ALTER. That
        // asymmetry is the point - schema changes live in ./migrations/*.sql, not in a module.
        db.connection.exec(file.sql);

        const owned = assertOwnership(moduleId, prefix, before, objectNames(db.connection));
        // Thrown, not returned: throwing is what makes `db.transaction` roll the DDL back.
        // `DbPortError` carries the `AppError` intact through the unwind.
        if (!owned.ok) throw new DbPortError(owned.error);

        db.connection
          .prepare(
            `INSERT INTO ${CORE_MIGRATIONS_TABLE} (module_id, name, sha256, applied_at) VALUES (?, ?, ?, ?)`,
          )
          .run(moduleId, file.name, file.sha256, db.now());
      });
    } catch (cause: unknown) {
      if (isDbPortError(cause)) return Err(cause.appError);
      return Err(
        errors.config(
          `migrations.${moduleId}.${file.name}`,
          `failed to apply: ${cause instanceof Error ? cause.message : 'unknown'}`,
          'Fix the migration file and restart. Nothing from it was applied.',
        ),
      );
    }
    applied.push(file.name);
  }

  return Ok(applied);
}

/**
 * Apply CORE's own migrations, from `src/core/migrations/`.
 *
 * THE ONE THING THIS CHANGES ON AN EXISTING DATABASE IS A LEDGER ROW. `0001_init.sql` is the
 * former `CORE_SCHEMA_SQL` moved verbatim, every statement `IF NOT EXISTS`, so applying it to a
 * database that already has these tables executes a run of no-ops and then records that core is
 * at 0001. From the next boot onward `0002_*.sql` may be an `ALTER TABLE`, which is the entire
 * reason this exists: until now no core column could be added, renamed or dropped by any means
 * at all.
 *
 * ORDER MATTERS AND IT IS THE CALLER'S JOB: run this BEFORE module migrations. A module's
 * migration may reference nothing of core's, but core's tables are what every core port reads,
 * and a module's `setup` runs after both.
 *
 * OWNERSHIP IS ASSERTED, not assumed. `assertOwnership` diffs `sqlite_master` around each file
 * and refuses any created object not named `core_*` - exactly the check a module gets against
 * `m_<id>_*`. Core is held to its own namespace for the same reason a module is: so
 * `drop:module` and any future core-scoped cleanup can be complete rather than approximate.
 */
export function runCoreMigrations(db: SqliteDb): Result<readonly string[], AppError> {
  const dir = coreMigrationsDir();
  const files = readMigrationDir(dir);
  if (!files.ok) return files;
  if (files.value.length === 0) {
    // `readMigrationDir` answers `Ok([])` for a missing directory, which is correct for a
    // MODULE - a module with no migrations is legal. For core it means the shipped schema is
    // not on disk, and the next thing to happen would be every core port failing on a table
    // that does not exist. That is a broken install, and it is worth one clear sentence at boot
    // rather than five SQLite errors a minute later.
    return Err(
      errors.config(
        `migrations.${CORE_LEDGER_ID}`,
        `no .sql files found in ${dir}`,
        'Restore src/core/migrations/ from the repository; the core schema lives there, not in the code.',
      ),
    );
  }
  return runMigrations(db, CORE_LEDGER_ID, files.value, { prefix: CORE_TABLE_PREFIX });
}

/**
 * Forget a module's ledger rows.
 *
 * WHY it exists here rather than in a script: `drop:module` has to remove the ledger in the
 * same place that wrote it, and doing it through `db.coreDb()` keeps the `core_*` grant in
 * one file instead of two.
 */
export function forgetMigrations(db: SqliteDb, moduleId: string): number {
  ensureCoreSchema(db.connection);
  return db.coreDb().execute(sql`DELETE FROM ${LEDGER} WHERE module_id = ${moduleId}`).changes;
}

/** Lower-case hex sha256, over BYTES. See the `.gitattributes` note at the top of this file. */
export function migrationChecksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read `<dir>/*.sql` into `MigrationFile`s, sorted by name.
 *
 * A MISSING DIRECTORY IS `Ok([])`, NOT AN ERROR: `migrations: true` on a module means "apply
 * them if there are any", and a module whose first migration has not been written yet must
 * still boot. A directory that exists but cannot be read IS an error, because that is a
 * permissions problem an operator has to fix.
 */
export function readMigrationDir(dir: string): Result<readonly MigrationFile[], AppError> {
  let entries: readonly string[];
  try {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return Ok([]);
    entries = readdirSync(dir);
  } catch (cause: unknown) {
    return Err(
      errors.config(
        `migrations.${dir}`,
        `cannot read: ${cause instanceof Error ? cause.message : 'unknown'}`,
        'Make the migrations directory readable by the bot process and restart.',
      ),
    );
  }

  const files: MigrationFile[] = [];
  for (const name of [...entries].sort((a, b) => a.localeCompare(b))) {
    if (!name.toLowerCase().endsWith('.sql')) continue;
    try {
      const bytes = readFileSync(join(dir, name));
      files.push({ name, sha256: migrationChecksum(bytes), sql: bytes.toString('utf8') });
    } catch (cause: unknown) {
      return Err(
        errors.config(
          `migrations.${dir}.${name}`,
          `cannot read: ${cause instanceof Error ? cause.message : 'unknown'}`,
          'Make the migration file readable by the bot process and restart.',
        ),
      );
    }
  }
  return Ok(files);
}
