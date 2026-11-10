/**
 * TEST SUPPORT: a real `node:sqlite` `DbPort`, core-scoped.
 *
 * WHY a REAL database and not the in-memory fake from `#testing/fakes`: that fake answers
 * every `query` with `[]` and every `execute` with `changes: 1`, which is perfect for asserting
 * on statement TEXT and useless for asserting on the properties this runtime actually has to
 * hold - a compare-and-set that reports `changes: 0` to the loser, a partial UNIQUE index that
 * makes a second enqueue return the FIRST job's id, and a row that is still there after the
 * "process" restarts. Every one of those is a database behaviour, so the tests use a database.
 *
 * WHY it lives beside the adapters and not in `#testing/fakes`: it imports `node:sqlite`, which
 * modules and the shared fakes may not, and the production `DbPort` (`src/adapters/sqlite/`)
 * is owned by the persistence adapter - this is the narrow slice the system adapters need to
 * prove themselves against, not a competing implementation.
 *
 * It applies the SAME `checkTableOwnership` rule the production port must, with
 * `allowCore: true`, so a statement that would be refused in production is refused here too.
 */

import { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '#core/json';
import { isJsonObject } from '#core/json';
import type { DbPort, DocRecord, WriteResult } from '#core/ports';
import { checkTableOwnership, ident, renderSql, type SqlIdent, type SqlQuery, type SqlValue } from '#core/sql';
import { CORE_TABLE_PREFIX, coreSchemaSql } from '#adapters/system/schema';

/** The port, plus what a test needs: the statement log, and a way to close the handle. */
export interface TestDb extends DbPort {
  /** Every statement that reached the driver, in order. Used to prove "append only". */
  readonly statements: readonly string[];
  /** Forget the recorded statements, so one test can assert about one phase. */
  clearStatements(): void;
  /** Raw DDL, the way a migration runner would apply it. Never reachable from a `DbPort`. */
  exec(ddl: string): void;
  close(): void;
}

/**
 * WHY the prefix defaults to `core_`: these adapters are the CORE-owned ports, and wiring one
 * to a module-scoped port by accident should be visible in the test, not silent.
 */
export function createTestDb(prefix: string = CORE_TABLE_PREFIX): TestDb {
  const handle = new DatabaseSync(':memory:');
  handle.exec('PRAGMA foreign_keys = ON');
  // The DDL comes from `src/core/migrations/*.sql` - the same files the boot path applies
  // through the ledger - so a test database cannot drift from the production schema. The
  // LEDGER is skipped deliberately: these tests are about the system adapters, not about
  // migration bookkeeping, which `migrate.test.ts` owns.
  handle.exec(coreSchemaSql());
  const statements: string[] = [];
  const docs = new Map<string, DocRecord>();
  let depth = 0;

  function prepare(q: SqlQuery): { readonly text: string; readonly params: readonly SqlValue[] } {
    const owned = checkTableOwnership(q, prefix, { allowCore: true });
    if (!owned.ok) {
      // Throwing is right in a test double: a statement the production port would refuse must
      // fail the test that wrote it, loudly, at the line that wrote it.
      throw new Error(`checkTableOwnership refused this statement: ${owned.error.nextStep}`);
    }
    const rendered = renderSql(q);
    statements.push(rendered.text);
    return rendered;
  }

  /** `node:sqlite` binds null, number, bigint, string and Uint8Array - but not booleans. */
  function bind(params: readonly SqlValue[]): readonly (null | number | bigint | string | Uint8Array)[] {
    return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
  }

  return {
    tablePrefix: prefix,
    statements,

    table(name: string): SqlIdent {
      return ident(`${prefix}${name}`);
    },
    column(name: string): SqlIdent {
      return ident(name);
    },

    query<T>(q: SqlQuery): readonly T[] {
      const { text, params } = prepare(q);
      return rowsAs<T>(handle.prepare(text).all(...bind(params)));
    },

    queryOne<T>(q: SqlQuery): T | undefined {
      const { text, params } = prepare(q);
      const row = handle.prepare(text).get(...bind(params));
      return row === undefined ? undefined : rowsAs<T>([row])[0];
    },

    execute(q: SqlQuery): WriteResult {
      const { text, params } = prepare(q);
      const res = handle.prepare(text).run(...bind(params));
      return { changes: Number(res.changes), lastInsertRowid: res.lastInsertRowid };
    },

    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction: the enqueue of a poll job must be atomic with
      // the state change that justified it, and that composition has to be expressible.
      if (depth > 0) return fn();
      depth += 1;
      handle.exec('BEGIN');
      try {
        const out = fn();
        handle.exec('COMMIT');
        return out;
      } catch (cause: unknown) {
        handle.exec('ROLLBACK');
        throw cause;
      } finally {
        depth -= 1;
      }
    },

    docs: {
      get: (collection, key) => docs.get(`${collection}/${key}`),
      put: (collection, key, json, expectedVersion) => {
        const cur = docs.get(`${collection}/${key}`);
        if ((cur?.version ?? 0) !== expectedVersion) return false;
        docs.set(`${collection}/${key}`, { json, version: expectedVersion + 1, updatedAt: 0 });
        return true;
      },
      del: (collection, key) => docs.delete(`${collection}/${key}`),
      list: (collection, limit) => {
        const out: { readonly key: string; readonly json: JsonObject }[] = [];
        for (const [k, v] of docs) {
          if (!k.startsWith(`${collection}/`)) continue;
          if (out.length >= limit) break;
          out.push({ key: k.slice(collection.length + 1), json: v.json });
        }
        return out;
      },
    },

    clearStatements(): void {
      statements.length = 0;
    },
    exec(ddl: string): void {
      handle.exec(ddl);
    },
    close(): void {
      handle.close();
    },
  };
}

/**
 * The one widening in this file, isolated so it can be read in one place.
 *
 * `DbPort.query<T>` types `T` as the CALLER's assertion about the row - core's own comment
 * says so - and the driver hands back `Record<string, SQLOutputValue>`. No implementation of
 * this port, here or in production, can bridge those two without one widening. What makes it
 * safe is what happens next: every system adapter re-proves each column it reads through
 * `rows.ts`, so a row written by an older deploy is a SKIPPED row, not a wrong one.
 */
function rowsAs<T>(rows: readonly Record<string, unknown>[]): readonly T[] {
  return rows as readonly T[];
}

/** WHY exported: a couple of tests read a column directly to prove what the adapter wrote. */
export function readRow(db: TestDb, q: SqlQuery): JsonObject | undefined {
  const row = db.queryOne<unknown>(q);
  return isJsonObject(row) ? row : undefined;
}
