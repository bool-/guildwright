/**
 * Command argument and modal field access.
 *
 * POSTMORTEM THIS FILE CLOSES: "the autocomplete offered three safe values, the client sent a
 * fourth, and we trusted it." Discord explicitly permits a client to submit a value that was
 * never offered (SC-11).
 *
 * There is deliberately NO `string` accessor anywhere here. Every textual accessor yields
 * `UserText`, so a handler that wants characters must name a sanitiser from `#core/text`.
 */

import type { Result } from '#core/result';
import type { AppError } from '#core/errors';
import type { UserText } from '#core/text';
import type { ChannelId, RoleId, UserId } from '#core/ids';

/** The accessor bag handed to a command handler. */
export interface Args {
  /** Option names actually present, for diagnostics and `/help`. */
  readonly names: readonly string[];

  /** An optional text option. `undefined` when the user omitted it. */
  text(name: string): UserText | undefined;

  /**
   * A text option declared `required: true`.
   * WHY it throws rather than returning `Result`: Discord itself enforces required options, so
   * absence here means the spec and the registered payload have drifted - a deploy bug, not a
   * user mistake, and it should be loud.
   */
  textRequired(name: string): UserText;

  /** A Discord-typed integer option (a number on the wire; still range-checked here). */
  integer(name: string, opts: { readonly min: number; readonly max: number }): Result<number, AppError>;

  /** A boolean option. */
  bool(name: string): boolean | undefined;

  /** A user option, branded. */
  user(name: string): UserId | undefined;

  /** A role option, branded. */
  role(name: string): RoleId | undefined;

  /** A channel option, branded. */
  channel(name: string): ChannelId | undefined;

  /**
   * A value restricted to a server-side allow-list.
   * WHY it takes `allowed` rather than reading the spec: the check must not depend on what we
   * told the client, only on what this handler will accept.
   */
  choice<const T extends readonly string[]>(name: string, allowed: T): Result<T[number], AppError>;
}

/**
 * The accessor bag handed to a MODAL SUBMIT handler.
 *
 * WHY this exists at all: both previous designs let a module OPEN a modal (`ack: 'form'`,
 * `FormSpec`) and gave it nowhere to READ the submitted values, so the flagship's
 * `fields_json` column - "sanitised problem/proposal/priority/areas" - could never be
 * populated. A contributor following the contract shipped a form that silently discarded
 * everything the user typed.
 */
export interface FormValues {
  /** Field names actually submitted. */
  readonly names: readonly string[];
  /** A submitted text field. `undefined` when the field was optional and left blank. */
  text(name: string): UserText | undefined;
  /** A field declared `required: true` in the `FormSpec`. Throws on drift, like `textRequired`. */
  textRequired(name: string): UserText;
  /**
   * A dropdown field's choice, re-validated against `allowed`. `Ok(undefined)` when an optional
   * dropdown was left empty; `Err` when the client echoed a value outside the allow-list.
   */
  choice<const T extends readonly string[]>(name: string, allowed: T): Result<T[number] | undefined, AppError>;
}

/** Values echoed back by a select menu. Always re-validated, never trusted. */
export interface SelectValues {
  /** Raw echoed values, as `UserText`, so `toEnum` is the only way to read one. */
  readonly chosen: readonly UserText[];
  /** Re-validate every chosen value against the allow-list this handler will accept. */
  all<const T extends readonly string[]>(allowed: T): Result<readonly T[number][], AppError>;
}
