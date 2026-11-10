/**
 * THE SQLITE ADAPTER - the real `DbPort`, on `node:sqlite`.
 *
 * It implements `#core/ports/db` exactly and adds nothing to the interface a module can see.
 * Everything below the `DbPort` boundary (the connection, the statement cache, the core
 * tables) is reachable only from the composition root, which is what keeps
 * `capabilities: ['db']` a bounded grant rather than "the whole file".
 *
 * VERIFIED ON NODE v24.16.0 (2026-09-02), by execution, not memory:
 *  - `DatabaseSync` needs no native build. `PRAGMA journal_mode = WAL` on a file database
 *    reports `wal`; on `:memory:` it stays `memory`, which is correct and not an error.
 *  - COMPARE-AND-SET: the first guarded `UPDATE` reports `changes === 1`, the second
 *    `changes === 0`. That is the whole defence against a double-clicked Approve, and
 *    `db.test.ts` asserts exactly those two numbers.
 *  - `changes` and `lastInsertRowid` are `number | bigint`. `WriteResult.changes` is
 *    `number`, so it is narrowed here, once, instead of at every call site.
 *  - A JS `boolean` CANNOT be bound: `stmt.run(true)` throws "Provided value cannot be bound
 *    to SQLite parameter 1". `SqlValue` includes `boolean`, so `toBind` maps it to 1/0. That
 *    one line is the difference between a working `WHERE approved = ${true}` and a crash.
 *  - `PRAGMA foreign_keys = ON` really rejects an orphan child row (ERR_SQLITE_ERROR).
 *  - `synchronous` defaults to FULL (2) under WAL and is DELIBERATELY LEFT THERE. The usual
 *    `synchronous = NORMAL` tuning trades a machine-level crash for throughput, and approval
 *    state is not a thing to lose. WAL alone already bounds a *process* kill to the in-flight
 *    transaction; FULL extends that to a power cut.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO:
 *  - It never retries. `DbPort.execute` says so: a transparently retried `UPDATE` is how an
 *    idempotent-looking write happens twice (SC-10). SQLITE_BUSY is handled by SQLite's own
 *    `busy_timeout`, which BLOCKS on the lock and then fails - it does not re-run the
 *    statement.
 *  - It never builds statement text from a value. Every statement a module can reach arrives
 *    as a `SqlQuery` from `#core/sql`; the only text this file interpolates is a numeric
 *    pragma argument and identifiers minted by `ident`.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';

import { errors, operatorMessage, type AppError } from '#core/errors';
import { isJsonObject, type JsonObject } from '#core/json';
import type { DbPort, DocRecord, DocStore, WriteResult } from '#core/ports/db';
import { Err, Ok, type Result } from '#core/result';
import {
  checkTableOwnership,
  ident,
  renderSql,
  sql,
  tablePrefixFor,
  type SqlIdent,
  type SqlQuery,
  type SqlValue,
} from '#core/sql';

// ---------------------------------------------------------------------------------------
// The throwable
// ---------------------------------------------------------------------------------------

/**
 * How a `DbPort` reports failure.
 *
 * WHY a throw and not a `Result`: the port is synchronous and returns bare rows, so there is
 * no failure arm to return. `ident` already sets that precedent for a programmer error, and
 * an ownership violation IS a programmer error. Everything a caller could want is on
 * `appError`, so the router's top-level guard can render it with `userMessage` and log it
 * with `operatorMessage` - the raw SQLite message never reaches a user.
 *
 * WHY a class and not a tagged object: `instanceof` survives being re-thrown through
 * `transaction`, which is the exact path an ownership violation takes.
 */
export class DbPortError extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(operatorMessage(appError));
    this.name = 'DbPortError';
    this.appError = appError;
  }
}

/** WHY exported: the migration runner and the router both branch on it. */
export function isDbPortError(cause: unknown): cause is DbPortError {
  return cause instanceof DbPortError;
}

// ---------------------------------------------------------------------------------------
// Core-owned tables
// ---------------------------------------------------------------------------------------

/** The prefix the CORE ports (audit, jobs, settings, access) own. */
export const CORE_TABLE_PREFIX = 'core_';

/** The document store's table. Namespaced by a BOUND `module_id`, never by its name. */
export const CORE_DOCS_TABLE = 'core_docs';

/** The applied-migrations ledger. */
export const CORE_MIGRATIONS_TABLE = 'core_migrations';

