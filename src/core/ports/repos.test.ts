/**
 * The repository set as a port (RFC-001 PR 2.1, sections 7.2 and 7.4): `RepoRef`, `ReposPort`,
 * `RepoScoped<T>.at()`, and the `repos` capability.
 *
 * WHAT IS ASSERTED, AND WHY EACH IS WORTH IT:
 *  - `RepoScoped.at` hands back the port of THE ref it was given, and refuses a ref minted by a
 *    different set even when every field is equal: routing is by identity, so a module that
 *    assembled a look-alike reaches nothing.
 *  - `resolve` is the RFC's "mapping, else the default, else null". A mapped key that is no longer
 *    configured is `stale` and resolves to NOTHING (PR 2.2): not another set's ref, and not the
 *    default either, because the default is another of the operator's trust domains.
 *  - `activity()` is late-bound: it reports what modules installed after the port was built.
 *  - `byKey` re-validates a persisted key against THIS process's set.
 *  - The `repos` capability narrows `ctx.ports` at compile time (TS2339, AGENTS.md rule 6, proved
 *    by the `@ts-expect-error` lines, which `npm run typecheck` fails if they stop being errors)
 *    and at runtime (the port is absent from the bag, not merely untyped).
 *  - A module cannot write a `RepoRef` literal: the brand is a module-private symbol.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';

import { defineModule } from '#core/module';
import { createEventBus } from '#core/events';
import { ALL_CAPABILITIES, portsFor, type RepoRef, type ReposPort } from '#core/ports';
import { toGuildId, type GuildId } from '#core/ids';
import {
  createRepoSet,
  createReposPort,
  repoScoped,
  type RepoActivityReport,
  type RepoSet,
} from '#core/ports/repos';
import { fakeLogger, fakePorts, fakePortsOnly } from '#testing/fakes';

function minted(entries: Parameters<typeof createRepoSet>[0]): RepoSet {
  const set = createRepoSet(entries);
  assert.ok(set.ok, set.ok ? '' : set.error.internal ?? '');
  if (!set.ok) throw new Error('unreachable');
  return set.value;
}

function guild(id: string): GuildId {
  const g = toGuildId(id);
  if (!g.ok) throw new Error('fixture');
  return g.value;
}

const TWO = [
  { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: true },
  { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
] as const;

function at(set: RepoSet, key: string): RepoRef {
  const ref = set.byKey(key);
  if (ref === null) throw new Error(`no ${key}`);
  return ref;
}

// ---------------------------------------------------------------------------------------
// RepoScoped.at
// ---------------------------------------------------------------------------------------

test('RepoScoped.at returns the port of the ref it is given, for each ref of the set', () => {
  const set = minted(TWO);
  const scoped = repoScoped([
    [at(set, 'main'), 'adapter for acme/bot-modules'],
    [at(set, 'events'), 'adapter for acme/events-modules'],
  ]);
  assert.deepEqual(scoped.at(at(set, 'main')), { ok: true, value: 'adapter for acme/bot-modules' });
  assert.deepEqual(scoped.at(at(set, 'events')), { ok: true, value: 'adapter for acme/events-modules' });
});

test('RepoScoped.at REFUSES a ref minted elsewhere, even one equal in every field, with Err and never a throw', () => {
  const set = minted(TWO);
  const other = minted(TWO);
  const scoped = repoScoped([[at(set, 'main'), 'main adapter']]);
  const answered = scoped.at(at(other, 'main'));
  assert.ok(!answered.ok, 'a look-alike ref routes nowhere, and certainly not to "the first repository"');
  assert.equal(answered.ok ? '' : answered.error.code, 'config.repos');
  assert.equal(answered.ok ? true : answered.error.retryable, false);
  // A ref this set minted but the scope has no port for: the same refusal.
  assert.ok(!scoped.at(at(set, 'events')).ok);
});

// ---------------------------------------------------------------------------------------
// ReposPort
// ---------------------------------------------------------------------------------------

test('resolve: the guild mapping, else the default repository, else null', () => {
  const set = minted(TWO);
  const port = createReposPort(set);
  assert.equal(port.resolve(guild('100000000000000001')), set.default, 'no mapping in PR 2.1: the default');
  assert.equal(port.resolve(guild('100000000000000001'))?.key, 'main');

  // The mapping (PR 2.2). A mapped key wins; an unconfigured one is STALE and resolves to nothing.
  const mapped = createReposPort(set, (g) => (g === '100000000000000002' ? 'events' : g === '100000000000000003' ? 'gone' : null));
  assert.equal(mapped.resolve(guild('100000000000000002'))?.key, 'events');
  assert.equal(mapped.resolve(guild('100000000000000003')), null, 'a removed repository does not silently hand the guild to the default');
  assert.deepEqual(mapped.target(guild('100000000000000003')), { kind: 'stale', key: 'gone' });
  assert.equal(mapped.target(guild('100000000000000002')).kind, 'mapped');
  assert.equal(mapped.target(guild('100000000000000001')).kind, 'default');

  const noDefault = createReposPort(minted([{ ...TWO[0], isDefault: false }, TWO[1]]));
  assert.equal(noDefault.resolve(guild('100000000000000001')), null, 'several repositories and no default: nothing to resolve to');
  assert.deepEqual(noDefault.target(guild('100000000000000001')), { kind: 'none' });
});

test('activity() is late-bound: it reports whatever the composition root installed after the port was built', () => {
  const set = minted(TWO);
  let reports: readonly RepoActivityReport[] = [];
  const port = createReposPort(set, undefined, () => reports);
  assert.deepEqual(port.activity(), [], 'before install, nothing reports');
  reports = [{ moduleId: 'builder', inFlightForGuild: () => 2, inRepo: () => ({ inFlight: 1, detail: 'ready' }) }];
  assert.equal(port.activity().length, 1);
  assert.equal(port.activity()[0]?.inFlightForGuild(guild('100000000000000001')), 2);
});

test('byKey re-validates a key against THIS set; all() is the set in configuration order', () => {
  const set = minted(TWO);
  const port = createReposPort(set);
  assert.equal(port.byKey('events'), at(set, 'events'));
  assert.equal(port.byKey('nope'), null);
  assert.deepEqual(port.all().map((r) => r.key), ['main', 'events']);
});

test('createRepoSet refuses what config refuses: a bad key, a key twice, two defaults, an empty set', () => {
  assert.ok(!createRepoSet([{ key: 'Main', owner: 'a', repo: 'b', isDefault: true }]).ok);
  assert.ok(!createRepoSet([TWO[0], { ...TWO[1], key: 'main' }]).ok);
  assert.ok(!createRepoSet([TWO[0], { ...TWO[1], isDefault: true }]).ok);
  assert.ok(!createRepoSet([]).ok);
});

test('a module cannot write a RepoRef: the brand is a symbol only #core/ports/repos holds', () => {
  // @ts-expect-error a plain object is not a RepoRef, however well it is spelled
  const forged: RepoRef = { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: true };
  const set = minted(TWO);
  const scoped = repoScoped([[at(set, 'main'), 'main adapter']]);
  assert.ok(!scoped.at(forged).ok, 'and at runtime it routes nowhere either');
});

// ---------------------------------------------------------------------------------------
// The `repos` capability (AGENTS.md rule 6)
// ---------------------------------------------------------------------------------------

test('`repos` is a real capability: in ALL_CAPABILITIES, wired by fakePorts, and narrowed away when undeclared', () => {
  assert.ok((ALL_CAPABILITIES as readonly string[]).includes('repos'));
  const without = portsFor(fakePorts('m_x_'), ['clock'] as const, 'x');
  assert.ok(without.ok);
  if (!without.ok) return;
  assert.equal(Reflect.get(without.value, 'repos'), undefined, 'undeclared means ABSENT at runtime, not just untyped');
  const withIt = portsFor(fakePortsOnly('m_x_', ['repos']), ['repos'] as const, 'x');
  assert.ok(withIt.ok);
});

test('a module WITHOUT `repos` cannot reach ctx.ports.repos (TS2339); a module with it gets the set', () => {
  const bus = createEventBus(() => undefined);
  let seen: ReposPort | undefined;
  let leaked: unknown = 'not run';

  const without = defineModule({
    id: 'without',
    summary: 'x',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup(ctx) {
      // @ts-expect-error the tuple says clock, so there is no repos port (TS2339)
      leaked = ctx.ports.repos;
      // @ts-expect-error nor the per-repository GitHub ports it would index
      void ctx.ports.issues;
      return { commands: [], async health() { return { status: 'ok' as const, detail: '' }; } };
    },
  });
  assert.ok(without.install({ ports: fakePorts('m_without_'), rawConfig: {}, bus, logger: fakeLogger() }).ok);
  assert.equal(leaked, undefined, 'and at runtime the property is not there');

  const withRepos = defineModule({
    id: 'withrepos',
    summary: 'x',
    capabilities: ['repos'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup(ctx) {
      seen = ctx.ports.repos;
      return { commands: [], async health() { return { status: 'ok' as const, detail: '' }; } };
    },
  });
  assert.ok(withRepos.install({ ports: fakePorts('m_withrepos_'), rawConfig: {}, bus, logger: fakeLogger() }).ok);
  assert.deepEqual(seen?.all().map((r) => [r.key, r.owner, r.repo, r.isDefault]), [['default', 'o', 'r', true]]);
});
