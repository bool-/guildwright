/**
 * Authorization decisions (SC-7, SC-8), over `DbPort` + `SettingsPort`.
 *
 * FOUR LAYERS, IN ORDER, AND THE ORDER IS THE DESIGN:
 *
 *   L0-owner      the configured application owner. One person, from config, not a grant.
 *   L1-allowlist  an explicit `core_access` row for this guild: a ROLE or a USER.
 *   L2-fallback   what the DECLARING MODULE said should happen with no allow-list. Read from
 *                 the registry, never from the `PermissionRef` - a ref carries no `fallback`
 *                 precisely so a forged one cannot choose its own answer.
 *   L3-deny       and the denial NAMES who can grant it, because a dead end is a bug.
 *
 * POSTMORTEMS THIS FILE CLOSES:
 *  (1) "The Approve button was gated on `interaction.user.id === requester.id`, so anyone who
 *      could see the card could approve someone else's build." Approval is a permission KEY
 *      with its own allow-list; being the requester is not an input to `check` at all.
 *  (2) "In a DM, every permission-gated command passed." That is the live framework bug this
 *      repo rejected `@sapphire/framework` over: its DM fallback is the bit-complement of a
 *      DM-safe set, which includes Administrator, and discord.js's `missing(bits, true)`
 *      returns `[]` whenever Administrator is present. Here a `guild-admin` fallback in a DM
 *      is an explicit DENY - there is no guild, so there is no server manager - and
 *      `hasManageGuild` has no Administrator expansion anywhere in the repo.
 *  (3) "Asking is not approving." `builder.request` and `builder.approve` are separate keys,
 *      so their allow-lists are separate rows and a grant of one is structurally not a grant
 *      of the other. `access.test.ts` asserts exactly that.
 *  (4) "The requester approved their own build." `checkSelfApproval` denies by DEFAULT, and
 *      the per-guild flag that lifts it is one setting a human had to write down.
 *  (5) "Every denial named a grant nobody could make." `core_access` had exactly one writer -
 *      `grant`, which takes a `PermissionRef` - and a module cannot mint another module's ref,
 *      so no module could ever offer `/access grant`. `builder.approve` falls back to `nobody`,
 *      which meant the ONLY approver in the world was `DISCORD_OWNER_ID` via the L0 bypass, and
 *      creating a second one meant hand-editing SQLite. `grantByKey`/`revokeByKey` below are
 *      the door that fixes it WITHOUT weakening the ref: they take a string and prove it
 *      against the boot catalog before minting anything.
 *
 * WHY the grants are CACHED per guild: `check` is synchronous and runs inside the 3-second
 * interaction window, on every command, click and hook. The cache is dropped on every write
 * through this port, so the table stays the source of truth.
 */

import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import { Err, Ok, type Result } from '#core/result';
import type { GuildId, UserId } from '#core/ids';
import { toRoleId, toUserId } from '#core/ids';
import { hasManageGuild } from '#core/permissions';
import type { AccessDecision, Fallback, PermissionRef } from '#core/policy';
import { isPublic, permissionKey, permissionRef } from '#core/policy';
import type { AccessPort, AccessSubjectSnapshot, CatalogPort, ClockPort, DbPort, Grant, GrantSubject, LoggerPort, SettingsPort } from '#core/ports';
import { sql } from '#core/sql';
import { CORE_TABLES } from '#adapters/system/schema';
import { intCol, textCol, type Row } from '#adapters/system/rows';
import { readGuildOwnerId, readSelfApprove } from '#adapters/system/settings';

/**
 * How the resolver learns a key's L2 default.
 * WHY a function and not a map: the registry is built after the ports are wired, and a
 * snapshot taken at wiring time would be empty. `undefined` means "no module declares this
 * key", which is a DENY - an unknown permission must never fall back to `everyone`.
 */
export type FallbackResolver = (permKey: string) => Fallback | undefined;

const FALLBACKS: readonly Fallback[] = ['everyone', 'guild-admin', 'app-owner', 'nobody'];

/** Build a resolver from the boot catalog. WHY here: only this file knows what it needs. */
export function fallbacksFromCatalog(catalog: CatalogPort): FallbackResolver {
  return (permKey: string): Fallback | undefined => {
    for (const p of catalog.permissions()) {
      if (p.permKey !== permKey) continue;
      for (const f of FALLBACKS) if (f === p.fallback) return f;
      return 'nobody';
    }
    return undefined;
  };
}

