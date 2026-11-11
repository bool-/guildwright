/**
 * `/repo use|show|clear` (RFC-001 PR 2.2, section 7.2), against the REAL settings adapter and the
 * REAL `ReposPort` wired exactly as the composition root wires it: `createReposPort(set,
 * repoTargetReader(settings), activity)`. So "after /repo use, the guild resolves there" is
 * asserted through the same `core_settings` row the builder's front door reads.
 *
 * Authorization is asserted against the REAL access adapter (`fakeAccess` allows everything),
 * with the fallbacks read from the SHIPPED manifest, so changing `manage.fallback` in module.ts
 * fails here. The router's half - a denied `/repo use` never reaches the handler and is audited -
 * is in `src/adapters/discord/router.test.ts`, driven with this module's real command.
 *
 * A test file may import an adapter: the module import wall applies to non-test files only.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createEventBus } from '#core/events';
import { newRequestId, toChannelId, toGuildId, toRoleId, toUserId, type GuildId, type RoleId, type UserId } from '#core/ids';
import type { Args } from '#core/args';
import type { CommandSpec, InstalledModule, Invocation, Outcome, ProgressHandle } from '#core/module';
import { permissionRef } from '#core/policy';
import { renderSafeMarkdown, userTextForTest } from '#core/text';
import { Err } from '#core/result';
import { errors } from '#core/errors';
import type { SurfaceRef, View } from '#core/view';
import type { CatalogPort } from '#core/ports';
import {
  REPO_TARGET_SETTING,
  createRepoSet,
  createReposPort,
  readRepoTarget,
  repoTargetReader,
  repoTargetValue,
  type RepoActivityReport,
  type RepoSet,
  type RepoSetEntry,
} from '#core/ports/repos';
import { fakeAudit, fakeLogger, type FakeAudit } from '#testing/fakes';

import { createAccess, fallbacksFromCatalog } from '#adapters/system/access';
import { createSettings, type SettingsStore } from '#adapters/system/settings';
import { createTestDb } from '#adapters/system/testdb';
import { manualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';

import reposModule from '#modules/repos/module';
import { UNKNOWN_REPO_DETAIL, UNKNOWN_REPO_NEXT_STEP } from '#modules/repos/domain';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const MANAGE_GUILD = 1n << 5n;

function guildId(raw = '100000000000000001'): GuildId {
  const r = toGuildId(raw);
  if (!r.ok) throw new Error('fixture');
  return r.value;
}
function userId(raw: string): UserId {
  const r = toUserId(raw);
  if (!r.ok) throw new Error('fixture');
  return r.value;
}
function roleId(raw: string): RoleId {
  const r = toRoleId(raw);
  if (!r.ok) throw new Error('fixture');
  return r.value;
}

const GUILD = guildId();
const OPERATOR = userId('200000000000000001');

const TWO: readonly RepoSetEntry[] = [
  { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: true },
  { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
];

function minted(entries: readonly RepoSetEntry[]): RepoSet {
  const r = createRepoSet(entries);
  if (!r.ok) throw new Error('fixture');
  return r.value;
}

interface Rig {
  readonly installed: InstalledModule;
  readonly settings: SettingsStore;
  readonly audit: FakeAudit;
  readonly set: RepoSet;
  /** What the "builder" reports: requests in flight for the guild, and per repository. */
  readonly inFlight: { guild: number; repo: number };
  command(name: string): CommandSpec;
}