/**
 * The two tables the runtime owns before any module migration runs.
 *
 * `STRICT` is on both: a typo that writes a string into `version` should be an error at the
 * write, not a surprise at the read three weeks later.
 *
 * WHY `core_docs` is keyed on `(module_id, collection, key)` with `module_id` BOUND: it makes
 * the zero-migration store namespaced by construction. A module holding `db` cannot spell
 * another module's `module_id`, because it never supplies one - the adapter binds the id the
 * loader gave it.
 */
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${CORE_DOCS_TABLE} (
  module_id  TEXT    NOT NULL,
  collection TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  json       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (module_id, collection, key)
) STRICT;

CREATE TABLE IF NOT EXISTS ${CORE_MIGRATIONS_TABLE} (
  module_id  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (module_id, name)
) STRICT;
`;

/**
 * Create the core tables if they are absent. Idempotent.
 * WHY exported: the migration runner refuses to touch a database whose ledger does not exist,
 * and a test that opens a bare connection needs the same one line the boot path runs.
 */
export function ensureCoreSchema(conn: DatabaseSync): void {
  conn.exec(CORE_SCHEMA);
}

// ---------------------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------------------

/** WHY a cap: a module that builds statement text in a loop would otherwise leak statements. */
const STATEMENT_CACHE_MAX = 256;

/** SQLite primary result codes we can act on. `errcode` is the EXTENDED code, so mask it. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT = 19;

/** Mutable per-connection state. One instance per open database, shared by every port. */
interface Conn {
  readonly db: DatabaseSync;
  readonly cache: Map<string, StatementSync>;
  readonly now: () => number;
  /** Transaction nesting depth. Shared, because every module port is the same connection. */
  depth: number;
}

/**
 * `SqlValue` -> something `node:sqlite` will actually bind.
 *
 * The ONLY interesting case is `boolean`, which `node:sqlite` refuses outright (verified).
 * SQLite has no boolean type; 1/0 is what `WHERE approved = 1` compares against.
 */
function toBind(v: SqlValue): SQLInputValue {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

/**
 * THE ONE UNCHECKED CONVERSION IN THIS ADAPTER.
 *
 * `DbPort.query<T>` lets the caller name the row shape, and SQLite hands back
 * `Record<string, SQLOutputValue>`. No runtime evidence connects the two, and the port's own
 * doc comment calls this out ("`T` describes the row shape; see the honesty note"). Isolating
 * it in one function means a reviewer greps for `rowAs` and sees the entire extent of the
 * trust, instead of finding a cast at every call site.
 *
 * WHY IT COPIES, which looks gratuitous and is not: `node:sqlite` returns every row with a
 * NULL PROTOTYPE - verified, and it is why `assert.deepStrictEqual(row, { id: 1 })` fails
 * with a diff that prints two identical objects. Handing that to a module would make every
 * module's first repo test fail for a reason nobody guesses in under twenty minutes. The
 * spread restores `Object.prototype`.
 *
 * WHY THE SPREAD IS SAFE against a column aliased `__proto__`: object spread performs
 * CreateDataProperty, i.e. it DEFINES an own property rather than assigning through the
 * setter, so `SELECT x AS "__proto__"` produces a harmless own key, not prototype pollution.
 * `Object.assign` would NOT be safe here, which is exactly why it is not used.
 */
function rowAs<T>(row: Record<string, SQLOutputValue>): T {
  return { ...row } as T;
}

/** Turn a thrown `node:sqlite` error into an `AppError` that says what to do next. */
function sqliteFailure(cause: unknown, statement: string): DbPortError {
  const errcode = typeof cause === 'object' && cause !== null && 'errcode' in cause && typeof cause.errcode === 'number'
    ? cause.errcode
    : 0;
  const primary = errcode & 0xff;
  // The statement TEXT is operator-only context and structurally carries no bound value:
  // `#core/sql` puts every value in `params`. So this is safe to keep in `internal`, which
  // `userMessage` cannot read.
  const detail = `${cause instanceof Error ? cause.message : 'unknown'} [${statement}]`;

  if (primary === SQLITE_CONSTRAINT) {
    return new DbPortError(
      errors.conflict('sqlite.constraint', 'That change conflicts with something already stored.', 'Reload the card and try again.', 'constraint'),
    );
  }
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
    // busy_timeout already blocked for its full budget before this was raised, so this is a
    // genuinely stuck writer, not a transient blip - but it IS retryable at the job level.
    return new DbPortError(errors.unavailable('database', 'Try again in a few seconds.'));
  }
  return new DbPortError(errors.upstream('sqlite', 0, 'Try again; if it keeps happening, tell an admin.', detail));
}

