/**
 * `init`, `template check` and `template apply` (RFC-001 9.1, 9.5, section 10 step 4), each over a
 * temp directory, against a fake installed engine whose `template/` is the fixture under
 * `src/testing/fixtures/template/`.
 *
 * The lockfile test runs REAL npm, offline (`npm_config_offline=true`): the fixture template
 * depends only on a `file:` package it ships, so resolving it needs no registry, and `npm ci`
 * afterwards proves the regenerated lockfile is in sync with the rewritten `package.json`. It
 * skips only when npm cannot be found next to this Node. The `template apply` tests run real git.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Ok } from '#core/result';
import { captureIo, ENGINE_NAME, fakeEngineRoot, FIXTURE_ENGINE_VERSION, tempDir } from '#testing/fixtures/cli-io';

import { runCli } from '../cli.ts';
import { findNpmCli, npmLockfileRegenerator } from './npm.ts';
import { initPackageJson, isGatedPath, readTemplate, sha256Hex, type LockfileRegenerator } from './template.ts';

const ENGINE = { name: ENGINE_NAME, version: FIXTURE_ENGINE_VERSION };

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

const hasGit = spawnSync('git', ['--version']).status === 0;

/** A fake regenerator that records the call and writes a lockfile derived from package.json. */
function recordingRegenerator(): { readonly calls: string[]; readonly regenerate: LockfileRegenerator } {
  const calls: string[] = [];
  return {
    calls,
    regenerate: (dir) => {
      calls.push(dir);
      assert.equal(existsSync(join(dir, 'package-lock.json')), false, 'the stale lockfile must be gone before regeneration runs');
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, packages: { '': { name: pkg.name, dependencies: pkg.dependencies ?? {} } } }));
      return Ok(undefined);
    },
  };
}

/** An existing repository shaped like the owner's private repo before the split (section 10). */
function existingRepo(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'discord-ai-feature-builder-modules', version: '0.3.0', dependencies: { 'discord.js': '14.27.0', octokit: '5.0.5' } }, null, 2));
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'discord-ai-feature-builder-modules',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'discord-ai-feature-builder-modules', dependencies: { 'discord.js': '14.27.0', octokit: '5.0.5' } },
        'node_modules/discord.js': { version: '14.27.0' },
      },
    }),
  );
  writeFileSync(join(dir, '.env'), 'DISCORD_TOKEN=the-real-one\n');
  mkdirSync(join(dir, 'src', 'modules', 'tags', 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'src', 'modules', 'tags', 'migrations', '0001_init.sql'), '-- the LIVE migration; its checksum is in core_migrations\n');
  writeFileSync(join(dir, 'src', 'modules', 'tags', 'module.ts'), '// the group module\n');
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: the OLD engine ci, with engine-only steps\n');
  writeFileSync(join(dir, '.github', 'workflows', 'extra.yml'), 'name: the operator own workflow\n');
}

// ---------------------------------------------------------------------------------------
// The template contract
// ---------------------------------------------------------------------------------------

test('the fixture template satisfies the contract readTemplate enforces', (t) => {
  const { dir, cleanup } = tempDir('cli-engine-');
  t.after(cleanup);
  const r = readTemplate(fakeEngineRoot(dir), ENGINE);
  assert.ok(r.ok, r.ok ? '' : r.error.internal ?? '');
  assert.deepEqual([...r.value.gated.keys()], [
    '.github/claude/agent-settings.json',
    '.github/scripts/verify_approval.py',
    '.github/workflows/agent-implement-request.yml',
    '.github/workflows/ci.yml',
    'AGENTS.md',
  ]);
});