/** The real module over the real settings adapter and the real port, as `main.ts` wires them. */
function rig(entries: readonly RepoSetEntry[] = TWO): Rig {
  const db = createTestDb();
  const settings = createSettings({ db, clock: manualClock(), logger: silentLogger() });
  const audit = fakeAudit();
  const set = minted(entries);
  const inFlight = { guild: 0, repo: 0 };
  const activity: readonly RepoActivityReport[] = [
    {
      moduleId: 'builder',
      inFlightForGuild: () => inFlight.guild,
      inRepo: () => ({ inFlight: inFlight.repo, detail: 'builds ready; up to 4 agent runs per UTC day' }),
    },
  ];
  const repos = createReposPort(set, repoTargetReader(settings), () => activity);
  const r = reposModule.install({ ports: { settings, audit, repos }, rawConfig: {}, bus: createEventBus(() => undefined), logger: fakeLogger() });
  assert.ok(r.ok, r.ok ? '' : `the repos module must install: ${r.error.code}`);
  if (!r.ok) throw new Error('unreachable');
  const installed = r.value;
  return {
    installed,
    settings,
    audit,
    set,
    inFlight,
    command(name) {
      const found = installed.commands.find((c) => c.name === name);
      assert.ok(found !== undefined, `the repos module must declare "${name}"`);
      if (found === undefined) throw new Error('unreachable');
      return found;
    },
  };
}

/**
 * The one cast in this file, and it is structural: `ProgressHandle` carries a module-private
 * symbol so a live interaction token cannot reach a durable payload, and the router does this
 * same cast for the same reason. Nothing on the `/repo` path reads it.
 */
function progress(): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => ({ guildId: GUILD, channelId: '300000000000000009', messageId: '400000000000000001' }),
  };
  return stub as unknown as ProgressHandle;
}

function args(key: string | undefined): Args {
  const cannot = (name: string) => Err(errors.validation(name, 'not modelled by this fixture', 'Use text.'));
  return {
    names: key === undefined ? [] : ['key'],
    text: (name) => (name === 'key' && key !== undefined ? userTextForTest(key) : undefined),
    textRequired(name) {
      if (name !== 'key' || key === undefined) throw new Error(`no option "${name}"`);
      return userTextForTest(key);
    },
    integer: (name) => cannot(name),
    bool: () => undefined,
    user: () => undefined,
    role: () => undefined,
    channel: () => undefined,
    choice: (name) => cannot(name),
  };
}

function invocation(key?: string, guild: GuildId = GUILD): Invocation {
  const channel = toChannelId('300000000000000009');
  if (!channel.ok) throw new Error('fixture');
  return {
    id: newRequestId(NOW),
    actor: { userId: OPERATOR, roleIds: [], isAppOwner: true, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guild, channelId: channel.value },
    args: args(key),
    progress: progress(),
    at: NOW,
  };
}

/** Every string a `View` would put in front of a user. */
function viewText(view: View): string {
  const out: string[] = [];
  for (const node of view.nodes) {
    if (node.kind === 'text') out.push(renderSafeMarkdown(node.md));
    else if (node.kind === 'heading') out.push(node.text);
    else if (node.kind === 'field') out.push(node.name, renderSafeMarkdown(node.md));
  }
  return out.join('\n');
}

function viewOf(o: Outcome): string {
  assert.equal(o.kind, 'view', o.kind === 'fail' ? `refused: ${o.error.code}` : o.kind);
  return o.kind === 'view' ? viewText(o.view) : '';
}

// ---------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------

test('the blast radius is exactly settings, audit and repos; three guild commands under /repo', () => {
  assert.deepEqual([...reposModule.manifest.capabilities], ['settings', 'audit', 'repos']);
  const r = rig();
  assert.deepEqual(r.installed.commands.map((c) => c.name), ['repo use', 'repo show', 'repo clear']);
  for (const c of r.installed.commands) {
    assert.equal(c.surface, 'guild', `${c.name}: a link is per server`);
    assert.deepEqual(c.needs, ['SendMessages'], `${c.name}: no new bot permission, so no re-invite`);
  }
  assert.equal(r.command('repo use').permission.key, 'manage');
  assert.equal(r.command('repo clear').permission.key, 'manage');
  assert.equal(r.command('repo show').permission.key, 'view');
});

// ---------------------------------------------------------------------------------------
// The mapping's storage
// ---------------------------------------------------------------------------------------

