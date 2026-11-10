/**
 * WHERE THE CORE SCHEMA LIVES, AND WHY IT IS NO LONGER A STRING IN THIS FILE.
 *
 * It used to be `CORE_SCHEMA_SQL`: one `CREATE TABLE IF NOT EXISTS` blob, re-executed against
 * the raw connection on every boot. That was idempotent and it was a dead end. An idempotent
 * CREATE has nowhere to put an ALTER, so NO core column could ever be added, renamed or
 * dropped - not by a migration, because core had no ledger, and not by editing the blob,
 * because `CREATE TABLE IF NOT EXISTS` on an existing table is a silent no-op that leaves the
 * old shape in place while the code believes the new one. Two fixes on the roadmap need a core
 * column, and both were blocked on that.
 *
 * So core is now a PSEUDO-MODULE in the ledger modules already use: numbered `.sql` files under
 * `src/core/migrations/`, checksummed, one transaction each, ownership asserted - against the
 * `core_` prefix rather than `m_<id>_`. See `#adapters/sqlite/migrate`, which owns the runner
 * and the `@core` ledger id.
 *
 * WHY THE DDL IS A PLAIN STRING AND NOT A `SqlQuery`: unchanged, and still the point.
 * `checkTableOwnership` BANS `CREATE`/`ALTER`/`DROP` on every statement that goes through a
 * `DbPort`, deliberately - a port that could create a table could create `core_access`. Schema
 * comes from the migration runner, which holds the raw connection; these adapters only ever
 * issue DML.
 *
 * WHY the table names are derived from `db.tablePrefix` at runtime rather than spelled here:
 * the adapters name tables through `db.table('jobs')`, so wiring them to a differently-scoped
 * `DbPort` in a test cannot silently write the production tables. Wire them to a `DbPort`
 * whose `tablePrefix` is `core_` and the names below are what you get.
 *
 * WHY `core_jobs` carries `lease_owner`/`lease_until_ms` and an `attempts` counter that is
 * incremented AT CLAIM: a job that kills the process on every attempt would otherwise be
 * immortal - it never reaches a failure handler, so it never spends an attempt, so it is
 * re-queued forever. Counting at claim makes a poison job terminal after `maxAttempts` boots.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The prefix a core-scoped `DbPort` must carry, so `db.table('jobs')` is `core_jobs`. */
export const CORE_TABLE_PREFIX = 'core_';

/**
 * The suffixes passed to `db.table(...)`. WHY constants: a typo would mint a real-looking
 * identifier for a table that does not exist, and the failure would arrive at 3am as a
 * SQLite error rather than at review as a diff.
 */
export const CORE_TABLES = {
  audit: 'audit',
  jobs: 'jobs',
  settings: 'settings',
  access: 'access',
} as const;

/**
 * `src/core/migrations/`, resolved from THIS file rather than from `process.cwd()`.
 *
 * WHY: `npm start` runs from the repo root and a systemd unit does not have to. A cwd-relative
 * path turns "the operator started the bot from the wrong directory" into "the core schema
 * silently has no migrations", which `readMigrationDir` reports as `Ok([])` - a missing
 * directory is legal for a module, so it would not even be loud. Resolving from
 * `import.meta.url` makes the directory exactly as findable as the code that needs it.
 */
export function coreMigrationsDir(): string {
  return fileURLToPath(new URL('../../core/migrations/', import.meta.url));
}

/**
 * Every core migration's DDL, in ledger order, concatenated.
 *
 * FOR TESTS AND FOR `createTestDb` ONLY - the boot path goes through `runCoreMigrations`, which
 * applies the same files one transaction at a time and records each in `core_migrations`. This
 * function is the shortcut for a test that wants the TABLES and does not care about the ledger,
 * and it exists so there is still exactly ONE definition of the core schema: those files.
 * Re-typing the DDL into a test fixture is how a test ends up proving something about a schema
 * that production does not have.
 */
export function coreSchemaSql(): string {
  const dir = coreMigrationsDir();
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}
