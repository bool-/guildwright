/**
 * Proof that the loader's three severities are real, against files on a real filesystem, with
 * fake ports and no network.
 *
 * The four things asserted here are the four ways module loading has historically gone wrong:
 *
 *  1. Discovery works AT ALL on Windows. `await import(absolutePath)` fails there with
 *     ERR_UNSUPPORTED_ESM_URL_SCHEME because the drive letter parses as a URL scheme; the test
 *     below asserts BOTH halves - the bare path rejects, `pathToFileURL` resolves - so the fix
 *     cannot be "simplified" back out.
 *  2. A module that throws is QUARANTINED and the others still load.
 *  3. A duplicate command name REFUSES TO START, naming both owners. Silent last-wins is the
 *     failure this prevents, and it is invisible until the wrong handler answers in production.
 *  4. `MODULES_DISABLE` is honoured BEFORE the import, which is the only ordering that helps a
 *     module that throws at import.
 */

import { strict as assert } from 'node:assert';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { createEventBus } from '#core/events';
import { defineModule, type ModuleDescriptor, type Outcome } from '#core/module';
import { PUBLIC } from '#core/policy';
import type { PortRegistry } from '#core/ports';
import { NO_LIMIT } from '#core/ratelimit';
import { describeProblem, formatProblems } from '#core/registry';
import { fakeLogger, fakePorts } from '#testing/fakes';

import {
  builtinRoot,
  defaultModulesDir,
  describeQuarantine,
  discoverModules,
  findModuleFolders,
  installModules,
  migrationsDirFor,
  type DiscoveredModule,
  type ModuleRoot,
} from './loader.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'testing', 'fixtures', 'modules');

const logger = fakeLogger();
const bus = createEventBus(() => undefined);

function io(discovered: readonly DiscoveredModule[], disabled: readonly string[] = []) {
  return {
    discovered,
    portsFor: (moduleId: string): Readonly<Partial<PortRegistry>> => fakePorts(`m_${moduleId}_`),
    configFor: (): unknown => ({}),
    bus,
    logger,
    disabled: new Set(disabled),
  };
}

/** A descriptor built in memory, for the collision cases - no file needed to prove a refusal. */
function fixtureModule(id: string, commandName: string): ModuleDescriptor {
  return defineModule({
    id,
    summary: `in-memory fixture ${id}`,
    capabilities: [],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [
          {
            name: commandName,
            description: 'x',
            surface: 'guild',
            options: [],
            permission: PUBLIC,
            limit: NO_LIMIT,
            needs: [],
            ack: 'instant',
            async handle(): Promise<Outcome> {
              return { kind: 'silent' };
            },
          },
        ],
        async health() {
          return { status: 'ok' as const, detail: '' };
        },
      };
    },
  });
}

function asDiscovered(descriptor: ModuleDescriptor, source: string): DiscoveredModule {
  return { folder: descriptor.manifest.id, dir: source, source, descriptor };
}

// ---------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------

test('the real src/modules tree is discovered, and every module imports', async () => {
  const found = await discoverModules({ roots: [builtinRoot()], disabled: new Set(), logger });
  assert.ok(found.ok, 'the real module directory must be readable');
  if (!found.ok) return;

  const ids = found.value.discovered.map((m) => m.descriptor.manifest.id).sort();

  // A SUPERSET check, deliberately, not an exact list.
  //
  // The whole premise of this repo is that adding a module touches no file outside its own
  // folder — and an AI agent adding one is the flagship feature. Pinning the exact set would
  // make the very first added module fail CI for a reason that has nothing to do with it,
  // which is precisely the friction this design exists to remove.
  //
  // What is actually worth asserting is that the modules we ship are still here, and that
  // EVERY module present imports cleanly — including ones added later.
  for (const shipped of ['builder', 'help', 'ping']) {
    assert.ok(ids.includes(shipped), `the shipped "${shipped}" module must be discovered`);
  }
  assert.deepEqual(found.value.quarantined, [], 'no module in the tree may fail to import');

  // The folder is the wiring: id, folder and migrations directory must agree.
  for (const m of found.value.discovered) {
    assert.equal(m.descriptor.manifest.id, m.folder, `${m.source}: id must equal the folder name`);
    assert.ok(migrationsDirFor(m).endsWith('migrations'));
  }
});

