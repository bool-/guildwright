/**
 * `/access`, part 1: pure logic. No Discord, no SQL, no clock.
 *
 * WHAT THIS MODULE IS FOR, stated plainly because it is not obvious from the code:
 *
 * Every denial message in this bot ends with "ask a server manager to run `/access grant ...`".
 * Until this module existed, that sentence named a command that did not exist. `core_access`
 * had exactly one writer - `AccessPort.grant`, which takes a `PermissionRef` - and a module
 * cannot mint another module's ref, deliberately. So no module could offer the grant, and the
 * only way to create a second approver was to hand-edit SQLite.
 *
 * The consequence was worst on `builder.approve`, whose fallback is `nobody`: the single
 * approver in the world was `DISCORD_OWNER_ID` through the L0 bypass, and separation of duty
 * means they cannot approve their own request. Two unclicked cards then hold
 * `maxConcurrentPerGuild` forever with no release valve.
 *
 * THE KEY CROSSES THIS BOUNDARY AS A STRING, and that is the whole design. `ctx.perms` here
 * holds exactly one ref - `access.manage` - because that is all this module declared. It
 * cannot name `builder.approve`, and it must not be able to. So it hands the port a string and
 * the ADAPTER, which can reach the boot catalog, proves the string names a permission some
 * module really declared before it mints anything. An unknown key is refused there and refused
 * again here; `PUBLIC` is refused in both places too.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { toEnum, toMarkdown, type UserText } from '#core/text';
import type { AutocompleteChoice } from '#core/module';
import { MAX_AUTOCOMPLETE_CHOICES } from '#core/module';
import type { GuildId, RoleId, UserId } from '#core/ids';
import type { AccessPort, Audit, CatalogPermission, CatalogPort, GrantSubject } from '#core/ports';

/** Discord rejects an autocomplete choice whose `name` is longer than this. */
export const CHOICE_NAME_MAX = 100;

/**
 * One line of `/access list`: a declared key, its L2 default, and everyone explicitly named.
 *
 * WHY IT IS THE JOIN AND NOT JUST THE GRANTS: "who can do what here" is answered by the
 * grants AND by the fallbacks together. A key with no rows is not an absence of information -
 * for `builder.approve` it is the single most important line on the card, because it says
 * `nobody` and explains why the Approve button never works.
 */
export interface AccessRow {
  readonly permKey: string;
  readonly summary: string;
  readonly fallback: string;
  /** Explicit L1 grants. Empty means the fallback is the entire answer. */
  readonly subjects: readonly GrantSubject[];
  /** A grant whose key no installed module declares any more, e.g. after a module was removed. */
  readonly orphan: boolean;
}

/** What a grant or revoke was asked to do. Both fields come from the interaction, untrusted. */
export interface MutationInput {
  readonly guildId: GuildId;
  /** Still `UserText`: an autocomplete value is a client-supplied string like any other. */
  readonly permission: UserText;
  readonly user: UserId | undefined;
  readonly role: RoleId | undefined;
  readonly actorId: UserId;
}

/** What a grant or revoke actually did. */
export interface Mutation {
  readonly permKey: string;
  readonly subject: GrantSubject;
  /**
   * Revoke only. `false` is "there was nothing to revoke", which is a ROUTINE OUTCOME and not
   * an error: telling an operator "that failed" when the state they wanted already holds is
   * how a correct command gets retried until something real breaks.
   */
  readonly changed: boolean;
}

export class AccessAdminService {
  private readonly access: AccessPort;
  private readonly catalog: CatalogPort;
  private readonly audit: Audit;

  constructor(access: AccessPort, catalog: CatalogPort, audit: Audit) {
    // Fields declared and assigned explicitly: `erasableSyntaxOnly` rejects parameter
    // properties (TS1294), and this file is one a contributor copies.
    this.access = access;
    this.catalog = catalog;
    this.audit = audit;
  }

  /** Every permission key any installed module declares. The allow-list for SC-11. */
  keys(): readonly string[] {
    return this.catalog.permissions().map((p) => p.permKey);
  }

  /** Autocomplete answers, from the registry, so they cannot drift from what exists. */
  suggest(partial: UserText): readonly AutocompleteChoice[] {
    // `toMarkdown` is the named door out of `UserText`; the partial is a search term, not
    // something that gets stored, so the scrubbed text is exactly what is wanted.
    const q = toMarkdown(partial, { maxLength: CHOICE_NAME_MAX }).text.trim().toLowerCase();
    const out: AutocompleteChoice[] = [];
    for (const p of this.catalog.permissions()) {
      if (out.length >= MAX_AUTOCOMPLETE_CHOICES) break;
      if (q.length > 0 && !`${p.permKey} ${p.summary}`.toLowerCase().includes(q)) continue;
      out.push({ name: choiceName(p), value: p.permKey });
    }
    return out;
  }

