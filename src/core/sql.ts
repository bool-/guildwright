/**
 * SQL, as a type.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "`db.query('SELECT * FROM t WHERE name = ' + name)` shipped." A `SqlQuery` carries a
 *      module-private symbol, so a plain string is TS2345. The `require-sql-tag` lint rule is
 *      a second net; the type is the first. There is deliberately NO `sqlUnsafeDdl(string)`
 *      and no `sqlIn(column: string, ...)`: both earlier designs shipped an escape hatch
 *      beside the wall, importable with one extra specifier, which voided it entirely.
 *  (2) "A module declaring only `capabilities: ['db']` ran `INSERT INTO core_access ...` and
 *      granted itself `builder.approve` in every guild." `db` used to mean the whole SQLite
 *      file. Two layers close it: a module can only MINT identifiers for its own tables
 *      (`db.table`), and `checkTableOwnership` re-proves it on the finished statement.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';

/** Everything SQLite can bind. WHY no `undefined`: it silently becomes NULL in some drivers. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

const SQL = Symbol('core.sql.query');
const IDENT = Symbol('core.sql.ident');

/**
 * A validated SQL identifier - a table or column NAME, which SQLite cannot parameterise.
 *
 * WHY an opaque object and not a branded string: a branded string IS a string, so the `sql`
 * tag could not tell at RUNTIME whether to bind it or splice it. An object carrying a
 * module-private symbol is unambiguous in both directions and cannot be forged by an object
 * literal. This is the honest answer to "we needed `FROM <table>`, so we shipped a raw-string
 * escape hatch."
 */
export interface SqlIdent {
  readonly [IDENT]: string;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

/**
 * Mint an identifier.
 *
 * WHY it THROWS: an identifier is always a value this codebase computed - a table suffix, a
 * sort column from a closed union - never user input, so a mismatch is a programmer error.
 * The regex admits no space, quote, parenthesis, semicolon or comment marker, so
 * `ident('name) OR 1=1 --')` - the exact bypass one earlier design shipped - cannot exist.
 */
export function ident(name: string): SqlIdent {
  if (!IDENT_RE.test(name)) throw new TypeError(`sql ident: ${JSON.stringify(name)} is not an identifier`);
  return { [IDENT]: name };
}

/** A parameterised statement. Only `sql` and its composers mint one. */
export interface SqlQuery {
  readonly [SQL]: true;
  /** Statement text with `?` placeholders. Structurally never contains a user value. */
  readonly text: string;
  /** Bound parameters, positional. */
  readonly params: readonly SqlValue[];
}

function isIdent(v: SqlValue | SqlIdent): v is SqlIdent {
  return typeof v === 'object' && v !== null && IDENT in v;
}

/**
 * The tagged template - the only door.
 *
 * Every `${...}` that is a VALUE becomes a bound parameter; every `${...}` that is a minted
 * `SqlIdent` is spliced as text. Injection is therefore not "discouraged", it is
 * unrepresentable: there is no path from an unvalidated string into `text`.
 */
export function sql(strings: TemplateStringsArray, ...values: readonly (SqlValue | SqlIdent)[]): SqlQuery {
  let text = '';
  const params: SqlValue[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i] ?? '';
    if (i < values.length) {
      // `values[i]` is in range, so the `?? null` branch is unreachable; it exists only to
      // discharge noUncheckedIndexedAccess without silently dropping a placeholder.
      const v = values[i] ?? null;
      if (isIdent(v)) {
        text += v[IDENT];
      } else {
        text += '?';
        params.push(v);
      }
    }
  }
  return { [SQL]: true, text, params };
}

/**
 * Compose fragments that are already `SqlQuery`s.
 * WHY it exists: without it, "build a WHERE clause conditionally" is the reason somebody
 * reaches for string concatenation, and then for an escape hatch.
 */
export function sqlJoin(parts: readonly SqlQuery[], separator = ' '): SqlQuery {
  const text = parts.map((p) => p.text).join(separator);
  const params: SqlValue[] = [];
  for (const p of parts) params.push(...p.params);
  return { [SQL]: true, text, params };
}