test('a bare absolute path does NOT import on Windows, and pathToFileURL does', { skip: process.platform !== 'win32' }, async () => {
  const entry = join(defaultModulesDir(), 'ping', 'module.ts');

  // THE BUG THIS FILE EXISTS TO PIN DOWN. If this ever stops rejecting, the loader can be
  // simplified; until then, removing `pathToFileURL` breaks the bot on every Windows machine.
  await assert.rejects(
    async () => {
      await import(entry);
    },
    (cause: unknown) => {
      const code: unknown = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
      assert.equal(code, 'ERR_UNSUPPORTED_ESM_URL_SCHEME');
      return true;
    },
  );

  const viaUrl: unknown = await import(pathToFileURL(entry).href);
  const descriptor: unknown = Reflect.get(viaUrl as object, 'default');
  assert.equal(typeof descriptor, 'object');
});

test('findModuleFolders skips a directory with no module.ts, and a missing directory is empty', () => {
  const folders = findModuleFolders(FIXTURES);
  assert.ok(folders.ok);
  if (!folders.ok) return;
  assert.deepEqual(folders.value.map((f) => f.folder), ['alpha', 'boom', 'explode']);

  const missing = findModuleFolders(join(FIXTURES, 'does-not-exist'));
  assert.ok(missing.ok);
  if (!missing.ok) return;
  assert.deepEqual(missing.value, [], 'a missing module directory is empty, not an error');
});

// ---------------------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------------------

test('a module that throws AT IMPORT is quarantined, and the healthy ones still load', async () => {
  const found = await discoverModules({ dir: FIXTURES, disabled: new Set(), logger });
  assert.ok(found.ok);
  if (!found.ok) return;

  assert.deepEqual(
    found.value.discovered.map((m) => m.folder),
    ['alpha', 'boom'],
    'explode threw at import and must not appear as discovered',
  );

  const dead = found.value.quarantined;
  assert.equal(dead.length, 1);
  const first = dead[0];
  assert.ok(first !== undefined);
  assert.equal(first.moduleId, 'explode');

  const why = describeQuarantine(first);
  assert.match(why, /QUARANTINED module "explode"/u);
  assert.match(why, /throws at import on purpose/u, 'the operator must be told what actually threw');
});

test('a module that throws in setup() is quarantined, and the bot still starts', async () => {
  const found = await discoverModules({ dir: FIXTURES, disabled: new Set(), logger });
  assert.ok(found.ok);
  if (!found.ok) return;

  const loaded = installModules({ ...io(found.value.discovered), quarantined: found.value.quarantined });
  assert.ok(loaded.ok, 'one broken module must never be fatal');
  if (!loaded.ok) return;

  assert.deepEqual([...loaded.value.registry.modules.keys()], ['alpha'], 'alpha still installs');
  assert.equal(loaded.value.registry.commands.size, 1);

  const quarantinedIds = loaded.value.quarantined.map((q) => q.moduleId).sort();
  assert.deepEqual(quarantinedIds, ['boom', 'explode'], 'both failure modes land in one list');

  const setupFailure = loaded.value.quarantined.find((q) => q.moduleId === 'boom');
  assert.ok(setupFailure !== undefined);
  assert.match(describeQuarantine(setupFailure), /setup\(\) threw: fixture boom/u);
});

test('MODULES_DISABLE skips a module BEFORE it is imported', async () => {
  const found = await discoverModules({ dir: FIXTURES, disabled: new Set(['explode', 'boom']), logger });
  assert.ok(found.ok);
  if (!found.ok) return;

  assert.deepEqual(found.value.skipped, ['boom', 'explode']);
  assert.deepEqual(found.value.discovered.map((m) => m.folder), ['alpha']);
  assert.deepEqual(
    found.value.quarantined,
    [],
    'a disabled module is not imported at all, so it cannot even fail - that is the point',
  );
});

