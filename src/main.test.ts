/**
 * The duplicate-engine guard at the top of `run()` (RFC-001 section 4.3, "Module identity").
 *
 * Tested through `claimEngine` with a plain object standing in for `globalThis`, so no test here
 * boots anything or leaves a registration behind for another test to trip over. `run()` calls it
 * with `globalThis` before it reads config, opens the database or touches Discord.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CONFIG_USER_TEXT, errors, userMessage } from '#core/errors';

import { BOOT_CONFIG_HEADLINE, claimEngine, ENGINE_KEY, ENGINE_PACKAGE, formatConfigFailure } from './main.ts';

test('a config refusal at boot is headed for the operator, not with the Discord-user sentence', () => {
  const failure = formatConfigFailure(errors.config('env', '✖ missing\n  → at DISCORD_TOKEN', 'Set it and restart.'));
  const headline = failure.split('\n')[1];
  assert.equal(headline, 'guildwright cannot start: The bot is misconfigured.');
  assert.equal(BOOT_CONFIG_HEADLINE, 'The bot is misconfigured.');
  assert.ok(!failure.includes(CONFIG_USER_TEXT), failure);
  // The specifics and the fix still follow the headline.
  assert.match(failure, /^ {2}where: env$/mu);
  assert.match(failure, /^ {4}→ at DISCORD_TOKEN$/mu);
  assert.match(failure, /^ {2}what to do: Set it and restart\.$/mu);
  // docs/SETUP.md section 6 quotes this exact line.
  assert.ok(readFileSync(new URL('../docs/SETUP.md', import.meta.url), 'utf8').includes(`\n${headline}\n`));
});

test('the Discord user still sees CONFIG_USER_TEXT for a runtime config error', () => {
  assert.equal(userMessage(errors.config('module.tags', 'hint', 'Fix it.')), CONFIG_USER_TEXT);
});

test('a non-config refusal keeps its own headline', () => {
  const failure = formatConfigFailure(errors.upstream('discord', 401, 'Reset the token.', 'An invalid token was provided.'));
  assert.equal(failure.split('\n')[1], 'guildwright cannot start: Discord rejected that request.');
});

test('the engine key is the process-wide Symbol.for, so a second copy of main finds it', () => {
  // A module-level `let` in a second copy of this file would be a second variable. Only a
  // registered symbol on the global object is shared between two copies of one package.
  assert.equal(ENGINE_KEY, Symbol.for('guildwright.engine'));
  assert.equal(ENGINE_PACKAGE, 'guildwright');
});

test('the first engine claims the process and registers its version and path', () => {
  const registry = {};
  assert.equal(claimEngine({ version: '0.1.0', path: '/app/node_modules/guildwright/' }, registry), null);
  assert.deepEqual(Reflect.get(registry, ENGINE_KEY), {
    version: '0.1.0',
    path: '/app/node_modules/guildwright/',
  });
});

test('the same engine claiming again is not a second copy', () => {
  const registry = {};
  const self = { version: '0.1.0', path: '/app/node_modules/guildwright/' };
  assert.equal(claimEngine(self, registry), null);
  assert.equal(claimEngine(self, registry), null);
});

test('a second engine at a different path is refused, naming both paths and the fix', () => {
  const registry = {};
  const first = '/app/node_modules/guildwright/';
  const second = '/app/node_modules/some-dep/node_modules/guildwright/';
  assert.equal(claimEngine({ version: '0.1.0', path: first }, registry), null);

  const refusal = claimEngine({ version: '0.2.0', path: second }, registry);
  assert.equal(
    refusal,
    `two copies of guildwright are loaded (${first}, ${second}); ` +
      'run npm ls guildwright and dedupe',
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
  assert.ok(refusal?.startsWith('two copies of guildwright are loaded (an unknown path, /app/)'));
});

test('globalThis is the default registry', () => {
  // Run in this test file's own process; `run()` is never called here, so the key is free.
  const prior: unknown = Reflect.get(globalThis, ENGINE_KEY);
  assert.equal(prior, undefined, 'nothing in this test process registered an engine yet');
  try {
    assert.equal(claimEngine({ version: '0.1.0', path: '/a/' }), null);
    assert.match(claimEngine({ version: '0.1.0', path: '/b/' }) ?? '', /^two copies of guildwright/u);
  } finally {
    Reflect.deleteProperty(globalThis, ENGINE_KEY);
  }
});

/**
 * GUILD ROUTING IS WIRED (RFC-001 PR 2.2). Booting `run()` needs Discord and GitHub, so this is
 * read off the source, like `retry.test.ts` reads the builder's: without these three lines
 * `/repo use` would write a setting nothing reads, and `/repo clear` would never see a request in
 * flight. What each line DOES is tested against the real adapters in
 * `src/modules/repos/module.test.ts`; this pins that the composition root still says it.
 */
test('the composition root wires the repo.target mapping and every module\'s repoActivity into the repository set', () => {
  const code = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(code, /guildMapping: repoTargetReader\(settings\)/u, 'resolve(guild) must read the setting /repo use writes');
  assert.match(code, /activity: \(\) => repoActivity/u, 'activity() must be late-bound to the installed modules');
  assert.match(code, /repoActivity = \[\.\.\.report\.registry\.installed\.values\(\)\]/u, 'and filled from them after install');
});
