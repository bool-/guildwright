/**
 * THE ARCHITECTURE RULES, ENFORCED.
 *
 * The assertions that used to live in this file moved to `src/testing/conventions.ts`
 * (RFC-001 section 4.4), because the engine will be published as a package and every group's
 * module repository must run the same checks with the same failure sentences. This file is now
 * the engine's consumer of that helper; a module repo's `src/conventions.test.ts` is the same
 * call without `coreDir` and `allowedAsNever`.
 *
 * Nothing here is engine-only enough to stay behind: the two engine-specific tests (the core
 * hexagon and the `as never` allow-list) are registered by the helper when `coreDir` is set.
 *
 * WHEN YOU HIT ONE OF THESE: the rule is the product. Do not add an exception to make your change
 * compile - see "If you are blocked" in AGENTS.md.
 *
 * BELOW THE CALL, the engine's own DOCUMENTATION CONVENTIONS (RFC-001 PR 1.8). They are engine-only
 * because the documents are: a module repository has no `docs/SETUP.md` or `CHANGELOG.md`. Each one
 * pins a fact an operator acts on to the code that makes it true, so the two cannot drift apart:
 *
 *   - the product name is ONE name on every surface an operator filters or greps for;
 *   - every variable `EnvSchema` reads is documented where an operator looks for it;
 *   - the GitHub App permission tables say exactly what the boot check demands;
 *   - the sentences the RFC requires on the first screens are there, in those words;
 *   - the changelog has an entry for the version being released.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { EnvSchema } from '#core/config';
import { errors } from '#core/errors';
import { BOOT_REFUSAL_PREFIX, CLI_BIN, LOG_SERVICE, PRODUCT_NAME } from '#core/version';
import { REQUIRED_APP_PERMISSIONS } from '#adapters/github/app-auth';
import { GITHUB_USER_AGENT } from '#adapters/github/client';
import { registerConventionTests } from '#testing/conventions';

import { ENGINE_KEY, ENGINE_PACKAGE, formatConfigFailure } from './main.ts';

registerConventionTests({
  root: process.cwd(),
  coreDir: 'src/core',
  allowedAsNever: ['src/adapters/github/dispatch.ts'],
});

// ---------------------------------------------------------------------------------------
// Engine-only: the documentation conventions
// ---------------------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, ...path.split('/')), 'utf8');
const pkg = JSON.parse(read('package.json')) as { name: string; version: string; bin: Record<string, string> };

/** Every file under `dir` (relative to the repo root), as POSIX paths, skipping test fixtures. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      const rel = relative(ROOT, child).split(sep).join('/');
      if (entry.isDirectory()) {
        if (rel !== 'src/testing/fixtures') walk(child);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(join(ROOT, ...dir.split('/')));
  return out.sort();
}

test('the product name agrees on every surface: package, bin, user agent, log service and boot prefix', () => {
  // RFC-001 section 12 decision 1. These are read by different people for one question - "which
  // program is this?" - an npm user, a GitHub audit-log search, a log filter, someone reading a
  // crash on a console. Four answers would send each of them somewhere else.
  assert.equal(PRODUCT_NAME, 'guildwright');
  assert.equal(pkg.name, PRODUCT_NAME, 'package.json name');
  assert.deepEqual(Object.keys(pkg.bin), [PRODUCT_NAME], 'package.json bin');
  assert.equal(CLI_BIN, PRODUCT_NAME, 'CLI_BIN');
  assert.equal(GITHUB_USER_AGENT, PRODUCT_NAME, 'the GitHub user agent');
  assert.equal(LOG_SERVICE, PRODUCT_NAME, 'the log service field');
  assert.equal(BOOT_REFUSAL_PREFIX, `${PRODUCT_NAME} cannot start:`, 'the boot refusal prefix');
  assert.equal(ENGINE_PACKAGE, PRODUCT_NAME, 'the duplicate-engine guard names the package');
  assert.equal(ENGINE_KEY, Symbol.for(`${PRODUCT_NAME}.engine`));

  // And the places that USE them really do: the config-failure text, and the logger's root binding.
  const failure = formatConfigFailure(errors.config('env', 'detail', 'Fix it.'));
  assert.ok(failure.includes(`\n${BOOT_REFUSAL_PREFIX} `), failure);
  const main = read('src/main.ts');
  assert.match(main, /^ {6}service: LOG_SERVICE,$/mu, 'src/main.ts binds the log service field from LOG_SERVICE');
  assert.equal([...main.matchAll(/\bservice:/gu)].length, 1, 'and binds no other service field');
});

test('no shipped surface still says the old names', () => {
  // The rename is one commit on purpose (RFC-001 12.1): a sentence left behind tells an operator
  // to run a binary that does not exist, or to filter logs on a service that no longer logs.
  const surfaces = [
    ...filesUnder('src').filter((f) => !f.endsWith('.test.ts')),
    ...filesUnder('scripts'),
    ...filesUnder('template'),
    'package.json',
    'README.md',
    'AGENTS.md',
    '.env.example',
    'compose.yaml',
    'Dockerfile',
    'docs/SETUP.md',
  ];
  const offenders: string[] = [];
  for (const file of surfaces) {
    const text = read(file);
    if (text.includes('discord-ai-feature-builder')) offenders.push(`${file}: discord-ai-feature-builder`);
    // SETUP.md section 11 names the OLD log strings on purpose, to tell an operator to change
    // their filters; nothing else may.
    if (file !== 'docs/SETUP.md' && /discord-bot cannot start|service: 'discord-bot'|'discord-bot'/u.test(text)) {
      offenders.push(`${file}: discord-bot`);
    }
  }
  assert.deepEqual(offenders, []);
  // Every refusal-to-start sentence in the source is built from the one prefix.
  const literal = filesUnder('src')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => /['"`][a-z-]+ cannot start:/u.test(read(f)));
  assert.deepEqual(literal, [], 'write BOOT_REFUSAL_PREFIX, not a literal "<name> cannot start:"');
});

test('every EnvSchema variable is documented in both .env.example files and in docs/SETUP.md', () => {
  // `process.env` is read exactly once, through EnvSchema, so this list IS the configuration
  // surface. A variable missing from .env.example is one an operator cannot discover; one missing
  // from SETUP.md is one the setup guide forgot to explain.
  const variables = Object.keys(EnvSchema.shape).sort();
  assert.ok(variables.length >= 20, `sanity: ${variables.join(', ')}`);
  const assigned = (text: string): Set<string> => new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gmu)].map((m) => m[1] ?? ''));
  const engineExample = assigned(read('.env.example'));
  const templateExample = assigned(read('template/.env.example'));
  const setup = read('docs/SETUP.md');
  const missing: string[] = [];
  for (const v of variables) {
    if (!engineExample.has(v)) missing.push(`.env.example: ${v}`);
    if (!templateExample.has(v)) missing.push(`template/.env.example: ${v}`);
    if (!setup.includes(`\`${v}\``)) missing.push(`docs/SETUP.md: ${v}`);
  }
  assert.deepEqual(missing, []);
  // And SETUP.md's reference table has one row per variable, so none is only mentioned in passing.
  const rows = new Set([...setup.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gmu)].map((m) => m[1] ?? ''));
  assert.deepEqual(variables.filter((v) => !rows.has(v)), [], 'docs/SETUP.md "Every environment variable" lists each one');
});

test('the GitHub App permission tables say exactly what the boot check demands', () => {
  // The operator registers the App by copying one of these tables; the bot then refuses to start
  // unless the installation grants REQUIRED_APP_PERMISSIONS. A table that disagrees with the check
  // is an App that registers fine and never boots.
  const access = (a: string): string => (a === 'write' ? 'Read and write' : 'Read');
  for (const doc of ['docs/SETUP.md', 'template/README.md']) {
    const text = read(doc);
    for (const p of REQUIRED_APP_PERMISSIONS) {
      assert.match(text, new RegExp(`^ *\\| ${p.label} \\| ${access(p.access)} \\|`, 'mu'), `${doc} must list ${p.label}: ${access(p.access)}`);
    }
  }
  assert.ok(read('docs/SETUP.md').includes('| **Secrets** | **Read** | **required.**'), 'SETUP.md says a PAT needs Secrets: read (RFC-001 6.6)');
});

test('the first screens carry the sentences RFC-001 requires, in those words', () => {
  const readme = read('README.md');
  const firstScreen = readme.slice(0, readme.indexOf('\n## '));
  assert.ok(firstScreen.includes('One instance, one trust domain.'), 'README first screen: one instance, one trust domain (RFC-001 1)');
  assert.ok(firstScreen.includes('npx guildwright@'), 'README first screen: how to start');
  // RFC-001 13, risk 1: "AGENTS.md, the template README and the engine README say 'merging a
  // module grants it the bot's full authority' in those words".
  const authority = /merging\s+a\s+module\s+grants\s+it\s+the\s+bot's\s+full\s+authority/u;
  for (const doc of ['README.md', 'AGENTS.md', 'template/README.md', 'template/AGENTS.md', 'docs/SETUP.md']) {
    assert.match(read(doc), authority, `${doc}: merging a module grants it the bot's full authority`);
  }
  // RFC-001 13, risk 17.
  for (const doc of ['template/README.md', 'docs/SETUP.md']) {
    assert.match(read(doc), /one process per database file/iu, `${doc}: one process per database file`);
  }
});

test('docs/SETUP.md walks the App and module-repository setup the RFC describes', () => {
  const setup = read('docs/SETUP.md');
  const needles: readonly (readonly [string, string])[] = [
    ['npx guildwright@1.0.0 init my-bot-modules', 'install via init (RFC-001 9.1)'],
    ['bool-/guildwright-template', 'or "Use this template" on the template repository'],
    ['npx guildwright invite-url', 'the permissions integer comes from the CLI'],
    ['**Uncheck Webhook → Active**', 'App setup 6.3 step 2'],
    ['**Only select repositories**', 'App setup 6.3 step 7'],
    ['./secrets/app.pem', 'App setup 6.3 step 6'],
    ['npx guildwright doctor', 'doctor before start'],
    ['npm start', 'start'],
    ['node_modules/guildwright/dist/cli.js', 'a module repository runs the installed engine (Docker, systemd)'],
    ['GITHUB_REPOS_JSON=', 'the multi-repository section (PR 2.4)'],
    ['npx guildwright template apply', 'upgrading the engine'],
    ['npx guildwright@1.0.0 init . --existing', 'moving an existing install (RFC-001 10 step 4)'],
    ['Secrets: read', 'the PAT cutover needs Secrets: read (RFC-001 10 step 5)'],
    ['0005_repo_key.sql', 'the first engine boot applies a migration, so back up first'],
    ['`service` field', 'log filters change with the rename'],
  ];
  for (const [needle, why] of needles) assert.ok(setup.includes(needle), `docs/SETUP.md no longer covers ${why} (missing ${JSON.stringify(needle)})`);
  const arch = read('docs/ARCHITECTURE.md');
  assert.match(arch, /^## 10\. The build step/mu, 'ARCHITECTURE.md: the build step');
  assert.match(arch, /^## 11\. The package boundary$/mu, 'ARCHITECTURE.md: the package boundary');
});

test('CHANGELOG.md opens with the version package.json carries, and records the contract breaks', () => {
  // A release whose changelog does not mention it is a release nobody can upgrade to on purpose.
  // publish.yml runs `npm run check`, so this fails before a version without an entry can ship.
  const changelog = read('CHANGELOG.md');
  const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gmu)].map((m) => m[1]);
  assert.equal(versions[0], pkg.version, 'the newest CHANGELOG.md entry must be the package.json version');
  const entry = changelog.slice(changelog.indexOf(`## ${pkg.version}`));
  const breaking = entry.split('\n').filter((line) => line.startsWith('- BREAKING:')).join('\n');
  for (const name of ['BuildsPort', 'VersionPort', 'PortRegistry']) {
    assert.ok(breaking.includes(name), `the ${pkg.version} entry must record the ${name} change under BREAKING:`);
  }
});