/** Prepare-and-cache. Statements belong to a connection, and there is exactly one. */
function prepareCached(c: Conn, text: string): StatementSync {
  const hit = c.cache.get(text);
  if (hit !== undefined) {
    // Move to the end: `Map` preserves insertion order, so this is the whole LRU.
    c.cache.delete(text);
    c.cache.set(text, hit);
    return hit;
  }
  let stmt: StatementSync;
  try {
    stmt = c.db.prepare(text);
  } catch (cause: unknown) {
    throw sqliteFailure(cause, text);
  }
  c.cache.set(text, stmt);
  if (c.cache.size > STATEMENT_CACHE_MAX) {
    const oldest = c.cache.keys().next();
    if (oldest.done !== true) c.cache.delete(oldest.value);
  }
  return stmt;
}

function bindParams(params: readonly SqlValue[]): SQLInputValue[] {
  return params.map(toBind);
}

/** Read many. NOT ownership-checked: only the core-owned statements below reach it directly. */
function allRows(c: Conn, q: SqlQuery): Record<string, SQLOutputValue>[] {
  const { text, params } = renderSql(q);
  const stmt = prepareCached(c, text);
  try {
    return stmt.all(...bindParams(params));
  } catch (cause: unknown) {
    throw sqliteFailure(cause, text);
  }
}

/** Read one. */
function oneRow(c: Conn, q: SqlQuery): Record<string, SQLOutputValue> | undefined {
  const { text, params } = renderSql(q);
  const stmt = prepareCached(c, text);
  try {
    return stmt.get(...bindParams(params));
  } catch (cause: unknown) {
    throw sqliteFailure(cause, text);
  }
}

/**
 * Write.
 *
 * `changes` is narrowed to `number` HERE so a compare-and-set reads `r.changes === 1` and not
 * `Number(r.changes) === 1`. `lastInsertRowid` keeps its `number | bigint` union because
 * `WriteResult` declares it that way and a rowid past 2^53 is a real thing.
 */
function runWrite(c: Conn, q: SqlQuery): WriteResult {
  const { text, params } = renderSql(q);
  const stmt = prepareCached(c, text);
  try {
    const r = stmt.run(...bindParams(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  } catch (cause: unknown) {
    throw sqliteFailure(cause, text);
  }
}

/**
 * One transaction, synchronously, with nesting.
 *
 * WHY `BEGIN IMMEDIATE` and not plain `BEGIN`: a deferred transaction takes a read lock first
 * and upgrades on the first write, and an upgrade CANNOT wait on `busy_timeout` - SQLite
 * returns SQLITE_BUSY immediately, because waiting would deadlock. `IMMEDIATE` takes the
 * write lock up front, where `busy_timeout` does apply. This is the difference between a
 * bounded wait and a random failure under concurrency.
 *
 * WHY savepoints for nesting: a durable-job enqueue must be atomic with the state change that
 * justified it, and both are already inside a repo-level transaction half the time. Without
 * savepoints the inner `BEGIN` throws "cannot start a transaction within a transaction".
 *
 * WHY the rollback is itself guarded: SQLite auto-rolls-back on some errors, and a second
 * ROLLBACK would then throw and REPLACE the real cause with a meaningless one.
 */
function runTransaction<T>(c: Conn, fn: () => T): T {
  const outer = c.depth === 0;
  const savepoint = `core_sp_${c.depth}`;
  c.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  c.depth += 1;
  let out: T;
  try {
    out = fn();
  } catch (cause: unknown) {
    c.depth -= 1;
    try {
      if (outer) c.db.exec('ROLLBACK');
      else {
        c.db.exec(`ROLLBACK TO ${savepoint}`);
        c.db.exec(`RELEASE ${savepoint}`);
      }
    } catch (ignored: unknown) {
      // SQLite already unwound it. Losing THIS error keeps the caller's cause intact.
      void ignored;
    }
    throw cause;
  }
  c.depth -= 1;
  c.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
  return out;
}

// ---------------------------------------------------------------------------------------
// The document store
// ---------------------------------------------------------------------------------------

const DOCS: SqlIdent = ident(CORE_DOCS_TABLE);

/** Parse a stored document back, refusing anything that is not a JSON object. */
function readDocJson(raw: SQLOutputValue): JsonObject | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (ignored: unknown) {
    void ignored;
    return null;
  }
  return isJsonObject(parsed) ? parsed : null;
}

function readInt(raw: SQLOutputValue): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  return 0;
}

