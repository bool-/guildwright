/**
 * `/help` and `/status` as an ORDINARY MODULE.
 *
 * WHY this file is part of the contract proof and not an afterthought: in both earlier designs
 * the registry was reachable only from core, so `/help`, `/status` and `/access` had to BE
 * core - which makes "everything user-visible is generated from the registry" true only if you
 * edit core, which AGENTS.md forbids. The `catalog` capability is what turns them back into
 * modules that a contributor could have written.
 *
 * Note what this module declares: `['catalog', 'version']`. It cannot read the database, cannot
 * post to Discord outside a reply, cannot spend money. That one line is the whole review.
 *
 * WHY `version` IS HERE AND NOT ON `admin`. Somebody files a bug report and the first question
 * of every triage is "which build is that against?" - and nothing in the process said. The boot
 * log printed the Node version, the pid and the database path; `/status` printed per-module
 * health. Establishing what was deployed meant SSHing to the host and running `git log`, which
 * answers what is CHECKED OUT rather than what is RUNNING, and which the person filing the
 * report cannot do at all. It is deliberately NOT on the operator-only `admin` capability: the
 * build line is the one field every bug report should carry, so it must not be readable only by
 * an admin. It is a package name, a version and a commit sha - nothing an operator would keep
 * out of a release note.
 */

import { z } from 'zod';
import { defineModule, type CommandSpec } from '#core/module';
import { joinSafe, md, mdInlineCode, sanitizeStored } from '#core/text';
import { PUBLIC } from '#core/policy';
import { limit } from '#core/ratelimit';
import { describeBuild, describeGithubAuth, type CatalogHealth, type CatalogPort, type VersionPort } from '#core/ports';
import type { View } from '#core/view';

function helpView(catalog: CatalogPort): View {
  const byModule = new Map<string, string[]>();
  for (const c of catalog.commands()) {
    const list = byModule.get(c.moduleId) ?? [];
    list.push(c.name);
    byModule.set(c.moduleId, list);
  }
  return {
    accent: 'info',
    ephemeral: true,
    nodes: [
      { kind: 'heading', text: 'Commands', icon: 'info' },
      ...catalog.modules().map((m) => {
        // One inline-code span per command, with the slash, so each can be read and copied.
        const commands = (byModule.get(m.id) ?? []).map((name) => mdInlineCode(`/${name}`));
        // A disabled module says why in user terms instead of showing its placeholder summary.
        const summary = sanitizeStored(m.quarantineReason ?? m.summary);
        return {
          kind: 'field' as const,
          name: m.id,
          md: commands.length === 0 ? summary : joinSafe([joinSafe(commands, ' '), summary], ' - '),
        };
      }),
    ],
  };
}

/**
 * `/status`, with the build identity on the bottom line.
 *
 * WHY THE BUILD LINE IS PART OF THE HEALTH CARD rather than its own command: the moment
 * somebody runs `/status` is the moment they are about to describe what they see to somebody
 * else, and "which build is this?" is the first thing that gets asked back. A separate
 * `/version` would be a command nobody remembers to run before filing the report.
 *
 * `describeBuild` is core's renderer, not one written here, and that matters: it prints
 * `no git sha` OUT LOUD when the process genuinely cannot tell - a container built from a
 * tarball has no `.git`. An empty pair of parentheses reads as a formatting bug and gets
 * ignored; the words read as the fact they are.
 */
function statusView(rows: readonly CatalogHealth[], version: VersionPort): View {
  return {
    accent: rows.some((r) => r.status === 'down') ? 'error' : rows.some((r) => r.status === 'degraded') ? 'warn' : 'ok',
    ephemeral: true,
    nodes: [
      { kind: 'heading', text: 'Bot status', icon: 'info' },
      ...rows.map((r) => ({
        kind: 'field' as const,
        name: r.moduleId,
        md: md`${mdInlineCode(r.status)} ${mdInlineCode(r.detail)}`,
      })),
      // "Running as what?" is the next triage question after "which build?": a PAT with an
      // expiry date, or an App installation an admin can see and revoke in the repo settings.
      { kind: 'text', md: md`${mdInlineCode(describeGithubAuth(version.githubAuth()))}` },
      { kind: 'text', md: md`${mdInlineCode(describeBuild(version.current()))}` },
    ],
  };
}

export default defineModule({
  id: 'help',
  summary: 'Show what the bot can do and whether each part is healthy.',
  capabilities: ['catalog', 'version'],
  config: z.object({}),
  permissions: {},
  publishes: {},
  migrations: false,

  setup(ctx) {
    const commands: readonly CommandSpec[] = [
      {
        name: 'help',
        description: 'List the commands this bot has',
        surface: 'both',
        options: [],
        // PUBLIC is the explicit, greppable opt-out. An omitted field would be TS2741.
        permission: PUBLIC,
        limit: [limit.perUser(5, 60_000)],
        needs: [],
        ack: 'defer-ephemeral',
        async handle() {
          return { kind: 'view', view: helpView(ctx.ports.catalog) };
        },
      },
      {
        name: 'status',
        description: 'Show module health',
        surface: 'both',
        options: [],
        permission: PUBLIC,
        limit: [limit.perUser(5, 60_000)],
        needs: [],
        ack: 'defer-ephemeral',
        async handle() {
          // Every check is raced against a deadline by the aggregator, so one hung module
          // cannot hang /status for the rest - during exactly the incident when it matters.
          const rows = await ctx.ports.catalog.health();
          return { kind: 'view', view: statusView(rows, ctx.ports.version) };
        },
      },
    ];

    return {
      commands,
      previews: {
        help: helpView(ctx.ports.catalog),
        // Rendered at boot through the real compiler, so the build footer cannot be the thing
        // that breaks `/status` during an incident.
        status: statusView(
          [{ moduleId: 'builder', status: 'ok', detail: 'ready' }],
          ctx.ports.version,
        ),
      },
      async health() {
        return { status: 'ok', detail: `${ctx.ports.catalog.commands().length} commands indexed` };
      },
    };
  },
});