// ---------------------------------------------------------------------------------------
// Hard conflicts: refuse to start, and name both sides
// ---------------------------------------------------------------------------------------

test('a duplicate COMMAND name refuses to start and names both modules', () => {
  const left = asDiscovered(fixtureModule('left', 'clash'), 'src/modules/left/module.ts');
  const right = asDiscovered(fixtureModule('right', 'clash'), 'src/modules/right/module.ts');

  const loaded = installModules(io([left, right]));
  assert.equal(loaded.ok, false, 'shipping two handlers for one command name is worse than not shipping');
  if (loaded.ok) return;

  const duplicate = loaded.error.find((p) => p.kind === 'duplicate-command');
  assert.ok(duplicate !== undefined, 'the refusal must say WHICH kind of collision it was');
  assert.equal(duplicate.name, 'clash');
  assert.deepEqual([...duplicate.owners].sort(), ['left', 'right']);

  const printed = formatProblems(loaded.error);
  assert.match(printed, /Registry refused to start/u);
  assert.match(printed, /"left"/u);
  assert.match(printed, /"right"/u, 'both owners are named so nobody has to bisect');
});

test('a duplicate MODULE id refuses to start and names both source files', () => {
  const first = asDiscovered(fixtureModule('twin', 'one'), 'src/modules/twin-a/module.ts');
  const second = asDiscovered(fixtureModule('twin', 'two'), 'src/modules/twin-b/module.ts');

  const loaded = installModules(io([first, second]));
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;

  const duplicate = loaded.error.find((p) => p.kind === 'duplicate-module');
  assert.ok(duplicate !== undefined);
  assert.equal(duplicate.id, 'twin');
  assert.deepEqual(duplicate.sources, ['src/modules/twin-a/module.ts', 'src/modules/twin-b/module.ts']);
  assert.match(describeProblem(duplicate), /twin-a\/module\.ts and src\/modules\/twin-b\/module\.ts/u);
});

test('a healthy pair installs, and MODULES_DISABLE also matches a module id at install time', () => {
  const left = asDiscovered(fixtureModule('left', 'left-cmd'), 'src/modules/left/module.ts');
  const right = asDiscovered(fixtureModule('right', 'right-cmd'), 'src/modules/right/module.ts');

  const both = installModules(io([left, right]));
  assert.ok(both.ok);
  if (!both.ok) return;
  assert.deepEqual([...both.value.registry.commands.keys()].sort(), ['left-cmd', 'right-cmd']);

  const one = installModules(io([left, right], ['right']));
  assert.ok(one.ok);
  if (!one.ok) return;
  assert.deepEqual([...one.value.registry.modules.keys()], ['left']);
});

test('each module is handed its OWN db scope, which is what makes m_<id>_* real', () => {
  const seen: string[] = [];
  const probe = (id: string): ModuleDescriptor =>
    defineModule({
      id,
      summary: 'x',
      capabilities: ['db'],
      config: z.object({}),
      permissions: {},
      publishes: {},
      migrations: false,
      setup(ctx) {
        seen.push(ctx.ports.db.tablePrefix);
        return {
          commands: [],
          async health() {
            return { status: 'ok' as const, detail: '' };
          },
        };
      },
    });

  const loaded = installModules(
    io([asDiscovered(probe('one'), 'one'), asDiscovered(probe('two'), 'two')]),
  );
  assert.ok(loaded.ok);
  assert.deepEqual(seen, ['m_one_', 'm_two_'], 'a shared port bag would have given both the same prefix');
});

// ---------------------------------------------------------------------------------------
// Roots (RFC-001 section 4.2): several directories, de-duplicated, with a boot import scan
// ---------------------------------------------------------------------------------------

const ROOTS = resolve(HERE, 'testing', 'fixtures', 'roots');
const root = (dir: string, entry: ModuleRoot['entry'] = 'module.ts', required = false): ModuleRoot => ({ dir, entry, required });

