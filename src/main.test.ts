/**
 * The duplicate-engine guard at the top of `run()` (RFC-001 section 4.3, "Module identity").
 *
 * Tested through `claimEngine` with a plain object standing in for `globalThis`, so no test here
 * boots anything or leaves a registration behind for another test to trip over. `run()` calls it
 * with `globalThis` before it reads config, opens the database or touches Discord.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { claimEngine, ENGINE_KEY, ENGINE_PACKAGE } from './main.ts';

test('the engine key is the process-wide Symbol.for, so a second copy of main finds it', () => {
  // A module-level `let` in a second copy of this file would be a second variable. Only a
  // registered symbol on the global object is shared between two copies of one package.
  assert.equal(ENGINE_KEY, Symbol.for('discord-ai-feature-builder.engine'));
  assert.equal(ENGINE_PACKAGE, 'discord-ai-feature-builder');
});

test('the first engine claims the process and registers its version and path', () => {
  const registry = {};
  assert.equal(claimEngine({ version: '0.1.0', path: '/app/node_modules/discord-ai-feature-builder/' }, registry), null);
  assert.deepEqual(Reflect.get(registry, ENGINE_KEY), {
    version: '0.1.0',
    path: '/app/node_modules/discord-ai-feature-builder/',
  });
});

test('the same engine claiming again is not a second copy', () => {
  const registry = {};
  const self = { version: '0.1.0', path: '/app/node_modules/discord-ai-feature-builder/' };
  assert.equal(claimEngine(self, registry), null);
  assert.equal(claimEngine(self, registry), null);
});

test('a second engine at a different path is refused, naming both paths and the fix', () => {
  const registry = {};
  const first = '/app/node_modules/discord-ai-feature-builder/';
  const second = '/app/node_modules/some-dep/node_modules/discord-ai-feature-builder/';
  assert.equal(claimEngine({ version: '0.1.0', path: first }, registry), null);

  const refusal = claimEngine({ version: '0.2.0', path: second }, registry);
  assert.equal(
    refusal,
    `two copies of discord-ai-feature-builder are loaded (${first}, ${second}); ` +
      'run npm ls discord-ai-feature-builder and dedupe',
  );
  // The refused copy must not overwrite the registration: the first engine is still the one
  // running, and a third copy should be told about IT.
  assert.deepEqual(Reflect.get(registry, ENGINE_KEY), { version: '0.1.0', path: first });
});

test('a registration this code did not write still blocks a second start', () => {
  // Whatever shape an older or newer engine left behind, a present key means another copy
  // already started in this process.
  const registry = {};
  Reflect.set(registry, ENGINE_KEY, 'something else');
  const refusal = claimEngine({ version: '0.1.0', path: '/app/' }, registry);
  assert.ok(refusal?.startsWith('two copies of discord-ai-feature-builder are loaded (an unknown path, /app/)'));
});

test('globalThis is the default registry', () => {
  // Run in this test file's own process; `run()` is never called here, so the key is free.
  const prior: unknown = Reflect.get(globalThis, ENGINE_KEY);
  assert.equal(prior, undefined, 'nothing in this test process registered an engine yet');
  try {
    assert.equal(claimEngine({ version: '0.1.0', path: '/a/' }), null);
    assert.match(claimEngine({ version: '0.1.0', path: '/b/' }) ?? '', /^two copies of discord-ai-feature-builder/u);
  } finally {
    Reflect.deleteProperty(globalThis, ENGINE_KEY);
  }
});
