/**
 * `/access`, part 2: commands plus rendering. Every spec field is mandatory.
 *
 * THREE THINGS TO NOTICE, because each one is load-bearing:
 *
 *  1. `permission: perms.manage` on all three commands, and `access.manage` falls back to
 *     `guild-admin` - NOT to `nobody`. A `nobody` fallback here would deadlock the bootstrap
 *     exactly the way `builder.approve` does today: the command that hands out permissions
 *     would itself need a grant that only that command can make. Every server manager can
 *     already reconfigure the server; letting them configure the bot's allow-lists is the
 *     smallest fallback that is not a dead end.
 *
 *  2. The permission option is `autocomplete: true`, and the value that comes back is
 *     re-validated against `catalog.permissions()` inside the service. Discord permits a
 *     client to submit a value that was never offered (SC-11), so the suggestion list is a
 *     convenience and never the check.
 *
 *  3. `user` and `role` are both OPTIONAL on the wire, because Discord cannot express "exactly
 *     one of these". `resolveSubject` is what makes it exactly one, server side.
 */

import type { AutocompleteChoice, AutocompleteRequest, CommandOption, CommandSpec } from '#core/module';
import { md, mdInlineCode, mdMention } from '#core/text';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { GrantSubject } from '#core/ports';
import type { View, ViewNode } from '#core/view';
import type { AccessAdminService, AccessRow } from '#modules/access/domain';

/**
 * How many rows one `/access list` card carries.
 *
 * WHY it is capped at all: the renderer turns a table into a fenced code block inside an embed
 * description, and Discord rejects a description over 4096 characters - in front of the
 * operator, during exactly the incident where they are trying to find out who can approve.
 */
export const MAX_LIST_ROWS = 24;

/** `user:<id>` / `role:<id>` - the id, verbatim, because it is what `/access revoke` needs. */
export function describeSubject(s: GrantSubject): string {
  return `${s.kind}:${s.id}`;
}

/** A real mention: the id is one the bot parsed from a user/role option, never typed text. */
type Subject = { readonly kind: 'user' | 'role'; readonly id: string };

function mentionOf(s: Subject) {
  return mdMention(s.kind, s.id);
}

function describeSubjects(subjects: readonly GrantSubject[]): string {
  return subjects.length === 0 ? '-' : subjects.map(describeSubject).join(', ');
}

export const present = {
  /** The answer to "who can do what here". */
  overview(rows: readonly AccessRow[]): View {
    if (rows.length === 0) {
      return {
        accent: 'warn',
        ephemeral: true,
        nodes: [{ kind: 'text', md: md`No module declares a permission key, so there is nothing to grant.` }],
      };
    }
    const shown = rows.slice(0, MAX_LIST_ROWS);
    const nodes: ViewNode[] = [
      { kind: 'heading', text: 'Permissions in this server', icon: 'info' },
      {
        kind: 'table',
        head: ['permission', 'granted to', 'default'],
        rows: shown.map((r) => [r.permKey, describeSubjects(r.subjects), r.orphan ? 'orphaned' : r.fallback]),
      },
    ];
    if (rows.length > shown.length) {
      nodes.push({ kind: 'text', md: md`...and ${mdInlineCode(String(rows.length - shown.length))} more keys.` });
    }
    nodes.push({
      // The one sentence that turns a listing into an instruction. A key whose default is
      // `nobody` and whose "granted to" column is `-` works for NO ONE, including admins, and
      // that is invisible unless it is said out loud.
      kind: 'text',
      md: md`Default ${mdInlineCode('nobody')} with no grant means nobody can use it - not even a server manager. Use ${mdInlineCode('/access grant')}.`,
    });
    return { accent: 'info', ephemeral: true, nodes };
  },

  granted(permKey: string, subject: Subject): View {
    return {
      accent: 'ok',
      ephemeral: true,
      nodes: [{ kind: 'text', md: md`Granted ${mdInlineCode(permKey)} to ${mentionOf(subject)}.` }],
    };
  },

  /**
   * WHY the "nothing to revoke" arm is a VIEW and not an error: the operator asked for a state
   * ("this subject does not hold this key") that already holds. Reporting that as a failure is
   * how a correct command gets retried until something real breaks.
   */
  revoked(permKey: string, subject: Subject, changed: boolean): View {
    return changed
      ? {
          accent: 'ok',
          ephemeral: true,
          nodes: [{ kind: 'text', md: md`Revoked ${mdInlineCode(permKey)} from ${mentionOf(subject)}.` }],
        }
      : {
          accent: 'warn',
          ephemeral: true,
          nodes: [
            {
              kind: 'text',
              md: md`Nothing to revoke: ${mentionOf(subject)} did not hold ${mdInlineCode(permKey)}. Run ${mdInlineCode('/access list')} to see what is granted.`,
            },
          ],
        };
  },
};