test('readTemplate refuses a missing template, a digest that lies, a foreign path and another engine version', (t) => {
  const { dir, cleanup } = tempDir('cli-engine-');
  t.after(cleanup);
  const none = readTemplate(dir, ENGINE);
  assert.ok(!none.ok);
  assert.match(none.error.internal ?? '', /ships no template\/ directory/u);

  const root = fakeEngineRoot(dir);
  writeFileSync(join(root, 'template', '.github', 'workflows', 'ci.yml'), 'tampered\n');
  const lying = readTemplate(root, ENGINE);
  assert.ok(!lying.ok);
  assert.match(lying.error.internal ?? '', /template\/\.github\/workflows\/ci\.yml does not match the digest/u);

  const other = readTemplate(fakeEngineRoot(dir), { ...ENGINE, version: '9.9.9' });
  assert.ok(!other.ok);
  assert.match(other.error.internal ?? '', /written for engine 0\.0\.0-fixture, but the engine is 9\.9\.9/u);

  const manifestPath = join(dir, 'template', 'MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
  manifest.files['src/modules/tags/migrations/0001_init.sql'] = sha256Hex(readFileSync(join(dir, 'template', 'src', 'modules', 'tags', 'migrations', '0001_init.sql')));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const foreign = readTemplate(dir, ENGINE);
  assert.ok(!foreign.ok);
  assert.match(foreign.error.internal ?? '', /not under \.github\/ and is not AGENTS\.md/u);
});

test('only .github/** and AGENTS.md are gated paths, and no path can climb out', () => {
  for (const p of ['.github/workflows/ci.yml', 'AGENTS.md']) assert.equal(isGatedPath(p), true, p);
  for (const p of ['src/modules/x.ts', 'package.json', '.github/../src/x.ts', '/AGENTS.md', '.github\\x', 'agents.md']) assert.equal(isGatedPath(p), false, p);
});

// ---------------------------------------------------------------------------------------
// template check
// ---------------------------------------------------------------------------------------

test('template check is clean on a copy of the template and names each drifted file with the fix', async (t) => {
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  const root = fakeEngineRoot(engine.dir);
  for (const p of ['.github/workflows/agent-implement-request.yml', '.github/workflows/ci.yml', '.github/scripts/verify_approval.py', '.github/claude/agent-settings.json', 'AGENTS.md']) {
    mkdirSync(join(repo.dir, ...p.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(repo.dir, ...p.split('/')), readFileSync(join(root, 'template', ...p.split('/'))));
  }
  const clean = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'check'], clean.io, { engineRoot: root }), 0, clean.all());
  assert.match(clean.stdout(), /5 gated files match/u);

  writeFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'name: hand-edited\n');
  writeFileSync(join(repo.dir, 'AGENTS.md'), readFileSync(join(root, 'template', 'AGENTS.md'), 'utf8').replace(/\n/gu, '\r\n'));
  const drifted = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'check'], drifted.io, { engineRoot: root }), 1);
  assert.match(drifted.stderr(), /\.github\/workflows\/ci\.yml: differs from the engine's copy; run npx discord-ai-feature-builder template apply and commit/u);
  assert.match(drifted.stderr(), /AGENTS\.md: differs/u, 'CRLF is drift: byte-identical is the property');
});

// ---------------------------------------------------------------------------------------
// template apply
// ---------------------------------------------------------------------------------------

test('template apply refuses a dirty tree and overwrites nothing', { skip: !hasGit && 'git is not installed' }, async (t) => {
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  const root = fakeEngineRoot(engine.dir);
  mkdirSync(join(repo.dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'name: committed\n');
  git(repo.dir, 'init', '-q');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'init');

  // An uncommitted edit to a gated file: applying would destroy it unseen.
  writeFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'name: my uncommitted edit\n');
  const dirty = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'apply'], dirty.io, { engineRoot: root }), 1);
  assert.match(dirty.stderr(), /template apply refused: these files have uncommitted changes/u);
  assert.match(dirty.stderr(), /\.github\/workflows\/ci\.yml/u);
  assert.equal(readFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'utf8'), 'name: my uncommitted edit\n', 'nothing was overwritten');
  assert.equal(existsSync(join(repo.dir, 'AGENTS.md')), false, 'nothing was written either');

  // An UNTRACKED file at a gated path is just as unseen.
  git(repo.dir, 'checkout', '--', '.github/workflows/ci.yml');
  writeFileSync(join(repo.dir, 'AGENTS.md'), 'my untracked notes\n');
  const untracked = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'apply'], untracked.io, { engineRoot: root }), 1);
  assert.match(untracked.stderr(), /AGENTS\.md/u);
});

test('template apply refuses outside a git working tree', async (t) => {
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  const c = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'apply'], c.io, { engineRoot: fakeEngineRoot(engine.dir) }), 1);
  assert.match(c.stderr(), /template apply refused: cannot tell whether the gated files have uncommitted changes/u);
  assert.equal(existsSync(join(repo.dir, '.github')), false);
});