  /** The `/access list` answer: every declared key joined against this guild's grants. */
  overview(guildId: GuildId): readonly AccessRow[] {
    const ungrouped = new Map<string, GrantSubject[]>();
    for (const g of this.access.list(guildId)) {
      const list = ungrouped.get(g.permKey) ?? [];
      list.push(g.subject);
      ungrouped.set(g.permKey, list);
    }

    const rows: AccessRow[] = [];
    for (const p of this.catalog.permissions()) {
      rows.push({
        permKey: p.permKey,
        summary: p.summary,
        fallback: p.fallback,
        subjects: ungrouped.get(p.permKey) ?? [],
        orphan: false,
      });
      ungrouped.delete(p.permKey);
    }
    rows.sort((a, b) => a.permKey.localeCompare(b.permKey));

    // WHY the leftovers are shown rather than dropped: a row for a key no module declares any
    // more grants nothing, so an operator reading only the declared keys would never learn
    // that the allow-list still names somebody. `check` denies it; `/access list` says so.
    const orphans = [...ungrouped.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [permKey, subjects] of orphans) {
      rows.push({
        permKey,
        summary: 'No installed module declares this key; the grant gates nothing.',
        fallback: 'nobody',
        subjects,
        orphan: true,
      });
    }
    return rows;
  }

  grant(input: MutationInput): Result<Mutation, AppError> {
    const target = this.target(input);
    if (!target.ok) return target;
    const { permKey, subject } = target.value;

    const written = this.access.grantByKey(input.guildId, permKey, subject, input.actorId);
    if (!written.ok) return written;

    this.audit.record({
      action: 'access.grant',
      actorId: input.actorId,
      guildId: input.guildId,
      // `detail` is `JsonObject`, so a raw `UserText` here would be TS2322. The key recorded is
      // the RE-VALIDATED one, not what the client submitted.
      detail: { permKey, subjectKind: subject.kind, subjectId: subject.id },
    });
    return Ok({ permKey, subject, changed: true });
  }

  revoke(input: MutationInput): Result<Mutation, AppError> {
    const target = this.target(input);
    if (!target.ok) return target;
    const { permKey, subject } = target.value;

    const removed = this.access.revokeByKey(input.guildId, permKey, subject);
    if (!removed.ok) return removed;

    this.audit.record({
      action: 'access.revoke',
      actorId: input.actorId,
      guildId: input.guildId,
      // `changed` is recorded because "nothing to revoke" and "revoked" are different facts,
      // and six months later only the audit row can tell them apart.
      detail: { permKey, subjectKind: subject.kind, subjectId: subject.id, changed: removed.value },
    });
    return Ok({ permKey, subject, changed: removed.value });
  }

  /** Both validations, in one place, so `grant` and `revoke` cannot drift apart. */
  private target(input: MutationInput): Result<{ permKey: string; subject: GrantSubject }, AppError> {
    const permKey = this.choosePermission(input.permission);
    if (!permKey.ok) return permKey;
    const subject = resolveSubject(input.user, input.role);
    if (!subject.ok) return subject;
    return Ok({ permKey: permKey.value, subject: subject.value });
  }

  /**
   * SC-11, server side.
   *
   * Discord explicitly permits a client to submit an autocomplete value that was never
   * offered, so the key is re-proven against `catalog.permissions()` here rather than trusted
   * because we suggested it. `toEnum` is the named door and performs the comparison; only its
   * sentence is replaced, because its own `nextStep` enumerates the entire allow-list, which
   * reads fine for four keys and is unusable for forty.
   *
   * `@core.public` is not in the catalog, so this refuses it too - and the port refuses it
   * again, by name, for a caller that never came through here.
   */
  private choosePermission(t: UserText): Result<string, AppError> {
    const chosen = toEnum(t, this.keys());
    return chosen.ok
      ? chosen
      : Err(errors.notFound('permission', 'Run `/access list` to see the permission keys this bot declares.'));
  }
}

/**
 * EXACTLY ONE OF user / role, checked SERVER SIDE.
 *
 * Discord cannot express "one of these two options is required" in a command payload, so both
 * are optional on the wire and neither, or both, really arrives. Neither is a user who forgot;
 * both is a user who is about to believe they granted two things and granted one.
 */
export function resolveSubject(user: UserId | undefined, role: RoleId | undefined): Result<GrantSubject, AppError> {
  if (user !== undefined && role !== undefined) {
    return Err(errors.validation('subject', 'You gave both a user and a role.', 'Run it again with one.'));
  }
  if (user !== undefined) return Ok({ kind: 'user', id: user });
  if (role !== undefined) return Ok({ kind: 'role', id: role });
  return Err(errors.validation('subject', 'No user or role given.', 'Add `user` or `role`.'));
}

/** `permKey - summary`, clipped to what Discord accepts for a choice label. */
function choiceName(p: CatalogPermission): string {
  const label = `${p.permKey} - ${p.summary}`;
  const chars = [...label];
  // Clipped by CODE POINT: slicing UTF-16 units splits a surrogate pair and Discord rejects it.
  return chars.length <= CHOICE_NAME_MAX ? label : `${chars.slice(0, CHOICE_NAME_MAX - 1).join('')}…`;
}
