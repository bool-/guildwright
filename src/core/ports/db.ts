/**
 * The persistence port.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) String-concatenated SQL. Handled by `SqlQuery` in `#core/sql`; this file only
 *      re-exports the tag so a repo needs one import, and it exports NOTHING else that
 *      produces a `SqlQuery`.
 *  (2) "The double-clicked Approve button dispatched twice." `execute` returns the row count
 *      so a compare-and-set is expressible, and NOTHING in this port retries: a transparently
 *      retried UPDATE is how an idempotent-looking write happens twice (SC-10).
 *  (3) "A module declaring only `db` read another module's tables and wrote `core_access`."
 *      `tablePrefix` is on the port and every implementation must run `checkTableOwnership`.
 *
 * WHY the port is SYNCHRONOUS: the adapter is `node:sqlite`'s `DatabaseSync`. Making it async
 * would invite `await` inside a transaction, which is how you get an interleaved write and a
 * torn state machine - and the enqueue of a poll job MUST be atomic with the state change
 * that justified it.
 */

import type { JsonObject } from '#core/json';

import type { SqlIdent, SqlQuery } from '#core/sql';
export type { SqlIdent, SqlQuery, SqlValue } from '#core/sql';
export { sql, sqlJoin, sqlValues } from '#core/sql';

/** Result of a write. `changes === 0` after a guarded UPDATE means someone else won the race. */
export interface WriteResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** One document, with its optimistic-concurrency token. */
export interface DocRecord {
  readonly json: JsonObject;
  readonly version: number;
  readonly updatedAt: number;
}

/**
 * Namespaced document store - the zero-migration path (`core_docs`).
 * WHY `expectedVersion` is required and not optional: last-write-wins on shared state is how
 * two approvers both dispatch a build. Pass 0 to mean "must not exist yet".
 */
export interface DocStore {
  get(collection: string, key: string): DocRecord | undefined;
  /** WHY `JsonObject`: it is written with `JSON.stringify` and read back after a restart. */
  put(collection: string, key: string, json: JsonObject, expectedVersion: number): boolean;
  del(collection: string, key: string): boolean;
  list(collection: string, limit: number): readonly { readonly key: string; readonly json: JsonObject }[];
}

/** The database port a module receives when it declares the `db` capability. */
export interface DbPort {
  /**
   * The `m_<moduleId>_` prefix this port is scoped to.
   * WHY it is readable: repos build statements against it, and the adapter proves every
   * statement stays inside it with `checkTableOwnership` before executing.
   */
  readonly tablePrefix: string;

  /**
   * Name one of THIS module's tables, e.g. `db.table('tags')` -> `m_tags_tags`.
   *
   * WHY the port mints it and a module never spells the prefix: a table name cannot be a bound
   * parameter, so something has to put text into the statement. Routing that through the port
   * means `FROM core_access` is not merely refused at execute time, it is unrepresentable -
   * the only identifiers a module can obtain are its own.
   */
  table(name: string): SqlIdent;

  /**
   * Name a column, for an ORDER BY or a dynamic filter.
   * WHY it exists: without it, "order by whichever column the user picked" is the reason
   * somebody reaches for string concatenation. `ident` validates the shape and throws.
   */
  column(name: string): SqlIdent;

  /** Read many rows. `T` describes the row shape; see the honesty note in the design summary. */
  query<T>(q: SqlQuery): readonly T[];

  /** Read at most one row. */
  queryOne<T>(q: SqlQuery): T | undefined;

  /** Write. Returns the row count so callers can implement compare-and-set. NEVER retries. */
  execute(q: SqlQuery): WriteResult;

  /**
   * Run `fn` inside one transaction, synchronously.
   * WHY sync-only: a durable job enqueue must be atomic with the state change that caused it,
   * and awaiting inside a transaction breaks that atomicity silently.
   */
  transaction<T>(fn: () => T): T;

  /** The document store, namespaced to the calling module. */
  readonly docs: DocStore;
}

/** Short alias used throughout modules: `tagsRepo(db: Db)`. */
export type Db = DbPort;
