/**
 * The golden path, part 4: the entire wiring. Zero core files are edited.
 *
 * This is section 9.2's `module.ts`, compiling against the final contracts. Two document
 * defects are fixed in place: `previews` referenced `present` and `SAMPLE` without importing
 * or defining either, and `capabilities` is now written inline (hoisting it behind a
 * `readonly Capability[]` annotation is a named compile error - see `LiteralCaps`).
 */

import { z } from 'zod';
import { defineModule } from '#core/module';
import { TagService } from '#modules/tags/domain';
import { tagsRepo, type Tag } from '#modules/tags/repo';
import { present, tagCommands } from '#modules/tags/present';

const SAMPLE: Tag = { name: 'deploy-notes', body: 'Run `npm run ci` first.', authorId: '111111111111111111' };

export default defineModule({
  id: 'tags', // MUST equal the folder name
  summary: 'Save and recall canned responses.',
  capabilities: ['db', 'audit', 'clock'], // one reviewable line = the whole blast radius
  config: z.object({
    maxPerGuild: z.coerce.number().int().positive().default(200),
    maxLength: z.coerce.number().int().max(4000).default(2000),
  }),
  permissions: {
    read: { summary: 'Use a tag', fallback: 'everyone' },
    write: { summary: 'Create or replace tags', fallback: 'guild-admin' },
  },
  publishes: {
    // Declared in events.d.ts, so a schema is REQUIRED here (TS2741 without it).
    'tags.saved': z.object({ guildId: z.string(), name: z.string() }),
  },
  migrations: true,

  setup(ctx) {
    const svc = new TagService(tagsRepo(ctx.ports.db), ctx.ports.audit, ctx.config);
    return {
      commands: tagCommands(svc, ctx.perms), // closure over the service - that IS the DI
      previews: { empty: present.list([]), one: present.tag(SAMPLE), saved: present.saved('deploy-notes') },
      async health() {
        return { status: 'ok', detail: `${svc.count()} tags` };
      },
    };
  },
});