/** Everything `checkSelfApproval` needs beyond a normal check. */
export interface SelfApprovalInput {
  readonly guildId: GuildId | null;
  readonly ref: PermissionRef;
  readonly subject: AccessSubjectSnapshot;
  /** Who opened the thing being approved. From the persisted request row, never from a click. */
  readonly requesterId: UserId;
}

/**
 * The port, plus the two things `AccessPort` cannot express today.
 *
 * `checkSelfApproval` is NOT on `AccessPort`, because `check` receives no request context -
 * see the core change request in the handover notes. Until that lands, the composition root
 * wires this object and the builder module reaches separation-of-duty through a service.
 */
export interface AccessControl extends AccessPort {
  /** `check`, and then the separation-of-duty rule on top. Denies self-approval by default. */
  checkSelfApproval(input: SelfApprovalInput): AccessDecision;
  /** Drop the grant cache for one guild, or all of them. */
  invalidate(guildId?: GuildId): void;
}

export interface AccessDeps {
  /** Must be a CORE-scoped port (`tablePrefix === 'core_'`). */
  readonly db: DbPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  readonly settings: SettingsPort;
  readonly fallbacks: FallbackResolver;
  /**
   * Override for "is this user the guild owner?".
   * WHY it is injectable: `AccessSubjectSnapshot` has no owner flag, so the default reads the
   * id the Discord adapter recorded in settings; a live client can answer better.
   */
  readonly isGuildOwner?: (guildId: GuildId, userId: UserId) => boolean;
}

