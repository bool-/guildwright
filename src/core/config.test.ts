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

// ---------------------------------------------------------------------------------------
// GitHub auth: exactly one mode (RFC-001 PR 1.6)
// ---------------------------------------------------------------------------------------

/** BASE without its PAT, i.e. an env with no GitHub credential at all. */
const { GITHUB_TOKEN: _pat, ...NO_GITHUB_AUTH } = BASE;
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----\n';

function configError(env: Record<string, string>): string {
  const cfg = loadConfig(env);
  assert.ok(!cfg.ok, 'this env must be refused');
  if (cfg.ok) return '';
  assert.equal(cfg.error.kind, 'config');
  assert.equal(cfg.error.kind === 'config' ? cfg.error.location : '', 'env');
  return cfg.error.internal ?? '';
}

test('PAT mode: GITHUB_TOKEN alone parses into the pat branch', () => {
  const cfg = loadConfig(BASE);
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  assert.equal(cfg.value.github.auth.kind, 'pat');
  if (cfg.value.github.auth.kind === 'pat') {
    assert.equal(cfg.value.github.auth.token.reveal(), 'g'.repeat(40));
    assert.equal(JSON.stringify(cfg.value.github.auth.token), '"[redacted]"');
  }
});

test('App mode with an inline key: the PEM is a Secret, the ids are numbers, the installation id is optional', () => {
  const cfg = loadConfig({ ...NO_GITHUB_AUTH, GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: PEM });
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.internal ?? '');
  if (!cfg.ok) return;
  const auth = cfg.value.github.auth;
  assert.equal(auth.kind, 'app');
  if (auth.kind !== 'app') return;
  assert.equal(auth.appId, 424242);
  assert.equal(auth.installationId, null);
  assert.equal(auth.privateKey.kind, 'inline');
  if (auth.privateKey.kind === 'inline') {
    assert.equal(JSON.stringify(auth.privateKey.pem), '"[redacted]"', 'the key never serialises');
    assert.equal(`${auth.privateKey.pem}`, '[redacted]', 'nor interpolates');
  }
});

test('App mode with a key file and an installation id: the path is carried, not read', () => {
  const cfg = loadConfig({
    ...NO_GITHUB_AUTH,
    GITHUB_APP_ID: '424242',
    GITHUB_APP_PRIVATE_KEY_FILE: './secrets/app.pem',
    GITHUB_APP_INSTALLATION_ID: '777',
  });
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.internal ?? '');
  if (!cfg.ok) return;
  assert.deepEqual(
    cfg.value.github.auth.kind === 'app' ? [cfg.value.github.auth.privateKey, cfg.value.github.auth.installationId] : null,
    [{ kind: 'file', path: './secrets/app.pem' }, 777],
  );
});

test('both modes set is refused, naming both sides', () => {
  const text = configError({ ...BASE, GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: PEM });
  assert.match(text, /both GitHub auth modes are configured \(GITHUB_TOKEN and GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY\); pick ONE/u);
});

test('neither mode set is refused, naming both ways to fix it', () => {
  const text = configError(NO_GITHUB_AUTH);
  assert.match(text, /no GitHub credential is configured: set GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE/u);
  assert.match(text, /or GITHUB_TOKEN/u);
});

test('the mode rule is reported together with every other bad variable, not one restart later', () => {
  const { DISCORD_TOKEN: _discord, ...rest } = NO_GITHUB_AUTH;
  const text = configError(rest);
  assert.match(text, /DISCORD_TOKEN/u, 'the ordinary missing variable is still listed');
  assert.match(text, /no GitHub credential is configured/u, 'and so is the auth mode, in the same report');
});

test('key and key file both set is refused', () => {
  const text = configError({
    ...NO_GITHUB_AUTH,
    GITHUB_APP_ID: '424242',
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_APP_PRIVATE_KEY_FILE: './secrets/app.pem',
  });
  assert.match(text, /GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_FILE are both set; set exactly one of them\./u);
});

test('App mode without a key, or a key without an App id, is refused', () => {
  assert.match(configError({ ...NO_GITHUB_AUTH, GITHUB_APP_ID: '424242' }), /App mode needs the private key/u);
  assert.match(
    configError({ ...NO_GITHUB_AUTH, GITHUB_APP_PRIVATE_KEY_FILE: './secrets/app.pem' }),
    /GITHUB_APP_PRIVATE_KEY_FILE is set but GITHUB_APP_ID is not/u,
  );
});

test('an inline key that is not a PEM is refused without echoing it', () => {
  const text = configError({ ...NO_GITHUB_AUTH, GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: 'not-a-key-but-maybe-a-secret' });
  assert.match(text, /GITHUB_APP_PRIVATE_KEY/u);
  assert.ok(!text.includes('not-a-key-but-maybe-a-secret'), 'a rejected value is never printed');
});

test('a PAT next to an empty App variable still counts as two modes', () => {
  assert.match(configError({ ...BASE, GITHUB_APP_INSTALLATION_ID: '' }), /both GitHub auth modes are configured/u);
});
