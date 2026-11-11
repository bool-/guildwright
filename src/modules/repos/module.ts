/**
 * `/repo`, part 3: the wiring (RFC-001 PR 2.2, section 7.2).
 *
 * WHICH REPOSITORY A SERVER BUILDS IN. One bot instance may be configured for several GitHub
 * repositories (`GITHUB_REPOS_JSON`); this module lets the operator link each server to one of
 * them with `/repo use`, stored as `repo.target` in `core_settings`. A server with no link builds
 * in the `"default": true` repository; with one repository configured nothing needs doing at all.
 *
 * THE ONE LINE THAT IS THE WHOLE REVIEW is `capabilities`. `settings` to write the link, `audit`
 * to record who moved a server, `repos` to know what exists and what is in flight there. No `db`,
 * so no table of its own; no `issues`, `builds` or `secrets`, so it cannot file, spend or store
 * anything in any repository - it only decides where the NEXT request from a server goes.
 */

import { z } from 'zod';
import { defineModule } from '#core/module';
import { RepoRoutingService } from '#modules/repos/domain';
import { present, repoCommands } from '#modules/repos/present';

const MAIN = { key: 'main', fullName: 'acme/bot-modules', isDefault: true } as const;
const EVENTS = { key: 'events', fullName: 'acme/events-modules', isDefault: false } as const;

export default defineModule({
  id: 'repos', // MUST equal the folder name
  summary: 'Choose which repository each server\'s requests are built in.',
  capabilities: ['settings', 'audit', 'repos'],
  config: z.object({}),
  permissions: {
    /**
     * `nobody`, NOT `guild-admin` (RFC-001 7.2, "Resolved"): which trust domain a server's
     * requests land in is the operator's decision. The application owner passes as layer L0;
     * anybody else needs an explicit `/access grant repos.manage`.
     */
    manage: { summary: 'Link this server to one of the bot\'s repositories, or remove the link', fallback: 'nobody' },
    /** A server's own admins may see where its requests go. */
    view: { summary: 'See which repository this server builds in', fallback: 'guild-admin' },
  },
  publishes: {},
  migrations: false,

  setup(ctx) {
    const svc = new RepoRoutingService(ctx.ports.repos, ctx.ports.settings, ctx.ports.audit);
    return {
      commands: repoCommands(svc, ctx.perms), // the closure IS the dependency injection
      previews: {
        mapped: present.overview({
          target: { kind: 'mapped', repo: EVENTS },
          activity: [{ moduleId: 'builder', inFlight: 1, detail: 'builds ready; up to 4 agent runs per UTC day' }],
          guildInFlight: 1,
          configured: [
            { key: MAIN.key, isDefault: true },
            { key: EVENTS.key, isDefault: false },
          ],
        }),
        unlinked: present.overview({ target: { kind: 'none' }, activity: [], guildInFlight: 0, configured: [{ key: 'a', isDefault: false }, { key: 'b', isDefault: false }] }),
        stale: present.overview({ target: { kind: 'stale', key: 'gone' }, activity: [], guildInFlight: 0, configured: [{ key: MAIN.key, isDefault: true }] }),
        used: present.used({ repo: EVENTS, from: null, changed: true }),
        unchanged: present.used({ repo: EVENTS, from: EVENTS.key, changed: false }),
        cleared: present.cleared({ from: EVENTS.key, changed: true, fallback: MAIN }),
        clearedToNothing: present.cleared({ from: EVENTS.key, changed: true, fallback: null }),
        nothingToClear: present.cleared({ from: null, changed: false, fallback: MAIN }),
      },
      async health() {
        return { status: 'ok', detail: svc.summary() };
      },
    };
  },
});
