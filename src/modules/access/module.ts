/**
 * `/access`, part 3: the wiring. Zero core files are edited by this module.
 *
 * THE ONE LINE THAT IS THE WHOLE REVIEW is `capabilities`. This module can read the registry,
 * write the allow-list and write audit rows. It has NO `db`, so it cannot touch a table; no
 * `discord`, so it cannot post outside a reply; no `builds` or `issues`, so it cannot spend a
 * cent. It hands out authority and holds almost none.
 *
 * AND THE SECOND LINE IS `permissions.manage.fallback`. It is `guild-admin`, never `nobody`:
 * the command that hands out permissions must not itself need a grant that only it can make.
 * `builder.approve` falls back to `nobody` on purpose - it spends money - which is precisely
 * why a working `/access` has to exist before that default is survivable.
 */

import { z } from 'zod';
import { defineModule } from '#core/module';
import { AccessAdminService, type AccessRow } from '#modules/access/domain';
import { accessCommands, present } from '#modules/access/present';

/**
 * The state a fresh install is actually in, rendered at BOOT through the real component
 * compiler. Two declared keys, nobody named on either - which is the exact situation the
 * `nobody` line on the card exists to explain.
 */
const SAMPLE: readonly AccessRow[] = [
  {
    permKey: 'access.manage',
    summary: 'View, grant and revoke permission grants in this server',
    fallback: 'guild-admin',
    subjects: [],
    orphan: false,
  },
  {
    permKey: 'builder.approve',
    summary: 'Approve a build request',
    fallback: 'nobody',
    subjects: [],
    orphan: false,
  },
];

export default defineModule({
  id: 'access', // MUST equal the folder name
  summary: 'Choose who can use each bot feature in this server.',
  // One reviewable line = the whole blast radius. Read the absence: no db, no discord, no money.
  capabilities: ['access', 'catalog', 'audit'],
  config: z.object({}),
  permissions: {
    // NOT `nobody`. See the header: a `nobody` fallback here deadlocks the bootstrap.
    manage: { summary: 'View, grant and revoke permission grants in this server', fallback: 'guild-admin' },
  },
  publishes: {},
  migrations: false,

  setup(ctx) {
    const svc = new AccessAdminService(ctx.ports.access, ctx.ports.catalog, ctx.ports.audit);
    return {
      commands: accessCommands(svc, ctx.perms), // the closure IS the dependency injection
      previews: {
        empty: present.overview([]),
        list: present.overview(SAMPLE),
        granted: present.granted('builder.approve', { kind: 'role', id: '300000000000000001' }),
        revoked: present.revoked('builder.approve', { kind: 'user', id: '200000000000000001' }, true),
        nothing: present.revoked('builder.approve', { kind: 'user', id: '200000000000000001' }, false),
      },
      async health() {
        return { status: 'ok', detail: `${svc.keys().length} permission keys declared` };
      },
    };
  },
});
