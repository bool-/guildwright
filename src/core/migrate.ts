/**
 * Migration types and the ownership assertion.
 *
 * POSTMORTEM THIS FILE CLOSES: "someone edited an already-applied migration and the two
 * environments diverged silently", and its twin, "a module created a table called `tags`
 * instead of `m_tags_tags`, so `npm run drop:module` left it behind and a re-added module with
 * the same id inherited a booby-trapped ledger."
 *
 * WHY the checksum and the ownership diff are TYPES in core and not prose in a runbook: both
 * earlier designs described the mechanism in section 7.3 and gave it no representation at all,
 * so nothing could test it. `applyOwnership` is pure and unit-tested.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';

/** One `./migrations/*.sql` file. `sha256` is recomputed at boot and compared to the ledger. */
export interface MigrationFile {
  /** File name, e.g. `0001_requests.sql`. Sorted by this. */
  readonly name: string;
  /** Lower-case hex sha256 of the file's bytes. */
  readonly sha256: string;
  /** The statements. WHY a plain string: this is DDL, it never carries a user value, and it
   *  is deliberately NOT a `SqlQuery` - a module must not be able to hand this to `db.execute`. */
  readonly sql: string;
}

/** One row of `core_migrations`. */
export interface AppliedMigration {
  readonly moduleId: string;
  readonly name: string;
  readonly sha256: string;
  readonly appliedAt: number;
}

/**
 * Decide what to apply, and abort on edited history.
 *
 * WHY abort rather than re-apply: an edited applied migration means two environments have
 * different schemas under the same ledger entry, and every subsequent diagnosis is wrong.
 */
export function planMigrations(
  moduleId: string,
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): Result<readonly MigrationFile[], AppError> {
  const byName = new Map(applied.filter((a) => a.moduleId === moduleId).map((a) => [a.name, a]));
  const pending: MigrationFile[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const prior = byName.get(f.name);
    if (prior === undefined) {
      pending.push(f);
      continue;
    }
    if (prior.sha256 !== f.sha256) {
      return Err(
        errors.config(
          `migrations.${moduleId}.${f.name}`,
          `checksum changed: ledger has ${prior.sha256}, file is ${f.sha256}`,
          'Never edit an applied migration. Add a new numbered file instead.',
        ),
      );
    }
  }
  return Ok(pending);
}

/**
 * Assert every object a module's migrations created is named `m_<id>_*`.
 *
 * WHY it takes two `sqlite_master` snapshots: this is a DIFF, not a scan, so a module cannot
 * be blamed for objects that already existed, and the check needs no SQL parser. Ownership
 * becomes mechanical instead of conventional.
 */
export function assertOwnership(
  moduleId: string,
  prefix: string,
  before: readonly string[],
  after: readonly string[],
): Result<void, AppError> {
  const existing = new Set(before);
  const created = after.filter((n) => !existing.has(n));
  const foreign = created.filter((n) => !n.startsWith(prefix));
  if (foreign.length === 0) return Ok(undefined);
  return Err(
    errors.config(
      `migrations.${moduleId}`,
      `created objects outside its namespace: ${foreign.join(', ')}`,
      `Rename them to start with "${prefix}". Boot asserts this so drop:module can clean up completely.`,
    ),
  );
}
