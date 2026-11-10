/**
 * The golden path, part 3: commands plus rendering. Every field is mandatory.
 *
 * Two contract changes from the design document are visible here and both are deliberate:
 *  - `literal(t.body)` is gone. A database column is a plain `string`, so re-blessing it was
 *    the laundering hole; `sanitizeStored` re-runs the scrubber on the way out, and the
 *    developer-literal door is the `md` TEMPLATE TAG, which a runtime string cannot enter.
 *  - `limit` is a LIST, because SC-9 asks for two buckets on one command.
 */

import type { CommandSpec } from '#core/module';
import { md, mdInlineCode, sanitizeStored } from '#core/text';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { View } from '#core/view';
import { MAX_AUTOCOMPLETE_CHOICES } from '#core/module';
import type { Tag } from '#modules/tags/repo';
import type { TagService } from '#modules/tags/domain';

export const present = {
  tag: (t: Tag): View => ({ accent: 'ok', nodes: [{ kind: 'text', md: sanitizeStored(t.body) }] }),
  list: (ts: readonly Tag[]): View => ({
    accent: 'ok',
    ephemeral: true,
    nodes:
      ts.length === 0
        ? [{ kind: 'text', md: md`No tags yet. Create one with ${mdInlineCode('/tag set')}.` }]
        : [
            { kind: 'heading', text: 'Tags', icon: 'info' },
            { kind: 'table', head: ['name', 'author'], rows: ts.map((t) => [t.name, `user:${t.authorId}`]) },
          ],
  }),
  saved: (name: string): View => ({
    accent: 'ok',
    ephemeral: true,
    nodes: [{ kind: 'text', md: md`Saved ${mdInlineCode(name)}.` }],
  }),
};

/** WHY the perms bag is typed by its keys: `perms.wirte` is TS2551 with a suggestion. */
export function tagCommands(
  svc: TagService,
  perms: Readonly<Record<'read' | 'write', PermissionRef>>,
): readonly CommandSpec[] {
  return [
    {
      name: 'tag get',
      description: 'Show a saved tag',
      surface: 'guild',
      options: [{ name: 'name', description: 'tag name', type: 'text', required: true, autocomplete: true }],
      permission: perms.read, // REQUIRED - omitting it is TS2741
      limit: [limit.perUser(20, 60_000)], // REQUIRED - NO_LIMIT to opt out
      needs: ['SendMessages'], // REQUIRED - [] if none
      ack: 'defer',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        const r = svc.get(guildId, inv.args.textRequired('name'));
        return r.ok ? { kind: 'view', view: present.tag(r.value) } : { kind: 'fail', error: r.error };
      },
      /**
       * REQUIRED because an option above sets `autocomplete: true`. Without it the registry
       * refuses to boot, naming the command and the option - both earlier designs let this
       * ship and Discord simply timed out in front of the user.
       */
      async autocomplete(req) {
        const guildId = req.space.guildId;
        if (guildId === null) return [];
        return svc
          .list(guildId, MAX_AUTOCOMPLETE_CHOICES)
          .map((t) => ({ name: t.name, value: t.name }))
          .slice(0, MAX_AUTOCOMPLETE_CHOICES);
      },
    },
    {
      name: 'tag set',
      description: 'Create or replace a tag',
      surface: 'guild',
      options: [
        { name: 'name', description: 'tag name', type: 'text', required: true },
        { name: 'body', description: 'tag body', type: 'text', required: true },
      ],
      permission: perms.write,
      limit: [limit.perUser(10, 3_600_000), limit.perGuild(200, 86_400_000)],
      needs: ['SendMessages'],
      ack: 'defer-ephemeral',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        const r = svc.set(
          guildId,
          inv.args.textRequired('name'),
          inv.args.textRequired('body'),
          inv.actor.userId,
          inv.at,
        );
        return r.ok ? { kind: 'view', view: present.saved(r.value.name) } : { kind: 'fail', error: r.error };
      },
    },
  ];
}