test('repo.target: written as { key }, read back through readRepoTarget over the REAL settings adapter', () => {
  const db = createTestDb();
  const settings = createSettings({ db, clock: manualClock(), logger: silentLogger() });
  const set = minted(TWO);
  const port = createReposPort(set, repoTargetReader(settings));
  const g = guildId('100000000000000004');
  const events = set.byKey('events');
  assert.ok(events !== null);

  assert.equal(port.resolve(g)?.key, 'main', 'unset: the default');
  settings.set(g, REPO_TARGET_SETTING, repoTargetValue(events));
  assert.deepEqual(settings.get(g, 'repo.target'), { key: 'events' }, "the RFC's key and value shape");
  assert.equal(port.resolve(g)?.key, 'events', 'read on every call: no restart after /repo use');

  // A hand-edited or unparseable value reads as UNSET, never half-applied.
  for (const bad of [{ key: 7 }, { key: 'Not A Key' }, { other: 'events' }]) {
    settings.set(g, REPO_TARGET_SETTING, bad);
    assert.equal(readRepoTarget(settings, g), null, JSON.stringify(bad));
    assert.equal(port.resolve(g)?.key, 'main');
  }

  assert.equal(settings.clear(g, REPO_TARGET_SETTING), true, '`clear` is on the port now: /repo clear removes the row');
  assert.equal(settings.get(g, REPO_TARGET_SETTING), undefined);
  assert.equal(settings.clear(g, REPO_TARGET_SETTING), false, 'and says when there was nothing to remove');
});

// ---------------------------------------------------------------------------------------
// /repo use
// ---------------------------------------------------------------------------------------

test('/repo use with a key outside the configured set is REFUSED with the RFC sentence, and nothing is stored', async () => {
  const r = rig();
  // A forged value (Discord lets a client submit anything), a near miss, and an owner/repo name.
  for (const key of ['nope', 'Main', 'acme/events-modules', 'gone']) {
    const out = await r.command('repo use').handle(invocation(key));
    assert.equal(out.kind, 'fail', key);
    if (out.kind !== 'fail') continue;
    assert.equal(out.error.kind, 'validation');
    assert.equal(out.error.userDetail, UNKNOWN_REPO_DETAIL);
    assert.equal(out.error.nextStep, UNKNOWN_REPO_NEXT_STEP);
    assert.equal(`${out.error.userDetail} ${out.error.nextStep}`, 'That is not a repository this bot is configured for. An operator adds it to GITHUB_REPOS_JSON.');
  }
  assert.equal(r.settings.get(GUILD, REPO_TARGET_SETTING), undefined, 'nothing written');
  assert.deepEqual(r.audit.entries, [], 'and nothing audited, because nothing changed');
});

test('/repo use links the guild, is audited as repos.use { guildId, from, to }, and moves only NEW requests', async () => {
  const r = rig();
  const port = createReposPort(r.set, repoTargetReader(r.settings));

  const first = viewOf(await r.command('repo use').handle(invocation('events')));
  assert.match(first, /Linked\. New requests from this server build in `events` \(`acme\/events-modules`\)\./u);
  assert.match(first, /Requests already filed stay in the repository they were filed in/u);
  assert.equal(port.resolve(GUILD)?.key, 'events', 'the row the builder\'s front door reads');
  assert.equal(port.resolve(guildId('100000000000000002'))?.key, 'main', 'another guild is untouched');
  assert.deepEqual(r.audit.entries.at(-1), {
    action: 'repos.use',
    actorId: OPERATOR,
    guildId: GUILD,
    detail: { guildId: GUILD, from: null, to: 'events' },
  });

  await r.command('repo use').handle(invocation('main'));
  assert.deepEqual(r.audit.entries.at(-1)?.detail, { guildId: GUILD, from: 'events', to: 'main' });

  const again = viewOf(await r.command('repo use').handle(invocation('main')));
  assert.match(again, /Nothing changed: this server was already linked to `main`/u);
  assert.equal(r.audit.entries.length, 2, 'an unchanged link is not audited');
});