export function createAccess(deps: AccessDeps): AccessControl {
  const { db, clock, settings, fallbacks } = deps;
  const logger = deps.logger.child({ component: 'access' });
  const table = db.table(CORE_TABLES.access);
  const cache = new Map<string, readonly Grant[]>();

  const ownerCheck =
    deps.isGuildOwner ?? ((guildId: GuildId, userId: UserId): boolean => readGuildOwnerId(settings, guildId) === userId);

  function grantsFor(guildId: GuildId): readonly Grant[] {
    const hit = cache.get(guildId);
    if (hit !== undefined) return hit;
    const rows = db.query<Row>(
      sql`SELECT perm_key, subject_kind, subject_id, granted_by, granted_at_ms FROM ${table} WHERE guild_id = ${guildId}`,
    );
    const grants = readGrants(rows);
    cache.set(guildId, grants);
    return grants;
  }

  function deny(permKey: string, fallback: Fallback): AccessDecision {
    return { allowed: false, layer: 'L3-deny', grantableBy: grantableBy(fallback) };
  }

  function check(guildId: GuildId | null, ref: PermissionRef, subject: AccessSubjectSnapshot): AccessDecision {
    const key = permissionKey(ref);

    // The explicit sentinel. It is checked FIRST so a public command costs no lookup, and it
    // reports L2 because "anyone" is a fallback answer, not a grant somebody made.
    if (isPublic(ref)) return { allowed: true, layer: 'L2-fallback' };

    // L0. One person, named in config. Deliberately above the allow-list so an operator can
    // always recover a guild whose grants were revoked by mistake.
    if (subject.isAppOwner) return { allowed: true, layer: 'L0-owner' };

    // L1. Allow-lists are per guild, so in a DM there is nothing to read - which is the point
    // of the DM branch below, not an oversight.
    if (guildId !== null) {
      for (const g of grantsFor(guildId)) {
        if (g.permKey !== key) continue;
        if (g.subject.kind === 'user' && g.subject.id === subject.userId) {
          return { allowed: true, layer: 'L1-allowlist' };
        }
        if (g.subject.kind === 'role' && subject.roleIds.includes(g.subject.id)) {
          return { allowed: true, layer: 'L1-allowlist' };
        }
      }
    }

    // L2. Read from the DECLARATION. An undeclared key denies.
    const fallback = fallbacks(key) ?? 'nobody';
    switch (fallback) {
      case 'everyone':
        return { allowed: true, layer: 'L2-fallback' };
      case 'guild-admin': {
        // THE DM RULE. No guild means no server manager, so there is nobody for this fallback
        // to describe. Anything that answers "allowed" here is the framework bug this repo
        // rejected a dependency over.
        if (guildId === null) return deny(key, fallback);
        if (ownerCheck(guildId, subject.userId)) return { allowed: true, layer: 'L2-fallback' };
        // `hasManageGuild` is a plain bit test: no Administrator expansion, ever.
        return hasManageGuild(subject.memberPermissions) ? { allowed: true, layer: 'L2-fallback' } : deny(key, fallback);
      }
      case 'app-owner':
        // `isAppOwner` was already answered at L0, so reaching here means "not the owner".
        return deny(key, fallback);
      case 'nobody':
        return deny(key, fallback);
      default: {
        const exhaustive: never = fallback;
        void exhaustive;
        return deny(key, 'nobody');
      }
    }
  }

  /**
   * THE STRING DOOR: `permKey` -> `PermissionRef`, or a refusal.
   *
   * WHY IT LIVES HERE AND NOT IN A MODULE. `permissionRef` is loader-only by convention, and a
   * module that could call it could mint ANOTHER module's key - which is the one thing
   * `PermissionRef` exists to prevent. So `/access` hands in a string instead, and this is the
   * only place that string can become a ref. Minting is legitimate here because the function
   * first proves, against the boot catalog, that some module really declared this exact key.
   * The unforgeability of a ref is therefore not weakened by `/access`; it is re-established
   * here, once, in the one layer that can see the registry.
   *
   * `fallbacks` IS that catalog lookup - `fallbacksFromCatalog` walks `catalog.permissions()`
   * and answers `undefined` for a key no module declares - so "is this key declared?" and
   * "what is its L2 default?" are one question with one source of truth, asked once.
   */
  function refFromKey(permKey: string): Result<PermissionRef, AppError> {
    // Split at the FIRST dot, so the round trip back through `permissionKey` is exact even for
    // a key that contains one. A string with no dot names no module, so it is refused.
    const dot = permKey.indexOf('.');
    const moduleId = dot < 0 ? '' : permKey.slice(0, dot);
    const key = dot < 0 ? '' : permKey.slice(dot + 1);
    if (moduleId.length === 0 || key.length === 0) {
      return Err(
        errors.validation(
          'permission',
          'That is not a permission key.',
          'Use the form module.key, e.g. builder.approve. `/access list` shows every one.',
        ),
      );
    }

    const ref = permissionRef(moduleId, key);
    // Checked BEFORE existence, so `@core.public` is reported as what it is - a key that is
    // meaningless to grant - rather than as "no such permission".
    if (isPublic(ref)) {
      return Err(
        errors.validation('permission', 'That permission is public, so it cannot be granted.', 'Pick a real permission key.'),
      );
    }
    if (fallbacks(permKey) === undefined) {
      return Err(errors.notFound('permission', 'Run `/access list` to see the permission keys this bot declares.'));
    }
    return Ok(ref);
  }

  function grant(guildId: GuildId, ref: PermissionRef, subject: GrantSubject, byUserId: UserId): Result<void, AppError> {
    if (isPublic(ref)) {
      return Err(
        errors.validation('permission', 'That permission is public, so it cannot be granted.', 'Pick a real permission key.'),
      );
    }
    const key = permissionKey(ref);
    if (fallbacks(key) === undefined) {
      // WHY refused: a typo'd key would sit in the table forever, looking granted, gating
      // nothing - and the person who "fixed" access would never learn they had not.
      return Err(errors.notFound('permission', 'Run `/access list` to see the permission keys this bot declares.'));
    }
    try {
      // `INSERT OR REPLACE`, not an upsert: `checkTableOwnership` reads `DO UPDATE SET` as a
      // reference to a table called `SET` and refuses the statement. Re-granting is meant to
      // refresh `granted_by`/`granted_at_ms` anyway.
      db.execute(
        sql`INSERT OR REPLACE INTO ${table} (guild_id, perm_key, subject_kind, subject_id, granted_by, granted_at_ms)
            VALUES (${guildId}, ${key}, ${subject.kind}, ${subject.id}, ${byUserId}, ${clock.now()})`,
      );
    } catch (cause: unknown) {
      logger.error('grant failed', { guildId, permKey: key, cause: cause instanceof Error ? cause.name : 'unknown' });
      return Err(errors.upstream('sqlite', 0, 'Try the grant again in a moment.', 'core_access insert failed'));
    }
    cache.delete(guildId);
    return Ok(undefined);
  }

  function revoke(guildId: GuildId, ref: PermissionRef, subject: GrantSubject): Result<boolean, AppError> {
    const key = permissionKey(ref);
    let changes: number;
    try {
      changes = db.execute(
        sql`DELETE FROM ${table} WHERE guild_id = ${guildId} AND perm_key = ${key} AND subject_kind = ${subject.kind} AND subject_id = ${subject.id}`,
      ).changes;
    } catch (cause: unknown) {
      logger.error('revoke failed', { guildId, permKey: key, cause: cause instanceof Error ? cause.name : 'unknown' });
      return Err(errors.upstream('sqlite', 0, 'Try the revoke again in a moment.', 'core_access delete failed'));
    }
    cache.delete(guildId);
    return Ok(changes > 0);
  }

  return {
    check,
    grant,
    revoke,

    grantByKey(guildId: GuildId, permKey: string, subject: GrantSubject, byUserId: UserId): Result<void, AppError> {
      const ref = refFromKey(permKey);
      return ref.ok ? grant(guildId, ref.value, subject, byUserId) : ref;
    },

    /**
     * WHY THIS VALIDATES, when deleting a row for a key nobody declared would be harmless: an
     * unvalidated revoke answers `false` for a typo, which is byte-identical to the answer for
     * a grant that was genuinely already gone. The operator then walks away believing they
     * closed access they did not close.
     */
    revokeByKey(guildId: GuildId, permKey: string, subject: GrantSubject): Result<boolean, AppError> {
      const ref = refFromKey(permKey);
      return ref.ok ? revoke(guildId, ref.value, subject) : ref;
    },

    checkSelfApproval(input: SelfApprovalInput): AccessDecision {
      const base = check(input.guildId, input.ref, input.subject);
      if (!base.allowed) return base;
      if (input.subject.userId !== input.requesterId) return base;
      // Same person. Separation of duty applies to EVERY layer, the app owner included:
      // "asking is not approving" is not a statement about privilege level, and an operator
      // who wants the single-maintainer workflow turns the flag on in one place, on purpose.
      const allowed = input.guildId !== null && readSelfApprove(settings, input.guildId);
      if (allowed) return base;
      return {
        allowed: false,
        layer: 'L3-deny',
        grantableBy: 'another approver',
      };
    },

    list(guildId: GuildId): readonly Grant[] {
      return grantsFor(guildId);
    },

    invalidate(guildId?: GuildId): void {
      if (guildId === undefined) cache.clear();
      else cache.delete(guildId);
    },
  };
}

