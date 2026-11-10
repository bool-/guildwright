/** MODULE_DIRS and MODULES_BUILTIN (RFC-001 section 4.2): parsed once, in `loadConfig`. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadConfig } from '#core/config';

const BASE = {
  DISCORD_TOKEN: 'a'.repeat(60),
  DISCORD_CLIENT_ID: '100000000000000001',
  DISCORD_OWNER_ID: '100000000000000002',
  GITHUB_TOKEN: 'g'.repeat(40),
  GITHUB_OWNER: 'octo',
  GITHUB_REPO: 'demo',
  APPROVAL_HMAC_KEY: 'x'.repeat(48),
  NODE_ENV: 'test',
};

test('MODULE_DIRS is split on commas, trimmed, and marked explicit', () => {
  const cfg = loadConfig({ ...BASE, MODULE_DIRS: ' ./a, ./b ,' });
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  assert.deepEqual(cfg.value.moduleDirs, ['./a', './b']);
  assert.equal(cfg.value.moduleDirsExplicit, true);
});

test('an absent MODULE_DIRS is the built-in tree and is not explicit', () => {
  const cfg = loadConfig(BASE);
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  assert.deepEqual(cfg.value.moduleDirs, ['./src/modules']);
  assert.equal(cfg.value.moduleDirsExplicit, false);
  assert.equal(cfg.value.builtinModules, true);
});

test('MODULES_BUILTIN=false turns the built-in modules off', () => {
  const cfg = loadConfig({ ...BASE, MODULES_BUILTIN: 'false' });
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  assert.equal(cfg.value.builtinModules, false);
});
