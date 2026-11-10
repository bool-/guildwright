/** MODULE_DIRS and MODULES_BUILTIN (RFC-001 section 4.2): parsed once, in `loadConfig`. */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ENV_REPO_SETTING_NAMES, loadConfig, removedBuilderKeyWarnings, topLevelJsonKeys } from '#core/config';

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
  assert.equal(cfg.value.github.repos[0]?.installationId, null, 'the installation id now lives on the repository (RFC-001 PR 2.1)');
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
    cfg.value.github.auth.kind === 'app' ? [cfg.value.github.auth.privateKey, cfg.value.github.repos[0]?.installationId] : null,
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

// ---------------------------------------------------------------------------------------
// RFC-001 PR 1.7: ALLOW_PUBLIC_TARGET_REPO, and the removed builder keys
// ---------------------------------------------------------------------------------------

test('ALLOW_PUBLIC_TARGET_REPO defaults to false: a public target repository is refused unless asked for', () => {
  const absent = loadConfig(BASE);
  assert.ok(absent.ok);
  assert.equal(absent.ok && absent.value.github.allowPublicTargetRepo, false);

  const on = loadConfig({ ...BASE, ALLOW_PUBLIC_TARGET_REPO: 'true' });
  assert.ok(on.ok);
  assert.equal(on.ok && on.value.github.allowPublicTargetRepo, true);

  const off = loadConfig({ ...BASE, ALLOW_PUBLIC_TARGET_REPO: 'false' });
  assert.equal(off.ok && off.value.github.allowPublicTargetRepo, false);
});

test('ALLOW_PUBLIC_TARGET_REPO that is not a boolean is a config error naming it', () => {
  const bad = loadConfig({ ...BASE, ALLOW_PUBLIC_TARGET_REPO: 'sure' });
  assert.ok(!bad.ok);
  assert.match(bad.ok ? '' : (bad.error.internal ?? ''), /ALLOW_PUBLIC_TARGET_REPO/u);
});

test('MODULES_JSON.builder.ref and .workflowFile are IGNORED, with a warning naming the env var that replaced each', () => {
  const cfg = loadConfig({ ...BASE, MODULES_JSON: '{"builder":{"ref":"release","workflowFile":"other.yml","dailyRunCap":2}}' });
  assert.ok(cfg.ok, 'still parses: the keys are ignored, not fatal');
  if (!cfg.ok) return;
  assert.equal(cfg.value.github.repos[0]?.ref, 'main', 'the dispatch ref is GITHUB_REF, whatever MODULES_JSON says');
  assert.equal(cfg.value.github.repos[0]?.workflowFile, 'agent-implement-request.yml');
  assert.deepEqual(removedBuilderKeyWarnings(cfg.value.modules), [
    'MODULES_JSON.builder.ref is ignored: builds now dispatch at GITHUB_REF, the value the preflight and the gate-file check verify. Set GITHUB_REF instead and remove builder.ref from MODULES_JSON.',
    'MODULES_JSON.builder.workflowFile is ignored: builds now dispatch at GITHUB_WORKFLOW_FILE, the value the preflight and the gate-file check verify. Set GITHUB_WORKFLOW_FILE instead and remove builder.workflowFile from MODULES_JSON.',
  ]);
  assert.deepEqual(removedBuilderKeyWarnings({ builder: { dailyRunCap: 2 } }), [], 'no warning without the keys');
  assert.deepEqual(removedBuilderKeyWarnings({}), []);
});


// ---------------------------------------------------------------------------------------
// The repository set (RFC-001 PR 2.1): GITHUB_REPOS_JSON, and the single-repository shim
// ---------------------------------------------------------------------------------------

/** BASE without the single-repository pair, i.e. an env that must say GITHUB_REPOS_JSON. */
const { GITHUB_OWNER: _owner, GITHUB_REPO: _repo, ...NO_REPO } = BASE;

const TWO = JSON.stringify({
  main: { owner: 'acme', repo: 'bot-modules', ref: 'main', workflowFile: 'agent-implement-request.yml', installationId: 1234567, default: true },
  events: { owner: 'acme', repo: 'events-modules' },
});