/** WHY every denial carries one of these: `forbidden` requires `grantableBy`, because a user
 *  who is told only "no" opens a ticket, and a user who is told who to ask does not. */
function grantableBy(fallback: Fallback): string {
  switch (fallback) {
    case 'app-owner':
      return 'the bot owner';
    case 'guild-admin':
      return 'a server manager';
    case 'everyone':
    case 'nobody':
    default:
      return 'a server manager';
  }
}

/** WHY re-proven row by row: `subject_kind` is TEXT, and a row from an older deploy is bytes. */
function readGrants(rows: readonly Row[]): readonly Grant[] {
  const out: Grant[] = [];
  for (const row of rows) {
    const permKey = textCol(row, 'perm_key');
    const kind = textCol(row, 'subject_kind');
    const id = textCol(row, 'subject_id');
    const grantedBy = textCol(row, 'granted_by');
    const grantedAt = intCol(row, 'granted_at_ms');
    if (permKey === null || id === null || grantedBy === null || grantedAt === null) continue;
    const subject = toSubject(kind, id);
    if (subject === null) continue;
    out.push({ permKey, subject, grantedBy, grantedAt });
  }
  return out;
}

/**
 * WHY it goes back through `toRoleId`/`toUserId` rather than casting: those are core's own
 * doors, the regex inside them IS the evidence for the brand, and a row that does not hold a
 * snowflake is dropped instead of becoming a grant that matches nothing.
 */
function toSubject(kind: string | null, id: string): GrantSubject | null {
  if (kind === 'role') {
    const r = toRoleId(id);
    return r.ok ? { kind: 'role', id: r.value } : null;
  }
  if (kind === 'user') {
    const u = toUserId(id);
    return u.ok ? { kind: 'user', id: u.value } : null;
  }
  return null;
}
