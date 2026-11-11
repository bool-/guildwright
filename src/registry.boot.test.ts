/**
 * THE GATE TEST: does the bot this repo currently contains actually boot?
 *
 * `npm run check` was typecheck -> lint -> test, and NO test ever installed the real
 * `src/modules/` tree into a real registry. So an entire class of failure — every one of them
 * boot-FATAL — was invisible until someone ran the bot:
 *
 *   - two modules declaring the same command name (the registry refuses to start)
 *   - a module id that does not match its folder
 *   - a custom_id budget blown by a long module id + action name
 *   - a permission reference no module actually declares
 *   - a module that throws in setup()
 *   - a module declaring `migrations: true` while shipping no .sql
 *
 * Every one of those would have shipped green. This file closes that gap: it is the cheapest
 * possible proxy for "npm start would have worked", using fake ports and no network, and it is
 * the test most likely to catch an AI-authored module before a human ever reads the diff.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEventBus } from '#core/events';
import type { PortRegistry } from '#core/ports';
import { formatProblems } from '#core/registry';
import { fakeLogger, fakePorts } from '#testing/fakes';

import { defaultModulesDir, discoverModules, installModules, migrationsDirFor } from './loader.ts';

const logger = fakeLogger();

async function discoverReal() {
  const found = await discoverModules({ dir: defaultModulesDir(), disabled: new Set(), logger });
  assert.ok(found.ok, 'the real module directory must be readable');
  if (!found.ok) throw new Error('unreachable');
  return found.value;
}

test('every shipped module imports without throwing', async () => {
  const found = await discoverReal();
  assert.deepEqual(
    found.quarantined,
    [],
    'a module that throws at import is quarantined at runtime — but it should never be committed that way',
  );
  assert.ok(found.discovered.length >= 3, 'the shipped modules must be discovered');
});

test('the real module tree installs into a registry — i.e. the bot would boot', async () => {
  const found = await discoverReal();

  const installed = installModules({
    discovered: found.discovered,
    portsFor: (moduleId: string): Readonly<Partial<PortRegistry>> => fakePorts(`m_${moduleId}_`),
    configFor: (): unknown => ({}),
    bus: createEventBus(() => undefined),
    logger,
    disabled: new Set(),
  });

  // A registry problem is boot-FATAL: duplicate command names, duplicate module ids, an
  // over-budget custom_id, an undeclared permission. Print them properly rather than a bare
  // assertion, because the whole value here is that the message tells you what to fix.
  assert.ok(
    installed.ok,
    installed.ok ? '' : `the bot would refuse to start:\n${formatProblems(installed.error)}`,
  );
  if (!installed.ok) return;

  // A QUARANTINE IS NOT SUCCESS. `installModules` returns ok even when a module fails setup(),
  // because one bad module must not stop the bot — which meant this test passed while the
  // FLAGSHIP module could not install at all: `fakePorts` supplied 4 of 10 capabilities, so
  // anything declaring jobs/discord/issues/builds was quarantined and silently skipped.
  assert.deepEqual(
    installed.value.quarantined.map((q) => q.moduleId),
    [],
    'every shipped module must actually install, not merely fail to break the registry',
  );

  // And the flagship must contribute its surfaces, or the product does not exist.
  const reg = installed.value.registry;

  // EVERY SHIPPED MODULE IS NAMED, not merely counted.
  //
  // WHY THIS IS NOT REDUNDANT WITH THE QUARANTINE ASSERTION ABOVE: an empty quarantine list is
  // also what you get when a module folder is DELETED, renamed, or never discovered at all -
  // nothing failed to install, because nothing tried. That is exactly how a module can vanish
  // from a deploy while the suite stays green. Naming the roster makes a disappearance a red
  // test; adding a module is a one-line, deliberate edit here.
  assert.deepEqual(
    [...reg.modules.keys()].sort(),
    // `tags` is not here: it moved to the module-repo template (RFC-001 PR 1.5), and is booted
    // from there only by the pack-and-install test in src/build.test.ts.
    // `repos` (RFC-001 PR 2.2): `/repo use|show|clear`, which guild routing is configured with.
    ['access', 'admin', 'builder', 'credentials', 'help', 'ping', 'repos'],
    'the shipped module roster changed',
  );
  // `/request new`, not `/request`: the flagship gained three siblings (`list`, `cancel`,
  // `retry`) and Discord forbids a command that is both a leaf and a subcommand container -
  // `buildCommandPayloads` refuses that shape outright, so the verb had to move down a level.
  assert.ok(reg.commands.has('request new'), '/request new must be registered');
  assert.ok(reg.commands.has('request list'), '/request list must be registered');
  assert.ok(reg.commands.has('request cancel'), '/request cancel must be registered');
  assert.ok(reg.commands.has('request retry'), '/request retry must be registered');
  assert.ok(reg.forms.has('builder:request'), 'the request modal must be routable');
  assert.ok(reg.actions.has('builder:approve'), 'the Approve button must be routable');
  assert.ok(reg.actions.has('builder:reject'), 'the Reject button must be routable');

  // THE OPERATOR'S VIEW, added this round. `AuditLog.recent`/`forGuild` and `JobSystem.stats`
  // were implemented, tested and called by NOTHING; these two commands are the door. A door
  // that stopped being registered would put them straight back to being unreachable.
  assert.ok(reg.commands.has('admin jobs'), '/admin jobs must be registered');
  assert.ok(reg.commands.has('admin audit'), '/admin audit must be registered');

  // The whole reason for moving off `$request`: no hook means no privileged intent.
  assert.equal(
    reg.hooks.size,
    0,
    'a message hook would drag the privileged MessageContent intent back in — see client.ts',
  );
});

test('a module declaring migrations actually ships them', async () => {
  // The exact mismatch that shipped: `migrations: true` with no directory is indistinguishable
  // from "needs no migrations", so the table was never created and the bot booted healthy into a
  // module that threw on its first query. main.ts now quarantines this at boot; this catches it
  // one step earlier, in CI, where it is free.
  const found = await discoverReal();

  for (const m of found.discovered) {
    if (!m.descriptor.manifest.migrations) continue;

    const dir = migrationsDirFor(m);
    assert.ok(existsSync(dir), `${m.descriptor.manifest.id} declares migrations: true but ${dir} does not exist`);

    const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    assert.ok(
      sqlFiles.length > 0,
      `${m.descriptor.manifest.id} declares migrations: true but ships no .sql files in ${dir}`,
    );

    // Every object a migration creates must live in the module's namespace, or `drop:module`
    // cannot clean up and two modules can collide.
    for (const file of sqlFiles) {
      assert.match(file, /^\d{4}_/u, `${file} should be ordered: 0001_init.sql, 0002_....sql`);
      assert.ok(existsSync(join(dir, file)));
    }
  }
});

test('module ids agree with their folder names', async () => {
  const found = await discoverReal();
  for (const m of found.discovered) {
    assert.equal(
      m.descriptor.manifest.id,
      m.folder,
      `${m.source}: the id is the folder name, the SQL prefix and half of every custom_id — they cannot differ`,
    );
  }
});