test('/repo use autocompletes KEYS ONLY - never owner/repo - because autocomplete is not permission-checked', async () => {
  const r = rig();
  const spec = r.command('repo use');
  assert.equal(spec.options[0]?.autocomplete, true);
  assert.ok(spec.autocomplete !== undefined);
  const answer = async (partial: string) =>
    spec.autocomplete?.({
      actor: invocation().actor,
      space: invocation().space,
      option: 'key',
      partial: userTextForTest(partial),
      at: NOW,
    }) ?? [];
  assert.deepEqual(await answer(''), [
    { name: 'main (default)', value: 'main' },
    { name: 'events', value: 'events' },
  ]);
  assert.deepEqual(await answer('ev'), [{ name: 'events', value: 'events' }]);
  assert.ok(!JSON.stringify(await answer('')).includes('acme'), 'no repository name leaks to whoever opens the command');
});

// ---------------------------------------------------------------------------------------
// /repo clear
// ---------------------------------------------------------------------------------------

test('/repo clear REFUSES while a request from this guild is in flight, then clears and is audited', async () => {
  const r = rig();
  await r.command('repo use').handle(invocation('events'));
  r.inFlight.guild = 1;

  const refused = await r.command('repo clear').handle(invocation());
  assert.equal(refused.kind, 'fail');
  if (refused.kind === 'fail') {
    assert.equal(refused.error.code, 'conflict.repos.in_flight');
    assert.match(refused.error.userDetail, /This server has 1 request\(s\) still in flight/u);
    assert.match(refused.error.nextStep, /\/request cancel/u);
  }
  assert.deepEqual(r.settings.get(GUILD, REPO_TARGET_SETTING), { key: 'events' }, 'the link is untouched');
  assert.equal(r.audit.entries.filter((e) => e.action === 'repos.clear').length, 0);

  r.inFlight.guild = 0;
  const cleared = viewOf(await r.command('repo clear').handle(invocation()));
  assert.match(cleared, /Unlinked\. New requests from this server build in the default repository, `main` \(`acme\/bot-modules`\)\./u);
  assert.equal(r.settings.get(GUILD, REPO_TARGET_SETTING), undefined);
  assert.deepEqual(r.audit.entries.at(-1), { action: 'repos.clear', actorId: OPERATOR, guildId: GUILD, detail: { guildId: GUILD, from: 'events' } });

  const nothing = viewOf(await r.command('repo clear').handle(invocation()));
  assert.match(nothing, /Nothing to clear/u);
  assert.equal(r.audit.entries.filter((e) => e.action === 'repos.clear').length, 1, 'a no-op is not audited');
});

test('/repo clear with no default repository says plainly that nothing can be built until /repo use', async () => {
  const r = rig([
    { key: 'a', owner: 'acme', repo: 'a', isDefault: false },
    { key: 'b', owner: 'acme', repo: 'b', isDefault: false },
  ]);
  await r.command('repo use').handle(invocation('a'));
  const text = viewOf(await r.command('repo clear').handle(invocation()));
  assert.match(text, /No repository is the default, so nothing can be built from this server until `\/repo use` links it again/u);
});

// ---------------------------------------------------------------------------------------
// /repo show
// ---------------------------------------------------------------------------------------