test('template apply on a clean tree rewrites the gated files and nothing under src/', { skip: !hasGit && 'git is not installed' }, async (t) => {
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  const root = fakeEngineRoot(engine.dir);
  mkdirSync(join(repo.dir, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(repo.dir, 'src', 'modules', 'tags'), { recursive: true });
  writeFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml'), 'name: old\n');
  writeFileSync(join(repo.dir, 'src', 'modules', 'tags', 'module.ts'), '// mine\n');
  git(repo.dir, 'init', '-q');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'init');

  const c = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'apply'], c.io, { engineRoot: root }), 0, c.all());
  assert.match(c.stdout(), /updated\s+\.github\/workflows\/ci\.yml/u);
  assert.match(c.stdout(), /created\s+AGENTS\.md/u);
  assert.equal(readFileSync(join(repo.dir, 'src', 'modules', 'tags', 'module.ts'), 'utf8'), '// mine\n');
  const after = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'check'], after.io, { engineRoot: root }), 0, 'apply then check is clean');
});

// ---------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------

test('init writes the template into an empty directory, without the manifest or the template lockfile', async (t) => {
  const engine = tempDir('cli-engine-');
  const parent = tempDir('cli-init-');
  t.after(() => {
    engine.cleanup();
    parent.cleanup();
  });
  const regen = recordingRegenerator();
  const c = captureIo(parent.dir);
  assert.equal(await runCli(['init', 'my-bot'], c.io, { engineRoot: fakeEngineRoot(engine.dir), regenerateLockfile: regen.regenerate }), 0, c.all());
  const target = join(parent.dir, 'my-bot');
  assert.deepEqual(regen.calls, [target]);
  for (const p of ['.github/workflows/agent-implement-request.yml', 'AGENTS.md', '.env.example', '.gitignore', 'src/modules/tags/migrations/0001_init.sql']) {
    assert.ok(existsSync(join(target, ...p.split('/'))), p);
  }
  assert.equal(existsSync(join(target, 'MANIFEST.json')), false, 'engine metadata never lands in a module repo');
  assert.doesNotMatch(readFileSync(join(target, 'package-lock.json'), 'utf8'), /template-lockfile-that-init-must-never-copy/u);
  assert.equal(existsSync(join(target, '.env')), false);
  assert.match(c.stdout(), /npm ci && npm run check/u);

  // A non-empty directory is refused: init only writes into an empty one.
  const again = captureIo(parent.dir);
  assert.equal(await runCli(['init', 'my-bot'], again.io, { engineRoot: engine.dir, regenerateLockfile: regen.regenerate }), 1);
  assert.match(again.stderr(), /init refused: my-bot is not an empty directory/u);
});

test('init pins the engine in the module repo package.json to the INSTALLED version', () => {
  const r = initPackageJson({ name: 'my-bot-modules', dependencies: { [ENGINE_NAME]: '<version>', zod: '4.5.4' } }, { name: ENGINE_NAME, version: '1.4.0' }, null);
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(r.value), { name: 'my-bot-modules', dependencies: { [ENGINE_NAME]: '1.4.0', zod: '4.5.4' } });
  // --existing keeps the repository's own name, and adds no engine the template does not list.
  const kept = initPackageJson({ name: 'my-bot-modules', dependencies: { zod: '4.5.4' } }, { name: ENGINE_NAME, version: '1.4.0' }, 'old-name');
  assert.ok(kept.ok);
  assert.deepEqual(JSON.parse(kept.value), { name: 'old-name', dependencies: { zod: '4.5.4' } });
});