/**
 * The zero-migration store, namespaced to one module.
 *
 * These statements are minted HERE, in core-owned adapter code, and therefore skip
 * `checkTableOwnership` - which is the point: `core_docs` is not `m_<id>_*`, and a module must
 * still be able to use it. The namespacing is not a naming convention, it is a BOUND
 * parameter that the module never supplies, so `docs` for module A cannot address module B.
 */
function docStoreFor(c: Conn, moduleId: string): DocStore {
  return {
    get(collection: string, key: string): DocRecord | undefined {
      const row = oneRow(
        c,
        sql`SELECT json, version, updated_at FROM ${DOCS}
            WHERE module_id = ${moduleId} AND collection = ${collection} AND key = ${key}`,
      );
      if (row === undefined) return undefined;
      const json = readDocJson(row['json'] ?? null);
      if (json === null) return undefined;
      return { json, version: readInt(row['version'] ?? null), updatedAt: readInt(row['updated_at'] ?? null) };
    },

    /**
     * Compare-and-set on `version`. `expectedVersion === 0` means "must not exist yet".
     *
     * WHY two statements rather than an UPSERT: an UPSERT whose `DO UPDATE` carried the
     * version guard would silently INSERT when the guard failed, which is precisely the
     * last-write-wins behaviour this signature exists to prevent.
     */
    put(collection: string, key: string, json: JsonObject, expectedVersion: number): boolean {
      const at = c.now();
      const text = JSON.stringify(json);
      if (expectedVersion === 0) {
        const r = runWrite(
          c,
          sql`INSERT INTO ${DOCS} (module_id, collection, key, json, version, updated_at)
              VALUES (${moduleId}, ${collection}, ${key}, ${text}, 1, ${at})
              ON CONFLICT (module_id, collection, key) DO NOTHING`,
        );
        return r.changes === 1;
      }
      const r = runWrite(
        c,
        sql`UPDATE ${DOCS} SET json = ${text}, version = version + 1, updated_at = ${at}
            WHERE module_id = ${moduleId} AND collection = ${collection} AND key = ${key}
              AND version = ${expectedVersion}`,
      );
      return r.changes === 1;
    },

    del(collection: string, key: string): boolean {
      const r = runWrite(
        c,
        sql`DELETE FROM ${DOCS} WHERE module_id = ${moduleId} AND collection = ${collection} AND key = ${key}`,
      );
      return r.changes > 0;
    },

    /** Ordered by key so a paged caller and a test both see a stable sequence. */
    list(collection: string, limit: number): readonly { readonly key: string; readonly json: JsonObject }[] {
      const rows = allRows(
        c,
        sql`SELECT key, json FROM ${DOCS}
            WHERE module_id = ${moduleId} AND collection = ${collection}
            ORDER BY key LIMIT ${limit}`,
      );
      const out: { readonly key: string; readonly json: JsonObject }[] = [];
      for (const row of rows) {
        const key = row['key'];
        const json = readDocJson(row['json'] ?? null);
        if (typeof key !== 'string' || json === null) continue;
        out.push({ key, json });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------

function makePort(c: Conn, moduleId: string, prefix: string, allowCore: boolean): DbPort {
  /** Every statement a module hands in is re-proven against its namespace before it runs. */
  const guard = (q: SqlQuery): void => {
    const owned = checkTableOwnership(q, prefix, { allowCore });
    if (!owned.ok) throw new DbPortError(owned.error);
  };

  return {
    tablePrefix: prefix,

    table: (name: string): SqlIdent => ident(`${prefix}${name}`),

    column: (name: string): SqlIdent => ident(name),

    query: <T>(q: SqlQuery): readonly T[] => {
      guard(q);
      return allRows(c, q).map((row) => rowAs<T>(row));
    },

    queryOne: <T>(q: SqlQuery): T | undefined => {
      guard(q);
      const row = oneRow(c, q);
      return row === undefined ? undefined : rowAs<T>(row);
    },

    execute: (q: SqlQuery): WriteResult => {
      guard(q);
      return runWrite(c, q);
    },

    transaction: <T>(fn: () => T): T => runTransaction(c, fn),

    docs: docStoreFor(c, moduleId),
  };
}

// ---------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------

/** WHY 5s and not 0: the default is 0, i.e. fail instantly on any contended write. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteOptions {
  /** How long SQLite blocks on a held write lock before raising SQLITE_BUSY. */
  readonly busyTimeoutMs?: number;
  /**
   * Wall clock for `core_docs.updated_at` and the migration ledger.
   * WHY injectable: `Date.now()` in the adapter makes TTL behaviour untestable, and the
   * composition root already holds a `ClockPort` - pass `clock.now`.
   */
  readonly now?: () => number;
}

/**
 * The open database. Only the composition root holds one.
 *
 * `connection` is deliberately reachable: the migration runner in this same adapter needs raw
 * DDL, which `DbPort` structurally forbids (`checkTableOwnership` bans CREATE/DROP/ALTER).
 * Nothing under `src/modules/**` can obtain a `SqliteDb`.
 */
export interface SqliteDb {
  /** Raw handle. Adapter-internal; never handed to a module. */
  readonly connection: DatabaseSync;
  /** What `PRAGMA journal_mode` actually reports: `wal` for a file, `memory` for `:memory:`. */
  readonly journalMode: string;
  /** The clock the store writes into `updated_at`. */
  readonly now: () => number;
  /** A `DbPort` scoped to `m_<moduleId>_*`. This is what a module's `db` capability receives. */
  moduleDb(moduleId: string): DbPort;
  /** A `DbPort` for the CORE ports - audit, jobs, settings, access - scoped to `core_*`. */
  coreDb(): DbPort;
  /** Run `fn` in one transaction. Nested calls become savepoints. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Open (and create) the database.
 *
 * Returns a `Result` rather than throwing because a bad `DATABASE_PATH` is a CONFIG failure -
 * `main` must exit non-zero with a sentence an operator can act on, not a stack trace.
 */
export function openSqlite(path: string, options: SqliteOptions = {}): Result<SqliteDb, AppError> {
  const requested = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const busyTimeoutMs = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : DEFAULT_BUSY_TIMEOUT_MS;
  const now = options.now ?? ((): number => Date.now());

  if (path !== ':memory:') {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (cause: unknown) {
      return Err(
        errors.config(
          'DATABASE_PATH',
          `cannot create the directory for ${path}: ${cause instanceof Error ? cause.message : 'unknown'}`,
          'Point DATABASE_PATH at a writable directory and restart.',
        ),
      );
    }
  }

  let conn: DatabaseSync;
  try {
    conn = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: busyTimeoutMs });
  } catch (cause: unknown) {
    return Err(
      errors.config(
        'DATABASE_PATH',
        `cannot open ${path}: ${cause instanceof Error ? cause.message : 'unknown'}`,
        'Point DATABASE_PATH at a writable SQLite file and restart.',
      ),
    );
  }

  try {
    // WAL is what bounds a hard kill to the in-flight transaction. It is a persistent
    // property of the FILE, so re-running it on an existing database is a no-op.
    conn.exec('PRAGMA journal_mode = WAL');
    // Redundant with `enableForeignKeyConstraints`, and kept: this is the line an operator
    // greps for, and the constructor option is easy to drop in a refactor.
    conn.exec('PRAGMA foreign_keys = ON');
    // `busyTimeoutMs` is an integer this function computed; no value is interpolated.
    conn.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    ensureCoreSchema(conn);
  } catch (cause: unknown) {
    conn.close();
    return Err(
      errors.config(
        'DATABASE_PATH',
        `cannot initialise ${path}: ${cause instanceof Error ? cause.message : 'unknown'}`,
        'Check that the file is a SQLite database and that the process can write to it.',
      ),
    );
  }

  const journalRow = conn.prepare('PRAGMA journal_mode').get();
  const reported = journalRow?.['journal_mode'];
  const journalMode = typeof reported === 'string' ? reported : 'unknown';

  const c: Conn = { db: conn, cache: new Map<string, StatementSync>(), now, depth: 0 };

  return Ok({
    connection: conn,
    journalMode,
    now,
    moduleDb: (moduleId: string): DbPort => makePort(c, moduleId, tablePrefixFor(moduleId), false),
    coreDb: (): DbPort => makePort(c, 'core', CORE_TABLE_PREFIX, true),
    transaction: <T>(fn: () => T): T => runTransaction(c, fn),
    close: (): void => {
      // Cached statements belong to the connection; dropping them first keeps a later
      // `close()` from being handed a statement it has already finalised.
      c.cache.clear();
      if (conn.isOpen) conn.close();
    },
  });
}