test('two roots merge, built-ins first', async () => {
  const found = await discoverModules({
    roots: [root(FIXTURES), root(join(ROOTS, 'extra'))],
    disabled: new Set(),
    logger,
  });
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.deepEqual(found.value.discovered.map((m) => m.folder), ['alpha', 'boom', 'beta']);
});

test('the same directory under two spellings is scanned once', async () => {
  for (const second of [FIXTURES, join(FIXTURES, '..', 'modules')]) {
    const found = await discoverModules({ roots: [root(FIXTURES), root(second)], disabled: new Set(), logger });
    assert.ok(found.ok);
    if (!found.ok) return;
    assert.deepEqual(found.value.discovered.map((m) => m.folder), ['alpha', 'boom']);
    assert.equal(found.value.quarantined.length, 1, 'explode is quarantined once, not twice');
  }
});

test('the entry file name belongs to the root: module.js is found by a module.js root only', async () => {
  const compiled = join(ROOTS, 'compiled');
  const js = await discoverModules({ roots: [root(compiled, 'module.js')], disabled: new Set(), logger });
  assert.ok(js.ok);
  if (!js.ok) return;
  assert.deepEqual(js.value.discovered.map((m) => m.folder), ['gamma']);

  const ts = await discoverModules({ roots: [root(compiled, 'module.ts')], disabled: new Set(), logger });
  assert.ok(ts.ok);
  if (!ts.ok) return;
  assert.deepEqual(ts.value.discovered, []);
});

test('the built-in root is src/modules and finds module.ts when running from source', () => {
  const b = builtinRoot();
  assert.equal(b.entry, 'module.ts');
  assert.equal(b.dir, defaultModulesDir());
  assert.equal(b.required, false);
});

test('one module id in two roots is still fatal at install, naming both sources', async () => {
  const found = await discoverModules({
    roots: [root(FIXTURES), root(join(ROOTS, 'dup'))],
    disabled: new Set(['explode', 'boom']),
    logger,
  });
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.deepEqual(found.value.discovered.map((m) => m.folder), ['alpha', 'alpha']);

  const loaded = installModules(io(found.value.discovered));
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  const duplicate = loaded.error.find((p) => p.kind === 'duplicate-module');
  assert.ok(duplicate !== undefined);
  assert.equal(duplicate.id, 'alpha');
  assert.equal(duplicate.sources.length, 2);
  assert.match(duplicate.sources[0] ?? '', /fixtures\/modules\/alpha/u);
  assert.match(duplicate.sources[1] ?? '', /fixtures\/roots\/dup\/alpha/u);
});

test('a required root that does not exist is a config error; an optional one is empty', async () => {
  const missing = join(ROOTS, 'no-such-dir');

  const required = await discoverModules({ roots: [root(missing, 'module.ts', true)], disabled: new Set(), logger });
  assert.equal(required.ok, false);
  if (required.ok) return;
  assert.match(required.error.code, /config/u);
  assert.match(required.error.internal ?? '', /is not a directory/u);
  assert.equal(required.error.nextStep, 'Fix MODULE_DIRS in .env, or remove it to use ./src/modules.');

  const optional = await discoverModules({ roots: [root(missing)], disabled: new Set(), logger });
  assert.ok(optional.ok);
  if (!optional.ok) return;
  assert.deepEqual(optional.value.discovered, []);
});

test('the boot import scan quarantines a banned import WITHOUT importing the module', async () => {
  const found = await discoverModules({ roots: [root(join(ROOTS, 'scan'))], disabled: new Set(), logger });
  assert.ok(found.ok);
  if (!found.ok) return;

  const banned = found.value.quarantined.find((q) => q.moduleId === 'banned');
  assert.ok(banned !== undefined, 'banned must be quarantined');
  const why = describeQuarantine(banned);
  assert.match(why, /node:child_process/u);
  assert.match(why, /AGENTS\.md rule 1/u);
  assert.doesNotMatch(why, /must never be imported/u, 'the module top level must not have run');

  // The documented LIMIT of a textual scan: a computed specifier passes. Asserted so nobody
  // later calls this a sandbox.
  assert.deepEqual(found.value.discovered.map((m) => m.folder), ['sneaky']);
});