test('/repo show: the mapping, the repository\'s health and cap (from the builder), and what is in flight', async () => {
  const r = rig();
  r.inFlight.guild = 2;
  r.inFlight.repo = 3;

  const unlinked = viewOf(await r.command('repo show').handle(invocation()));
  assert.match(unlinked, /not linked to a repository, so it builds in the default one, `main` \(`acme\/bot-modules`\)/u);
  assert.match(unlinked, /builder\n`3` in flight here; builds ready; up to 4 agent runs per UTC day/u);
  assert.match(unlinked, /`2` of this server's requests are still in flight/u);
  assert.match(unlinked, /Configured repositories: `main` \(default\), `events`\./u);

  await r.command('repo use').handle(invocation('events'));
  const linked = viewOf(await r.command('repo show').handle(invocation()));
  assert.match(linked, /This server builds in `events` \(`acme\/events-modules`\), linked with `\/repo use`/u);
  assert.ok(!linked.includes('bot-modules'), "another repository's name is not this server's business");
});

test('/repo show: a link to a repository the operator removed reads STALE, not "the default"', async () => {
  const r = rig();
  r.settings.set(GUILD, REPO_TARGET_SETTING, { key: 'gone' });
  const text = viewOf(await r.command('repo show').handle(invocation()));
  assert.match(text, /linked to `gone`, which this bot is no longer configured for, so nothing can be built from it/u);
  assert.ok(!text.includes('in flight here'), 'no repository, so no per-repository line');

  // ...and /repo clear removes a stale link like any other.
  assert.match(viewOf(await r.command('repo clear').handle(invocation())), /Unlinked/u);
});

// ---------------------------------------------------------------------------------------
// Who may do it: the REAL access adapter, the SHIPPED fallbacks
// ---------------------------------------------------------------------------------------

test('repos.manage falls back to NOBODY: a server admin is denied, the operator and an explicit grant are allowed', () => {
  const manage = reposModule.manifest.permissions['manage'];
  const view = reposModule.manifest.permissions['view'];
  assert.equal(manage?.fallback, 'nobody', 'RFC-001 7.2: which trust domain a server lands in is the operator\'s call');
  assert.equal(view?.fallback, 'guild-admin');
  if (manage === undefined || view === undefined) return;

  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const settings = createSettings({ db, clock, logger });
  const catalog: CatalogPort = {
    modules: () => [],
    commands: () => [],
    permissions: () => [
      { moduleId: 'repos', key: 'manage', permKey: 'repos.manage', summary: manage.summary, fallback: manage.fallback },
      { moduleId: 'repos', key: 'view', permKey: 'repos.view', summary: view.summary, fallback: view.fallback },
    ],
    health: async () => [],
  };
  const access = createAccess({ db, clock, logger, settings, fallbacks: fallbacksFromCatalog(catalog) });
  const manageRef = permissionRef('repos', 'manage');
  const viewRef = permissionRef('repos', 'view');

  const admin = { userId: userId('200000000000000002'), roleIds: [] as readonly RoleId[], memberPermissions: MANAGE_GUILD, isAppOwner: false };
  const member = { userId: userId('200000000000000003'), roleIds: [] as readonly RoleId[], memberPermissions: 0n, isAppOwner: false };
  const owner = { userId: OPERATOR, roleIds: [] as readonly RoleId[], memberPermissions: 0n, isAppOwner: true };

  assert.equal(access.check(GUILD, manageRef, admin).allowed, false, 'Manage Server is NOT enough to move a server between repositories');
  assert.equal(access.check(GUILD, manageRef, member).allowed, false);
  assert.equal(access.check(GUILD, manageRef, owner).allowed, true, 'DISCORD_OWNER_ID passes as the application owner');
  assert.equal(access.check(GUILD, viewRef, admin).allowed, true, 'a server admin may SEE where its requests go');
  assert.equal(access.check(GUILD, viewRef, member).allowed, false);

  const delegate = roleId('300000000000000001');
  assert.ok(access.grantByKey(GUILD, 'repos.manage', { kind: 'role', id: delegate }, OPERATOR).ok, 'grantable with /access grant');
  assert.equal(access.check(GUILD, manageRef, { ...member, roleIds: [delegate] }).allowed, true);
});

test('health says how many repositories are configured and which is the default', async () => {
  assert.deepEqual(await rig().installed.health(), { status: 'ok', detail: '2 repositories configured; default main' });
});