test('SHIM: GITHUB_OWNER/GITHUB_REPO still parse, into the one-element set keyed `default`, with every phase-1 value unchanged', () => {
  const cfg = loadConfig({ ...BASE, GITHUB_REF: 'release/2', GITHUB_WORKFLOW_FILE: 'build.yml' });
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.internal ?? '');
  if (!cfg.ok) return;
  assert.equal(cfg.value.github.reposSource, 'env');
  assert.deepEqual(cfg.value.github.repos, [
    {
      key: 'default',
      owner: 'octo',
      repo: 'demo',
      workflowFile: 'build.yml',
      ref: 'release/2',
      installationId: null,
      isDefault: true,
      names: ENV_REPO_SETTING_NAMES,
    },
  ]);
  // The defaults are the phase-1 defaults.
  const plain = loadConfig(BASE);
  assert.ok(plain.ok);
  if (!plain.ok) return;
  assert.equal(plain.value.github.repos[0]?.ref, 'main');
  assert.equal(plain.value.github.repos[0]?.workflowFile, 'agent-implement-request.yml');
});

test('SHIM: GITHUB_APP_INSTALLATION_ID lands on the shim\'s one repository', () => {
  const cfg = loadConfig({ ...NO_GITHUB_AUTH, GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_INSTALLATION_ID: '777' });
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.internal ?? '');
  if (!cfg.ok) return;
  assert.equal(cfg.value.github.repos[0]?.installationId, 777);
});

test('SHIM: with neither form, GITHUB_OWNER and GITHUB_REPO are each reported missing, naming GITHUB_REPOS_JSON as the alternative', () => {
  const text = configError(NO_REPO);
  assert.match(text, /GITHUB_OWNER is required: set GITHUB_OWNER and GITHUB_REPO to the module repository, or list the repositories in GITHUB_REPOS_JSON\.\n {2}→ at GITHUB_OWNER/u);
  assert.match(text, /GITHUB_REPO is required: [^\n]*\n {2}→ at GITHUB_REPO/u);
});

test('GITHUB_REPOS_JSON: every field parsed, defaults applied, configuration order kept, per-entry setting names', () => {
  const cfg = loadConfig({ ...NO_REPO, GITHUB_TOKEN: undefined, GITHUB_APP_ID: '424242', GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_REPOS_JSON: TWO });
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.internal ?? '');
  if (!cfg.ok) return;
  assert.equal(cfg.value.github.reposSource, 'json');
  const [main, events] = cfg.value.github.repos;
  assert.deepEqual(
    cfg.value.github.repos.map((r) => [r.key, r.owner, r.repo, r.ref, r.workflowFile, r.installationId, r.isDefault]),
    [
      ['main', 'acme', 'bot-modules', 'main', 'agent-implement-request.yml', 1234567, true],
      ['events', 'acme', 'events-modules', 'main', 'agent-implement-request.yml', null, false],
    ],
  );
  assert.equal(main?.names.ref, 'GITHUB_REPOS_JSON.main.ref');
  assert.equal(events?.names.ownerRepo, 'GITHUB_REPOS_JSON.events.owner/repo');
});

test('GITHUB_REPOS_JSON: a one-entry set that says nothing about default IS the default, as the shim\'s repository is', () => {
  const cfg = loadConfig({ ...NO_REPO, GITHUB_REPOS_JSON: '{"solo":{"owner":"acme","repo":"x"}}' });
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.internal ?? '');
  if (!cfg.ok) return;
  assert.equal(cfg.value.github.repos[0]?.isDefault, true);
  // Several entries and no `default`: valid (guild routing is PR 2.2), and none is the default.
  const many = loadConfig({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"x"},"b":{"owner":"acme","repo":"y"}}' });
  assert.ok(many.ok);
  if (!many.ok) return;
  assert.deepEqual(many.value.github.repos.map((r) => r.isDefault), [false, false]);
});

test('GITHUB_REPOS_JSON beside ANY single-repository variable is refused, naming each, rather than merged', () => {
  for (const [name, value] of [
    ['GITHUB_OWNER', 'octo'],
    ['GITHUB_REPO', 'demo'],
    ['GITHUB_REF', 'main'],
    ['GITHUB_WORKFLOW_FILE', 'agent-implement-request.yml'],
    ['GITHUB_APP_INSTALLATION_ID', '777'],
  ] as const) {
    const text = configError({ ...NO_REPO, GITHUB_REPOS_JSON: TWO.replace(',"installationId":1234567', ''), [name]: value });
    assert.match(text, new RegExp(`GITHUB_REPOS_JSON is set, so ${name} must not be`, 'u'), name);
    assert.match(text, /→ at GITHUB_REPOS_JSON/u);
  }
  // Even an empty line counts as set, exactly as the auth rule says.
  assert.match(configError({ ...BASE, GITHUB_REPOS_JSON: TWO.replace(',"installationId":1234567', ''), GITHUB_OWNER: '' }), /GITHUB_OWNER, GITHUB_REPO must not be/u);
});

