/**
 * The CLI's own surface (RFC-001 PR 1.4): the `bin` entry, the one bin-name constant, argument
 * parsing, `start` loading `.env` before it runs the bot, and `scaffold` moved out of `scripts/`
 * with `npm run scaffold` still reaching it. The subcommands with real behaviour have their own
 * files under `src/cli/`.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLI_BIN } from '#core/version';
import { MODULE_ID_RE } from '#core/module';
import { TEMPLATE_APPLY_COMMAND } from '#adapters/github/gates';
import { enginePackageRoot } from '#adapters/system/version';
import { captureIo, tempDir } from '#testing/fixtures/cli-io';

import { parseArgv, runCli, USAGE } from './cli.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string>;
  scripts: Record<string, string>;
};
const deps = { engineRoot: enginePackageRoot() };

test('the package bin is CLI_BIN -> dist/cli.js, and every sentence names that binary', () => {
  assert.deepEqual(pkg.bin, { [CLI_BIN]: './dist/cli.js' });
  // Until PR 1.8 renames the product the bin IS the package name, which is what lets
  // `npx <name>` find it from any module repo that depends on the engine.
  assert.equal(CLI_BIN, pkg.name);
  assert.equal(TEMPLATE_APPLY_COMMAND, `npx ${CLI_BIN} template apply`);
  assert.match(USAGE, new RegExp(`^usage: ${CLI_BIN} <command>`, 'u'));
  // The compiled entry keeps its hashbang, or `npx` on POSIX cannot execute it.
  assert.match(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8'), /^#!\/usr\/bin\/env node\n/u);
});

test('npm run scaffold reaches the CLI, and scripts/scaffold-module.ts is gone', () => {
  assert.equal(pkg.scripts['scaffold'], 'node --conditions=source src/cli.ts scaffold');
  assert.equal(existsSync(join(ROOT, 'scripts', 'scaffold-module.ts')), false);
});

test('parseArgv: --flag, --flag value, --flag=value, -- and unknown flags', () => {
  const spec = { yes: 'boolean', 'older-than': 'value' } as const;
  assert.deepEqual(parseArgv(['--yes', '--older-than', '90d', 'x'], spec), { positionals: ['x'], flags: new Map<string, string | true>([['yes', true], ['older-than', '90d']]) });
  assert.deepEqual(parseArgv(['--older-than=12w'], spec), { positionals: [], flags: new Map([['older-than', '12w']]) });
  assert.deepEqual(parseArgv(['--', '--yes'], spec), { positionals: ['--yes'], flags: new Map() });
  assert.equal(parseArgv(['--nope'], spec), 'unknown option: --nope');
  assert.equal(parseArgv(['--older-than'], spec), '--older-than needs a value');
  assert.equal(parseArgv(['--older-than', '--yes'], spec), '--older-than needs a value');
  assert.equal(parseArgv(['--yes=1'], spec), '--yes takes no value');
});

test('no command, an unknown one, or a bad flag is a usage error (exit 2); help is not', async () => {
  for (const argv of [[], ['frobnicate'], ['doctor', '--bogus'], ['init'], ['template', 'sync']]) {
    const c = captureIo(process.cwd());
    assert.equal(await runCli(argv, c.io, deps), 2, argv.join(' '));
  }
  const help = captureIo(process.cwd());
  assert.equal(await runCli(['help'], help.io, deps), 0);
  for (const command of ['start', 'doctor', 'invite-url', 'scaffold', 'init', 'template check', 'template apply', 'gc-approvals']) {
    assert.ok(help.stdout().includes(`  ${command}`), command);
  }
});

test('start loads ./.env with process.loadEnvFile, without overriding the environment, then runs the bot', async (t) => {
  const { dir, cleanup } = tempDir('cli-start-');
  const keys = ['CLI_START_TEST_FROM_FILE', 'CLI_START_TEST_ALREADY_SET'] as const;
  t.after(() => {
    cleanup();
    for (const k of keys) Reflect.deleteProperty(process.env, k);
  });
  writeFileSync(join(dir, '.env'), 'CLI_START_TEST_FROM_FILE=from-file\nCLI_START_TEST_ALREADY_SET=from-file\n');
  process.env['CLI_START_TEST_ALREADY_SET'] = 'from-environment';
  const seen: Record<string, string | undefined>[] = [];
  const c = captureIo(dir);
  const code = await runCli(['start'], c.io, {
    ...deps,
    run: async (env) => {
      seen.push({ fromFile: env['CLI_START_TEST_FROM_FILE'], alreadySet: env['CLI_START_TEST_ALREADY_SET'] });
      return 7;
    },
  });
  assert.equal(code, 7, 'start returns the bot exit code');
  assert.deepEqual(seen, [{ fromFile: 'from-file', alreadySet: 'from-environment' }]);
});

test('start without a .env runs the bot on the environment as it is', async (t) => {
  const { dir, cleanup } = tempDir('cli-start-');
  t.after(cleanup);
  let ran = 0;
  const c = captureIo(dir);
  assert.equal(await runCli(['start'], c.io, { ...deps, run: async () => ++ran }), 1);
  assert.equal(ran, 1);
});

test('scaffold writes src/modules/<id>/ under the WORKING directory, refuses a bad id and a non-empty folder', async (t) => {
  const { dir, cleanup } = tempDir('cli-scaffold-');
  t.after(cleanup);
  const c = captureIo(dir);
  assert.equal(await runCli(['scaffold', 'demo', '--summary', 'A demo.', '--db'], c.io, deps), 0, c.all());
  const folder = join(dir, 'src', 'modules', 'demo');
  assert.deepEqual(readdirSync(folder).sort(), ['domain.ts', 'migrations', 'module.test.ts', 'module.ts', 'present.ts', 'repo.ts']);
  assert.deepEqual(readdirSync(join(folder, 'migrations')), ['0001_init.sql']);
  assert.match(readFileSync(join(folder, 'module.ts'), 'utf8'), /summary: "A demo\."/u);
  assert.match(c.stdout(), /npm run check/u);
  assert.match(c.stdout(), /AGENTS\.md/u);

  const again = captureIo(dir);
  assert.equal(await runCli(['scaffold', 'demo'], again.io, deps), 1);
  assert.match(again.stderr(), /src\/modules\/demo\/ already exists and is not empty/u);

  // The id rule is the registry's own: the scaffolder cannot mint an id boot would refuse.
  for (const id of ['Demo', 'x', '9lives', 'a'.repeat(32)]) {
    assert.equal(MODULE_ID_RE.test(id), false, id);
    const bad = captureIo(dir);
    assert.equal(await runCli(['scaffold', id], bad.io, deps), 1, id);
    assert.match(bad.stderr(), /is not a valid module id/u);
  }
});

test('npm run scaffold still works end to end (the real npm script command line)', (t) => {
  const { dir, cleanup } = tempDir('cli-scaffold-');
  t.after(cleanup);
  // `npm run scaffold -- plain` runs this, from the repository being extended.
  const r = spawnSync(process.execPath, ['--conditions=source', join(ROOT, 'src', 'cli.ts'), 'scaffold', 'plain'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(existsSync(join(dir, 'src', 'modules', 'plain', 'module.ts')));
  assert.ok(!existsSync(join(dir, 'src', 'modules', 'plain', 'repo.ts')), 'repo.ts only with --db');
});
