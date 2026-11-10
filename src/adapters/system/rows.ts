/**
 * Re-proving a row that came back out of SQLite.
 *
 * WHY this file exists at all: `DbPort.query<T>` is generic, so `T` is an ASSERTION the
 * caller makes, not a proof - the honest note in the design summary says so out loud. A row
 * read after a restart is bytes written by an older deploy, so every field a system adapter
 * depends on is narrowed here before it is used. That is the same discipline `readSurface`
 * applies to a job payload, applied to the columns.
 */

import type { JsonObject } from '#core/json';
import { isJsonObject } from '#core/json';

/** One row, before anything about it has been proven. */
export type Row = Readonly<Record<string, unknown>>;

/** A TEXT column, or `null` when it is NULL, absent or some other type. */
export function textCol(row: Row, name: string): string | null {
  const v = row[name];
  return typeof v === 'string' ? v : null;
}

/**
 * An INTEGER column, or `null`.
 * WHY `bigint` is accepted: `node:sqlite` hands back a `bigint` for values above 2^53, and a
 * lease timestamp that silently reads as `null` would make the reclaimer steal live jobs.
 */
export function intCol(row: Row, name: string): number | null {
  const v = row[name];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/** A JSON TEXT column parsed back to a `JsonObject`, or `null` if it is anything else. */
export function jsonCol(row: Row, name: string): JsonObject | null {
  const raw = textCol(row, name);
  if (raw === null) return null;
  return parseJsonObject(raw);
}

/** WHY total: a malformed row must be a skipped row, never a thrown exception in a tick. */
export function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