test('GITHUB_REPOS_JSON: a key that breaks the RFC pattern is refused, naming the key', () => {
  for (const key of ['Main', '1st', 'has_underscore', 'a'.repeat(32), '']) {
    const text = configError({ ...NO_REPO, GITHUB_REPOS_JSON: JSON.stringify({ [key]: { owner: 'acme', repo: 'x' } }) });
    assert.match(text, new RegExp(`"${key}" is not a repository key`, 'u'), key);
  }
  assert.ok(loadConfig({ ...NO_REPO, GITHUB_REPOS_JSON: JSON.stringify({ ['a'.repeat(31)]: { owner: 'acme', repo: 'x' } }) }).ok, '31 characters is the limit');
});

test('GITHUB_REPOS_JSON: duplicates are refused - a key written twice, and two keys naming one repository', () => {
  const twiceKey = configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"main":{"owner":"acme","repo":"a"},"main":{"owner":"evil","repo":"b"}}' });
  assert.match(twiceKey, /the key "main" is written more than once; JSON keeps only the last/u);
  assert.match(twiceKey, /→ at GITHUB_REPOS_JSON\.main/u);
  const twiceRepo = configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"mods"},"b":{"owner":"ACME","repo":"Mods"}}' });
  assert.match(twiceRepo, /"a" and "b" both name ACME\/Mods; a repository may appear in the set once/u);
});

test('GITHUB_REPOS_JSON: at most one default, strict entries, valid owner/repo/ref/workflowFile, installationId only with an App', () => {
  assert.match(
    configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"x","default":true},"b":{"owner":"acme","repo":"y","default":true}}' }),
    /more than one repository is marked "default": true \(a, b\)/u,
  );
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"x","workflowfile":"w.yml"}}' }), /→ at GITHUB_REPOS_JSON\.a/u);
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"-bad","repo":"x"}}' }), /must be a GitHub user or organisation name\n {2}→ at GITHUB_REPOS_JSON\.a\.owner/u);
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"x","ref":"../etc"}}' }), /is not a git ref[^\n]*\n {2}→ at GITHUB_REPOS_JSON\.a\.ref/u);
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"x","workflowFile":"run.sh"}}' }), /is not a workflow file name[^\n]*\n {2}→ at GITHUB_REPOS_JSON\.a\.workflowFile/u);
  assert.match(
    configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{"a":{"owner":"acme","repo":"x","installationId":5}}' }),
    /installationId pins a GitHub App installation, but the bot authenticates with GITHUB_TOKEN[^\n]*\n {2}→ at GITHUB_REPOS_JSON\.a\.installationId/u,
  );
});

test('GITHUB_REPOS_JSON: not JSON, not an object, or empty is refused with the shape to write', () => {
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{main:' }), /not valid JSON/u);
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '[]' }), /must be a JSON object keyed by repository key/u);
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '{}' }), /lists no repositories/u);
  assert.match(configError({ ...NO_REPO, GITHUB_REPOS_JSON: '' }), /not valid JSON/u, 'an empty line is set, and is not a set');
});

test('repository-set problems are reported in the SAME pass as every other bad variable', () => {
  const text = configError({ ...NO_REPO, DISCORD_TOKEN: 'short', GITHUB_REPOS_JSON: '{"Bad":{"owner":"acme","repo":"x"}}' });
  assert.match(text, /DISCORD_TOKEN/u);
  assert.match(text, /"Bad" is not a repository key/u);
});

test('topLevelJsonKeys sees duplicates JSON.parse hides, and ignores nested keys and keys inside strings', () => {
  assert.deepEqual(topLevelJsonKeys('{"a":{"a":1,"b":[{"c":2}]},"b":"x\\",\\"a\\":","a":3}'), ['a', 'b', 'a']);
  assert.equal(topLevelJsonKeys('[1,2]'), null);
});
