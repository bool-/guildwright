/**
 * Per-guild allow-lists, as a port (SC-7 layer L1).
 *
 * POSTMORTEM THIS FILE CLOSES: "`/access` had to be core code, because the only way to read or
 * write `core_access` was raw SQL - which meant any module holding `capabilities: ['db']`
 * could grant itself `builder.approve` in every guild." That escalation is now blocked twice:
 * `checkTableOwnership` refuses `core_*` from a module's `db` port, and grants go through this
 * port, which is its own reviewable capability.
 */

import type { Result } from '#core/result';
import type { AppError } from '#core/errors';
import type { AccessDecision, PermissionRef } from '#core/policy';
import type { GuildId, RoleId, UserId } from '#core/ids';

/** A subject an allow-list entry names. */
export type GrantSubject =
  | { readonly kind: 'role'; readonly id: RoleId }
  | { readonly kind: 'user'; readonly id: UserId };

/** One row of `core_access`, as `/access list` renders it. */
export interface Grant {
  readonly permKey: string;
  readonly subject: GrantSubject;
  readonly grantedBy: string;
  readonly grantedAt: number;
}

/** Everything an authorization decision needs about the actor. */
export interface AccessSubjectSnapshot {
  readonly userId: UserId;
  readonly roleIds: readonly RoleId[];
  /** The BOT's view of the actor's guild permissions, for the `guild-admin` fallback. */
  readonly memberPermissions: bigint;
  /** True only for the configured application owner (layer L0). */
  readonly isAppOwner: boolean;
}

export interface AccessPort {
  /**
   * The single authorization entry point.
   * WHY it returns the DECIDING LAYER and not just a boolean: `core_audit.decision_layer` is
   * what makes "who let this through?" answerable months later, and a denial has to name
   * `grantableBy` or the user has no next step.
   */
  check(guildId: GuildId | null, ref: PermissionRef, subject: AccessSubjectSnapshot): AccessDecision;

  /** Grant a key to a role or a user in one guild. */
  grant(guildId: GuildId, ref: PermissionRef, subject: GrantSubject, byUserId: UserId): Result<void, AppError>;

  /** Revoke one grant. `false` when there was nothing to revoke. */
  revoke(guildId: GuildId, ref: PermissionRef, subject: GrantSubject): Result<boolean, AppError>;

  /**
   * Grant by STRING key - the door `/access grant` goes through.
   *
   * WHY A STRING AND NOT A `PermissionRef`: a `PermissionRef` carries a module-private symbol
   * and `defineModule` mints one per key the DECLARING module wrote down, so an `access`
   * module physically cannot name `builder.approve`. That is deliberate and must stay true -
   * otherwise any module could forge any other module's key and the ref would be decorative.
   *
   * So the string crosses the boundary instead, and the ADAPTER - which can reach the boot
   * catalog - is what turns it back into a ref. An unknown or undeclared `permKey` is REFUSED,
   * and `@core.public` is refused too. That refusal is the whole reason refs stay unforgeable:
   * the caller may only name a key some module actually declared, and it may not invent one.
   */
  grantByKey(guildId: GuildId, permKey: string, subject: GrantSubject, byUserId: UserId): Result<void, AppError>;

  /**
   * Revoke by STRING key. Same validation as `grantByKey`, for the same reason.
   *
   * WHY IT VALIDATES AT ALL, when a delete of a key nobody declared would be harmless: a typo
   * that silently answers "nothing to revoke" is indistinguishable from a revoke that worked,
   * and the operator walks away believing they closed access they did not close.
   */
  revokeByKey(guildId: GuildId, permKey: string, subject: GrantSubject): Result<boolean, AppError>;

  /** Every grant in one guild, for `/access list`. */
  list(guildId: GuildId): readonly Grant[];
}
