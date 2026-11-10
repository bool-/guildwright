/**
 * The durable-state wall.
 *
 * WHY this tiny file is load-bearing: everything that survives a restart - a job payload, a
 * `core_docs` row, an audit `detail`, a log field - round-trips through `JSON.stringify`.
 * Typing those sinks as `JsonValue` makes it a COMPILE ERROR to stash the four things that
 * have historically been stashed there and then silently lost or leaked:
 *
 *   - a `ProgressHandle` (the token-bound reply channel that dies at 15 minutes),
 *   - a `UserText` that has not been through a sanitiser,
 *   - a `Secret`,
 *   - a closure, a `Date` or a `bigint`, all of which `JSON.stringify` mangles.
 *
 * Each of those carries a module-private `unique symbol` or a method, so none is assignable
 * here. "The bot restarted and forgot about my build" becomes TS2322 at the enqueue.
 */

/** The only shapes that survive a process restart intact. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Record form. Used for job payloads, audit details, log fields and doc-store values. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** WHY: narrowing parsed-back JSON without `any` and without a cast. */
export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** WHY: a job payload read back out of SQLite is bytes, so its fields must be re-proven. */
export function readString(o: JsonObject, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

/** WHY: same, for the numeric fields (`issueNumber`, `runId`) every poller re-reads. */
export function readNumber(o: JsonObject, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
