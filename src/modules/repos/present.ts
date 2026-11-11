/**
 * `/repo`, part 2: the three commands and their views. Every spec field is mandatory.
 *
 * THE TWO PERMISSION KEYS, and why they differ (RFC-001 7.2):
 *
 *  - `repos.manage` (`/repo use`, `/repo clear`) falls back to `nobody`: the operator only
 *    (`DISCORD_OWNER_ID` passes as the application owner) or an explicit `/access grant`. Which
 *    repository - which trust domain - a server's requests land in is the operator's decision;
 *    a server admin must not be able to point their server at another of the operator's
 *    repositories.
 *  - `repos.view` (`/repo show`) falls back to `guild-admin`: a server's own admins may see where
 *    its requests go and what is in flight there.
 */

import type { AutocompleteChoice, AutocompleteRequest, CommandSpec } from '#core/module';
import { joinSafe, md, mdInlineCode, sanitizeStored, type SafeMarkdown } from '#core/text';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import type { View, ViewNode } from '#core/view';
import type { ActivityLine, ClearOutcome, RepoLabel, RepoOverview, RepoRoutingService, UseOutcome } from '#modules/repos/domain';

/** `main` (acme/bot-modules), as inline code and plain text. */
function named(repo: RepoLabel): SafeMarkdown {
  return md`${mdInlineCode(repo.key)} (${mdInlineCode(repo.fullName)})`;
}

function count(n: number): SafeMarkdown {
  return mdInlineCode(String(n));
}

/** Where a guild's new requests go, in one sentence per arm of `ReposPort.target`. */
function targetLine(t: RepoOverview['target']): SafeMarkdown {
  switch (t.kind) {
    case 'mapped':
      return md`This server builds in ${named(t.repo)}, linked with ${mdInlineCode('/repo use')}.`;
    case 'default':
      return md`This server is not linked to a repository, so it builds in the default one, ${named(t.repo)}.`;
    case 'stale':
      return md`This server is linked to ${mdInlineCode(t.key)}, which this bot is no longer configured for, so nothing can be built from it. The bot operator runs ${mdInlineCode('/repo use')} here to link it again.`;
    case 'none':
      return md`This server is not linked to a repository yet, so nothing can be built from it. The bot operator runs ${mdInlineCode('/repo use')} here to link it.`;
    default: {
      const exhaustive: never = t;
      void exhaustive;
      return md`This server is not linked to a repository yet.`;
    }
  }
}

function activityField(a: ActivityLine): ViewNode {
  // `detail` is a module's own sentence from a port - never user text - and is re-scrubbed on
  // the way into markdown all the same.
  return { kind: 'field', name: a.moduleId, md: md`${count(a.inFlight)} in flight here; ${sanitizeStored(a.detail)}` };
}

export const present = {
  /** `/repo show`: the mapping, the repository's health and caps, and what is in flight there. */
  overview(o: RepoOverview): View {
    const nodes: ViewNode[] = [
      { kind: 'heading', text: 'Repository for this server', icon: 'info' },
      { kind: 'text', md: targetLine(o.target) },
      ...o.activity.map(activityField),
      {
        kind: 'text',
        md: md`${count(o.guildInFlight)} of this server's requests are still in flight. Requests keep the repository they were filed in when the link changes.`,
      },
      {
        kind: 'text',
        md: md`Configured repositories: ${joinSafe(o.configured.map((c) => (c.isDefault ? md`${mdInlineCode(c.key)} (default)` : mdInlineCode(c.key))), ', ')}.`,
      },
    ];
    const ok = o.target.kind === 'mapped' || o.target.kind === 'default';
    return { accent: ok ? 'info' : 'warn', ephemeral: true, nodes };
  },

  used(u: UseOutcome): View {
    return {
      accent: 'ok',
      ephemeral: true,
      nodes: [
        {
          kind: 'text',
          md: u.changed
            ? md`Linked. New requests from this server build in ${named(u.repo)}. Requests already filed stay in the repository they were filed in.`
            : md`Nothing changed: this server was already linked to ${named(u.repo)}.`,
        },
      ],
    };
  },

  /** WHY "nothing to clear" is a view and not an error: the state asked for already holds. */
  cleared(c: ClearOutcome): View {
    const where =
      c.fallback === null
        ? md`No repository is the default, so nothing can be built from this server until ${mdInlineCode('/repo use')} links it again.`
        : md`New requests from this server build in the default repository, ${named(c.fallback)}.`;
    return c.changed
      ? { accent: 'ok', ephemeral: true, nodes: [{ kind: 'text', md: md`Unlinked. ${where}` }] }
      : {
          accent: 'warn',
          ephemeral: true,
          nodes: [{ kind: 'text', md: md`Nothing to clear: this server was not linked with ${mdInlineCode('/repo use')}. ${where}` }],
        };
  },
};

/** WHY the perms bag is typed by its keys: `perms.mange` is TS2551 with a suggestion. */
export function repoCommands(svc: RepoRoutingService, perms: Readonly<Record<'manage' | 'view', PermissionRef>>): readonly CommandSpec[] {
  /**
   * REQUIRED because `key` sets `autocomplete: true`. Keys only, never `owner/repo`: the router
   * answers an autocomplete without checking the command's permission (see `suggest`).
   */
  async function suggestKey(req: AutocompleteRequest): Promise<readonly AutocompleteChoice[]> {
    return svc.suggest(req.partial);
  }

  return [
    {
      name: 'repo use',
      description: 'Link this server to one of the bot\'s repositories (operator only by default)',
      // A link is per guild; there is nothing it could mean in a DM.
      surface: 'guild',
      options: [
        {
          name: 'key',
          description: 'Repository key, as configured in GITHUB_REPOS_JSON',
          type: 'text',
          required: true,
          // A suggestion list, never the check: `use` re-validates against the configured set.
          autocomplete: true,
          minLength: 1,
          maxLength: 31,
        },
      ],
      permission: perms.manage,
      limit: [limit.perUser(20, 3_600_000), limit.perGuild(50, 86_400_000)],
      needs: ['SendMessages'],
      // It reads and writes `core_settings` (SQLite), so it defers like everything that does.
      ack: 'defer-ephemeral',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        const done = svc.use({ guildId, key: inv.args.textRequired('key'), actorId: inv.actor.userId });
        return done.ok ? { kind: 'view', view: present.used(done.value) } : { kind: 'fail', error: done.error };
      },
      autocomplete: suggestKey,
    },
    {
      name: 'repo show',
      description: 'Show which repository this server builds in, and what is in flight there',
      surface: 'guild',
      options: [],
      permission: perms.view,
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
      name: 'repo clear',
      description: 'Remove this server\'s repository link (refused while a request is in flight)',
      surface: 'guild',
      options: [],
      permission: perms.manage,
      limit: [limit.perUser(20, 3_600_000), limit.perGuild(50, 86_400_000)],
      needs: ['SendMessages'],
      ack: 'defer-ephemeral',
      async handle(inv) {
        const guildId = inv.space.guildId;
        if (guildId === null) return { kind: 'silent' };
        const done = svc.clear({ guildId, actorId: inv.actor.userId });
        return done.ok ? { kind: 'view', view: present.cleared(done.value) } : { kind: 'fail', error: done.error };
      },
    },
  ];
}