/**
 * A bound `?, ?, ?` list for `IN (...)`.
 * WHY it takes only VALUES and never a column name: the previous design's
 * `sqlIn(column: string, values)` spliced `column` into the statement text verbatim, and the
 * lint rule did not fire because the call still produced a `SqlQuery`. A column here is an
 * `SqlIdent` in the surrounding template, minted by `db.column`.
 */
export function sqlValues(values: readonly SqlValue[]): SqlQuery {
  return { [SQL]: true, text: values.map(() => '?').join(', '), params: values };
}

/** WHY exported: the adapter must read the text to prepare it, and ownership checking needs it. */
export function renderSql(q: SqlQuery): { readonly text: string; readonly params: readonly SqlValue[] } {
  return { text: q.text, params: q.params };
}

// ---------------------------------------------------------------------------------------
// Table ownership - what makes `capabilities: ['db']` a bounded grant
// ---------------------------------------------------------------------------------------

/** Statements a module may never issue, whatever tables they name. */
const BANNED = /\b(ATTACH|DETACH|PRAGMA|VACUUM|CREATE|DROP|ALTER|REINDEX)\b/iu;

/** Every place a table name can appear in the DML a module is allowed to write. */
const TABLE_REF = /\b(?:FROM|JOIN|INTO|UPDATE)\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1/giu;

/**
 * Keywords that follow one of the TABLE_REF verbs without being a table name.
 *
 * `SET` is the one that matters and it is not hypothetical: SQLite's upsert form is
 * `INSERT ... ON CONFLICT (...) DO UPDATE SET col = excluded.col`, so `UPDATE\s+SET` matched and
 * "set" was recorded as a referenced table. It does not start with the module prefix, so the
 * check refused EVERY upsert — including the one in the `tags` exemplar that AGENTS.md tells
 * contributors to copy, and the one the scaffolder generates. The rule meant to bound a module's
 * reach was instead blocking the module's own table.
 *
 * These are reserved words, so no unquoted table can legitimately be named one of them.
 */
const NOT_A_TABLE_NAME = new Set(['set', 'select', 'values']);

/** Literals and comments cannot contain a table reference and would produce false positives. */
function stripLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/gu, "''").replace(/--[^\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

/**
 * Prove that a module's statement touches only its own tables.
 *
 * WHY it lives in core and not in the adapter: it enforces the `m_<id>_` naming rule that the
 * migration ownership diff only covers for DDL. Before this, a module holding `db` could
 * SELECT another module's rows and INSERT into `core_access` at runtime, which is a privilege
 * escalation, not a style violation. One implementation, unit-tested, called by every `DbPort`
 * implementation on every statement.
 *
 * `allowCore` exists for the CORE-owned ports - audit, jobs, settings, access, ratelimit -
 * which legitimately write `core_*` and are not reachable from a module's `db` capability.
 */
export function checkTableOwnership(
  q: SqlQuery,
  prefix: string,
  opts: { readonly allowCore: boolean } = { allowCore: false },
): Result<void, AppError> {
  const text = stripLiterals(q.text);
  const banned = BANNED.exec(text);
  if (banned !== null) {
    return Err(
      // A module bug, not a user's missing permission: the user sees the generic "broken on our
      // side" card and the developer hint goes to the log.
      errors.config(
        'db.statement',
        `a module issued ${banned[0].toUpperCase()}`,
        'Modules may not issue that statement. Schema changes belong in ./migrations/*.sql.',
      ),
    );
  }
  const seen = new Set<string>();
  for (const m of text.matchAll(TABLE_REF)) {
    const name = m[2];
    if (name === undefined) continue;
    const lower = name.toLowerCase();
    // `DO UPDATE SET` is not a reference to a table called "set". See NOT_A_TABLE_NAME.
    if (NOT_A_TABLE_NAME.has(lower)) continue;
    seen.add(lower);
  }
  for (const name of seen) {
    if (name.startsWith(prefix)) continue;
    if (opts.allowCore && name.startsWith('core_')) continue;
    return Err(
      errors.config(
        'db.table',
        `a module touched table "${name}", which it does not own`,
        `A module may only touch tables named ${prefix}*.`,
      ),
    );
  }
  return Ok(undefined);
}

/** WHY derived and not free text: the prefix is the module id, and only the loader knows it. */
export function tablePrefixFor(moduleId: string): string {
  return `m_${moduleId.replace(/-/gu, '_')}_`;
}
