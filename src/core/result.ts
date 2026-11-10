/**
 * Result<T, E> - expected failure is a value, not a throw.
 *
 * WHY: an unhandled rejection kills a Node process, so a Discord bot that dies because a
 * GitHub 422 escaped one handler takes every other module down with it. Making every port
 * and service return `Result` leaves `throw` for genuine programmer errors only, which is
 * what makes a single top-level guard honest rather than a sieve.
 */

/** WHY a separate interface: `Ok<T>` must be returnable where `Result<T, E>` is expected. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * WHY the failure arm is generic in E ONLY: `if (!name.ok) return name;` must typecheck
 * inside a function returning `Result<Tag, AppError>` even when `name` is
 * `Result<string, AppError>`. That single ergonomic fact is why nobody reaches for `throw`.
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** WHY `ok` is the only discriminator: there is no third state to forget to handle. */
export type Result<T, E> = Ok<T> | Err<E>;

/** WHY a constructor and not a literal: call sites cannot spell the discriminant wrong. */
export function Ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** WHY: pairs with `errors.*`, so a failure is always constructed the same way. */
export function Err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** WHY a named guard: `.filter(isOk)` cannot use the `.ok` discriminator directly. */
export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

/** WHY: symmetry, and it keeps `!r.ok` out of expression position. */
export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** WHY: transform success without unwrapping, so the failure arm cannot be dropped. */
export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? Ok(f(r.value)) : r;
}

/** WHY: rewrite an error at a boundary, e.g. to attach a user-facing `nextStep`. */
export function mapErr<T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return r.ok ? r : Err(f(r.error));
}

/** WHY: chain fallible steps without a pyramid of early returns. */
export function andThen<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/** WHY: the ONLY sanctioned exit from Result, and it forces the fallback to be named. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** WHY all-or-nothing: a half-registered module is worse than a refused boot. */
export function allOk<T, E>(rs: readonly Result<T, E>[]): Result<readonly T[], E> {
  const out: T[] = [];
  for (const r of rs) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return Ok(out);
}

/** WHY gather-every-error: boot must report all collisions at once, not one per restart. */
export function partition<T, E>(rs: readonly Result<T, E>[]): Result<readonly T[], readonly E[]> {
  const values: T[] = [];
  const errs: E[] = [];
  for (const r of rs) {
    if (r.ok) values.push(r.value);
    else errs.push(r.error);
  }
  return errs.length > 0 ? Err(errs) : Ok(values);
}