/** The permission option, shared by grant and revoke so their payloads cannot drift. */
const PERMISSION_OPTION: CommandOption = {
  name: 'permission',
  description: 'Permission key, e.g. builder.approve',
  type: 'text',
  required: true,
  // Answered from the registry below. Never trusted: see `choosePermission`.
  autocomplete: true,
};

/** WHY both are optional: Discord has no "exactly one of". The service enforces it. */
const SUBJECT_OPTIONS: readonly CommandOption[] = [
  { name: 'user', description: 'Who to name (give exactly one of user or role)', type: 'user', required: false },
  { name: 'role', description: 'Which role to name (give exactly one of user or role)', type: 'role', required: false },
];

/** WHY the perms bag is typed by its keys: `perms.mange` is TS2551 with a suggestion. */
export function accessCommands(
  svc: AccessAdminService,
  perms: Readonly<Record<'manage', PermissionRef>>,
): readonly CommandSpec[] {
  /**
   * Shared by grant and revoke.
   * REQUIRED because an option above sets `autocomplete: true`: the registry refuses to boot
   * otherwise, naming the command and the option, because Discord would simply time out.
   */
  async function suggestPermission(req: AutocompleteRequest): Promise<readonly AutocompleteChoice[]> {
    return svc.suggest(req.partial);
  }

  return [
    {
      name: 'access list',
      description: 'Show who can do what in this server',
      // Grants are per guild, so there is nothing this could mean in a DM.
      surface: 'guild',
      options: [],
      permission: perms.manage,
      limit: [limit.perUser(10, 60_000)],
      needs: ['SendMessages'],
      ack: 'defer-ephemeral',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        return { kind: 'view', view: present.overview(svc.overview(guildId)) };
      },
    },
    {
      name: 'access grant',
      description: 'Grant a permission key to a user or a role',
      surface: 'guild',
      options: [PERMISSION_OPTION, ...SUBJECT_OPTIONS],
      permission: perms.manage,
      // Two buckets: handing out permissions is cheap per call and expensive in aggregate.
      limit: [limit.perUser(20, 3_600_000), limit.perGuild(100, 86_400_000)],
      needs: ['SendMessages'],
      ack: 'defer-ephemeral',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        const done = svc.grant({
          guildId,
          permission: inv.args.textRequired('permission'),
          user: inv.args.user('user'),
          role: inv.args.role('role'),
          actorId: inv.actor.userId,
        });
        return done.ok
          ? { kind: 'view', view: present.granted(done.value.permKey, done.value.subject) }
          : { kind: 'fail', error: done.error };
      },
      autocomplete: suggestPermission,
    },
    {
      name: 'access revoke',
      description: 'Take a permission key back from a user or a role',
      surface: 'guild',
      options: [PERMISSION_OPTION, ...SUBJECT_OPTIONS],
      permission: perms.manage,
      limit: [limit.perUser(20, 3_600_000), limit.perGuild(100, 86_400_000)],
      needs: ['SendMessages'],
      ack: 'defer-ephemeral',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        const done = svc.revoke({
          guildId,
          permission: inv.args.textRequired('permission'),
          user: inv.args.user('user'),
          role: inv.args.role('role'),
          actorId: inv.actor.userId,
        });
        return done.ok
          ? {
              kind: 'view',
              view: present.revoked(done.value.permKey, done.value.subject, done.value.changed),
            }
          : { kind: 'fail', error: done.error };
      },
      autocomplete: suggestPermission,
    },
  ];
}