test('init --existing leaves src/modules/** and .env untouched, replaces .github/** and keeps the name', async (t) => {
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-existing-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  existingRepo(repo.dir);
  const before = {
    env: readFileSync(join(repo.dir, '.env')),
    sql: readFileSync(join(repo.dir, 'src', 'modules', 'tags', 'migrations', '0001_init.sql')),
    mod: readFileSync(join(repo.dir, 'src', 'modules', 'tags', 'module.ts')),
  };
  const regen = recordingRegenerator();
  const root = fakeEngineRoot(engine.dir);
  const c = captureIo(repo.dir);
  assert.equal(await runCli(['init', '.', '--existing'], c.io, { engineRoot: root, regenerateLockfile: regen.regenerate }), 0, c.all());

  assert.ok(readFileSync(join(repo.dir, '.env')).equals(before.env), '.env is never written');
  assert.ok(readFileSync(join(repo.dir, 'src', 'modules', 'tags', 'migrations', '0001_init.sql')).equals(before.sql), 'a live migration stays byte-identical');
  assert.ok(readFileSync(join(repo.dir, 'src', 'modules', 'tags', 'module.ts')).equals(before.mod));
  assert.ok(
    readFileSync(join(repo.dir, '.github', 'workflows', 'ci.yml')).equals(readFileSync(join(root, 'template', '.github', 'workflows', 'ci.yml'))),
    '.github is replaced by the template copies',
  );
  assert.equal(readFileSync(join(repo.dir, '.github', 'workflows', 'extra.yml'), 'utf8'), 'name: the operator own workflow\n', 'a workflow the template does not carry is left, and named');
  assert.match(c.stdout(), /\.github\/workflows\/extra\.yml is not part of the template/u);

  const pkg = JSON.parse(readFileSync(join(repo.dir, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
  assert.equal(pkg.name, 'discord-ai-feature-builder-modules', 'name is kept');
  assert.equal(pkg.dependencies['discord.js'], undefined, 'package.json is the template shape');
  assert.deepEqual(regen.calls, [repo.dir]);
  assert.doesNotMatch(readFileSync(join(repo.dir, 'package-lock.json'), 'utf8'), /discord\.js/u, 'the stale lockfile is replaced');
  const fresh = captureIo(repo.dir);
  assert.equal(await runCli(['template', 'check'], fresh.io, { engineRoot: root }), 0, 'a converted repository passes template check');
});

test('init --existing REGENERATES a stale lockfile pinning discord.js, and npm ci --ignore-scripts then succeeds (real npm, offline)', { timeout: 240_000 }, async (t) => {
  const npmCli = findNpmCli(process.env);
  if (npmCli === null) {
    t.skip('npm could not be found next to this Node');
    return;
  }
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-existing-');
  const cache = tempDir('cli-npm-cache-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
    cache.cleanup();
  });
  existingRepo(repo.dir);
  // Offline, against an EMPTY cache: nothing can be fetched, so success means the tree resolved
  // from what the template ships (`vendor/local-dep`) and nothing else.
  const offline = { npm_config_offline: 'true', npm_config_cache: cache.dir, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const npm = (...args: string[]) => spawnSync(process.execPath, [npmCli, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, ...offline }, timeout: 120_000 });

  const c = captureIo(repo.dir);
  const code = await runCli(['init', '.', '--existing'], c.io, { engineRoot: fakeEngineRoot(engine.dir), regenerateLockfile: npmLockfileRegenerator(process.env, offline) });
  assert.equal(code, 0, c.all());

  const lock = JSON.parse(readFileSync(join(repo.dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { dependencies?: Record<string, string> }> };
  assert.equal(lock.packages['node_modules/discord.js'], undefined, 'the regenerated lockfile no longer pins discord.js');
  assert.deepEqual(lock.packages['']?.dependencies, { 'local-dep': 'file:vendor/local-dep' }, 'it is the lockfile of the template package.json');

  const ci = npm('ci', '--ignore-scripts');
  assert.equal(ci.status, 0, `npm ci --ignore-scripts must succeed after init --existing:\n${ci.stdout}\n${ci.stderr}`);
  assert.ok(existsSync(join(repo.dir, 'node_modules', 'local-dep', 'package.json')));
});

test('a lockfile that cannot be regenerated is reported, and the stale one is not left behind', async (t) => {
  const engine = tempDir('cli-engine-');
  const repo = tempDir('cli-existing-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  existingRepo(repo.dir);
  const c = captureIo(repo.dir);
  const code = await runCli(['init', '.', '--existing'], c.io, { engineRoot: fakeEngineRoot(engine.dir), regenerateLockfile: () => ({ ok: false, error: 'no network' }) });
  assert.equal(code, 1);
  assert.match(c.stderr(), /could not generate package-lock\.json: no network/u);
  assert.match(c.stderr(), /Run npm install --package-lock-only --ignore-scripts in \. before npm ci/u);
  assert.equal(existsSync(join(repo.dir, 'package-lock.json')), false, 'an out-of-sync lockfile must not survive looking valid');
});
