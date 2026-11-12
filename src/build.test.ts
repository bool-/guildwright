/**
 * THE PACKAGE BOUNDARY (RFC-001 section 4.3, PR 1.2), proven by building it and installing it.
 *
 * Two halves, in ONE file on purpose: both need a fresh `dist/`, `node --test` runs test files
 * in parallel processes, and two files racing to delete and rebuild the same `dist/` would fail
 * nondeterministically. Inside one file the tests run in order against one build.
 *
 *  1. THE BUILD. `scripts/build.ts` runs once. Then: every migration is byte-identical in
 *     `dist/` (the ledger checksums bytes), every hand-written `.d.ts` is copied, a child Node
 *     WITHOUT `--conditions=source` can import the compiled engine, and the package resolves
 *     itself by name into `dist/`.
 *  2. PACK AND INSTALL. `npm pack`, then install the tarball into a temp directory laid out like
 *     the module-repo template (RFC-001 9.1), and prove the three things no in-repo test can:
 *     a module there TYPECHECKS against the engine's declarations - augmenting `AppEvents`,
 *     subscribing to a built-in's event, getting exactly the ports its tuple names - a widened
 *     tuple still fails with `CapabilityTupleMessage`, and the installed loader discovers the
 *     built-ins as `module.js` beside the repo's own `module.ts`. This is risk 6 of section 13:
 *     if TypeScript's handling of `imports` wildcards with conditions regresses, this fails
 *     before any group does. It needs the npm registry, so it runs only in CI (`CI` set, as
 *     GitHub Actions does) or when `ENGINE_PACK_TEST=1` is set: AGENTS.md promises that
 *     `npm run check` runs offline, and a laptop on a train must still be able to run the gate.
 *     It also skips when npm cannot be found next to this Node.
 *  3. THE MODULE-REPO TEMPLATE (RFC-001 9, PR 1.5). Offline: the template's gate files are
 *     byte-identical to the engine's, its AGENTS.md is the engine's with exactly the
 *     substitutions of `agentsSubstitutions()`, its MANIFEST.json is current, and the tarball
 *     carries the whole tree. Network-bound, under the same switch as 2: `init` into a temp dir,
 *     `npm ci` against the packed tarball, `scaffold demo --db`, `npm run check` green, `template
 *     check` clean through the installed bin, and `doctor --offline` listing `tags` and `demo`
 *     from MODULE_DIRS beside the six built-ins.
 */

import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Err, Ok, type Result } from '#core/result';
import { captureIo } from '#testing/fixtures/cli-io';

import { agentsSubstitutions, engineFacts, syncTemplate, templateAgentsMd, templateManifest } from '../scripts/build.ts';
import { runCli } from './cli.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const TEMPLATE = join(ROOT, 'template');
const FIXTURES = join(SRC, 'testing', 'fixtures');
const PKG = 'guildwright';

interface PackageJson {
  readonly name: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly imports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly files: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson(join(ROOT, 'package.json')) as PackageJson;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file under `dir`, skipping the loader's test fixtures exactly as the build does. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (abs !== FIXTURES) out.push(...walk(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** `src/x/y` -> `dist/x/y`. */
function inDist(srcFile: string): string {
  return join(DIST, relative(SRC, srcFile));
}

/** `node <args>` with NO `--conditions=source`: what an installed engine's consumer runs. */
function node(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120_000 });
}

function output(r: SpawnSyncReturns<string>): string {
  return `exit ${String(r.status)}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
}

/** The repo's own TypeScript, run through this Node (no `.cmd` shim, no shell). */
function tscEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

const hadDist = existsSync(DIST);
const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

before(() => {
  // The real npm script's command line, minus npm: `node --conditions=source scripts/build.ts`.
  // `--skip-template`: a build REWRITES a stale template/AGENTS.md or MANIFEST.json, and the
  // template tests below must see what is COMMITTED, not what this build just fixed.
  const r = spawnSync(process.execPath, ['--conditions=source', join(ROOT, 'scripts', 'build.ts'), '--skip-template'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(r.status, 0, `npm run build failed:\n${output(r)}`);
});

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  // Leave a developer's own `dist/` where it was (rebuilt from the same source); remove one
  // this test created, so `npm test` leaves the tree as it found it.
  if (!hadDist) rmSync(DIST, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// 1. The build
// ---------------------------------------------------------------------------------------

test('every migration under src/ is in dist/ byte for byte, because the ledger checksums bytes', () => {
  const migrations = walk(SRC).filter((f) => f.endsWith('.sql') && relative(SRC, f).split(sep).includes('migrations'));
  // Not vacuous: core has its own ledger, and builder has three files of its own.
  assert.ok(migrations.some((f) => relative(SRC, f).startsWith(`core${sep}migrations`)), 'core migrations exist');
  assert.ok(migrations.length >= 6, `found ${String(migrations.length)} migrations`);
  for (const file of migrations) {
    const copy = inDist(file);
    assert.ok(existsSync(copy), `${relative(ROOT, file)} was not copied to ${relative(ROOT, copy)}`);
    assert.equal(sha256(copy), sha256(file), `${relative(ROOT, copy)} differs from its source`);
  }
});

test('every hand-written .d.ts is copied, since tsc neither emits nor copies declaration inputs', () => {
  const declarations = walk(SRC).filter((f) => f.endsWith('.d.ts'));
  const rel = declarations.map((f) => relative(SRC, f).split(sep).join('/'));
  assert.ok(rel.includes('modules/builder/events.d.ts'));
  assert.ok(rel.includes('engine-events.d.ts'));
  for (const file of declarations) {
    assert.ok(existsSync(inDist(file)), `${relative(ROOT, file)} missing from dist/`);
    assert.equal(sha256(inDist(file)), sha256(file));
  }
});

test('engine-events.d.ts imports every built-in module that declares events', () => {
  // A built-in that publishes but is missing here is invisible to every module repo's compile:
  // its subscribers would name an event that, as far as their program knows, does not exist.
  const listed = readFileSync(join(SRC, 'engine-events.d.ts'), 'utf8');
  const withEvents = readdirSync(join(SRC, 'modules')).filter((id) => existsSync(join(SRC, 'modules', id, 'events.d.ts')));
  assert.ok(withEvents.includes('builder'));
  for (const id of withEvents) {
    assert.ok(listed.includes(`import './modules/${id}/events.js';`), `engine-events.d.ts does not import ${id}'s events`);
  }
});

test('tsc emitted JavaScript and declarations, and no test file made it into dist/', () => {
  for (const file of ['main.js', 'main.d.ts', 'loader.js', 'loader.d.ts', 'core/module.js', 'core/module.d.ts', 'testing/fakes.js']) {
    assert.ok(existsSync(join(DIST, file)), `dist/${file} missing`);
  }
  const leaked = walk(DIST).filter((f) => /\.test\.(?:js|d\.ts)$/u.test(f) || f.includes(`${sep}fixtures${sep}`));
  assert.deepEqual(leaked, []);
  // `rewriteRelativeImportExtensions` did its job: no compiled file imports a `.ts` path.
  const main = readFileSync(join(DIST, 'main.js'), 'utf8');
  assert.doesNotMatch(main, /from '\.\.?\/[^']*\.ts'/u);
});

test('a Node WITHOUT the source condition imports the compiled engine', () => {
  // `#core/*` inside dist resolves through the package's own `imports` map, `default`
  // condition, to `dist/core/*.js`. A wrong map is ERR_MODULE_NOT_FOUND here, not at install.
  const script = [
    `await import(${JSON.stringify(pathToFileURL(join(DIST, 'core', 'module.js')).href)});`,
    `await import(${JSON.stringify(pathToFileURL(join(DIST, 'main.js')).href)});`,
    `console.log(import.meta.resolve('#core/result'));`,
  ].join('\n');
  const r = node(['--input-type=module', '-e', script], ROOT);
  assert.equal(r.status, 0, output(r));
  assert.equal(r.stdout.trim(), pathToFileURL(join(DIST, 'core', 'result.js')).href);
});

test('the package resolves itself by name into dist/, while #core/* in the repo stays on source', () => {
  // Self-reference by package name works because `exports` is present. This file runs under
  // `--conditions=source`, and `exports` has no `source` branch, so the public paths are dist/
  // even here; `#core/*` (an `imports` entry, which does have one) is what keeps the repo on src.
  const events = fileURLToPath(import.meta.resolve(`${PKG}/core/events`));
  assert.equal(events, join(DIST, 'core', 'events.js'));
  assert.ok(existsSync(events));
  assert.equal(fileURLToPath(import.meta.resolve('#core/events')), join(SRC, 'core', 'events.ts'));
  assert.equal(fileURLToPath(import.meta.resolve(`${PKG}/loader`)), join(DIST, 'loader.js'));
});

// ---------------------------------------------------------------------------------------
// The shape of package.json and the module-repo tsconfig
// ---------------------------------------------------------------------------------------

test('every #subpath import is source -> types -> default, in that order', () => {
  // Order is semantics: Node and TypeScript take the FIRST matching condition. `source` must be
  // first or the repo stops running its own source; `types` before `default` or TypeScript reads
  // the `.js`.
  assert.deepEqual(Object.keys(pkg.imports).sort(), ['#adapters/*', '#core/*', '#modules/*', '#testing/*']);
  for (const [key, target] of Object.entries(pkg.imports)) {
    const dir = key.slice(1, -2);
    assert.deepEqual(target, {
      source: `./src/${dir}/*.ts`,
      types: `./dist/${dir}/*.d.ts`,
      default: `./dist/${dir}/*.js`,
    });
  }
  for (const script of ['start', 'dev', 'test', 'scaffold', 'build']) {
    assert.ok(pkg.scripts[script]?.includes('--conditions=source'), `npm run ${script} must run source`);
  }
});

test('every documented way to start the bot from source passes the source condition', () => {
  // Without `--conditions=source`, `node src/main.ts` resolves `#core/*` to `dist/`, which a
  // checkout does not have: ERR_MODULE_NOT_FOUND before the first line of main runs.
  // Two places: the shipped Dockerfile's CMD (the image compose.yaml builds), and the systemd
  // ExecStart that SETUP.md documents for running without Docker.
  const startsIn = (file: string): string[] =>
    readFileSync(join(ROOT, ...file.split('/')), 'utf8')
      .split('\n')
      .filter((line) => /\bnode\b.*src\/main\.ts/u.test(line));
  const docker = startsIn('Dockerfile');
  const setup = startsIn('docs/SETUP.md');
  assert.ok(docker.some((line) => line.startsWith('CMD')), 'the Dockerfile starts the bot with a CMD');
  assert.ok(setup.some((line) => line.startsWith('ExecStart=')), 'SETUP.md documents a systemd ExecStart for the engine checkout');
  for (const line of [...docker, ...setup]) assert.match(line, /--conditions=source/u, line);
});

test('every documented way to start a MODULE REPOSITORY runs the installed bin, with no source condition', () => {
  // The other half of the rule above: a module repository runs the COMPILED engine, and
  // `--conditions=source` there would point #core/* inside node_modules at its shipped .ts, which
  // Node refuses to strip. SETUP.md section 9 gives the Dockerfile CMD and the systemd ExecStart.
  const bin = `node_modules/${PKG}/${pkg.bin[PKG]?.replace(/^\.\//u, '') ?? ''}`;
  assert.equal(bin, `node_modules/${PKG}/dist/cli.js`);
  const lines = readFileSync(join(ROOT, 'docs', 'SETUP.md'), 'utf8')
    .split('\n')
    .filter((line) => line.includes(`node_modules/${PKG}/dist/`));
  assert.ok(lines.includes(`CMD ["node", "${bin}", "start"]`), 'SETUP.md documents the module-repository Dockerfile CMD');
  assert.ok(lines.includes(`ExecStart=/usr/bin/node ${bin} start`), 'SETUP.md documents the module-repository systemd ExecStart');
  for (const line of lines) assert.doesNotMatch(line, /--conditions=source/u, line);
  assert.ok(existsSync(join(ROOT, ...bin.slice(`node_modules/${PKG}/`.length).split('/'))), 'and the build emits that file');
});

test('zod is a peer dependency at an exact version, and is listed nowhere else', () => {
  // Two copies of zod make every manifest fail to typecheck (RFC-001 4.3), so the engine must
  // share the module repo's copy. And NOT also a devDependency: npm then marks it `dev` in the
  // lockfile and `npm ci --omit=dev` - the documented Docker build - silently drops it, while a
  // root peer dependency alone is installed by both `npm ci` and `npm ci --omit=dev`.
  assert.match(pkg.peerDependencies?.['zod'] ?? '', /^\d+\.\d+\.\d+$/u);
  assert.equal(pkg.dependencies?.['zod'], undefined);
  assert.equal(pkg.devDependencies?.['zod'], undefined);
});

test('tsconfig.module-repo.json is this repo tsconfig minus the source condition', () => {
  // A module repo must NOT carry `customConditions: ["source"]`: inside the installed engine it
  // would resolve `#core/*` to the shipped `src/core/*.ts` instead of the declarations.
  const engine = readJson(join(ROOT, 'tsconfig.json')) as { compilerOptions: Record<string, unknown> };
  const moduleRepo = readJson(join(ROOT, 'tsconfig.module-repo.json')) as { compilerOptions: Record<string, unknown> };
  const { customConditions, ...rest } = engine.compilerOptions;
  assert.deepEqual(customConditions, ['source']);
  assert.deepEqual(moduleRepo.compilerOptions, rest);
});

// ---------------------------------------------------------------------------------------
// 3a. The module-repo template, offline (RFC-001 4.3, 9)
// ---------------------------------------------------------------------------------------

/** The three files the boot digest check reads: byte-equal in the engine and the template. */
const GATE_FILES = ['.github/workflows/agent-implement-request.yml', '.github/scripts/verify_approval.py', '.github/claude/agent-settings.json'];

test("the template's three gate files are byte-identical to the engine's own", () => {
  // The engine extends itself with the same workflow and gates a module repo runs. A one-byte
  // difference would make every module repo that is correct by the template fail the engine's
  // own checks, or the reverse.
  for (const path of GATE_FILES) {
    assert.equal(sha256(join(TEMPLATE, ...path.split('/'))), sha256(join(ROOT, ...path.split('/'))), `template/${path} differs from ${path}`);
  }
});

test("template/AGENTS.md is the engine's AGENTS.md with exactly the substitutions applied", () => {
  const facts = engineFacts();
  const engine = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const committed = readFileSync(join(TEMPLATE, 'AGENTS.md'), 'utf8');
  assert.equal(committed, templateAgentsMd(engine, facts), 'template/AGENTS.md is stale: run npm run build and commit it');
  // Each substitution landed, and the engine-only sentences it replaces are gone.
  for (const sub of agentsSubstitutions(facts)) {
    assert.ok(committed.includes(sub.replace), `substitution "${sub.why}" is missing from template/AGENTS.md`);
  }
  assert.ok(!committed.includes('--conditions=source --test'), 'a module repo runs no source condition');
  assert.ok(!committed.includes('template/src/modules/tags/'), 'a module repo has the worked example at src/modules/tags/');
  assert.ok(committed.includes(`npx ${facts.bin} invite-url`));
  assert.ok(committed.includes(facts.repoUrl), 'a core change is routed to the engine repository');
});

test('an AGENTS.md edit that moves a substituted sentence fails the build, naming the substitution', () => {
  const engine = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').replace('live in `src/core/permissions.ts`.', 'live in the permissions file.');
  assert.throws(() => templateAgentsMd(engine, engineFacts()), /substitution "3\. the permissions integer" expected 1 occurrence/u);
});

test('template/MANIFEST.json is current, written for this engine version, and covers exactly .github/** and AGENTS.md', () => {
  assert.deepEqual(syncTemplate(ROOT, { write: false }), [], 'the template is stale: run npm run build and commit template/AGENTS.md and template/MANIFEST.json');
  const manifest = readJson(join(TEMPLATE, 'MANIFEST.json')) as { engineVersion: string; files: Record<string, string> };
  assert.equal(manifest.engineVersion, (readJson(join(ROOT, 'package.json')) as { version: string }).version);
  const gated = walkTree(TEMPLATE).filter((p) => p.startsWith('.github/') || p === 'AGENTS.md');
  assert.deepEqual(Object.keys(manifest.files).sort(), gated);
  for (const [path, digest] of Object.entries(manifest.files)) {
    assert.equal(sha256(join(TEMPLATE, ...path.split('/'))), digest, `the MANIFEST digest of ${path} does not match its bytes`);
  }
});

test('the build writes a stale MANIFEST.json and AGENTS.md, and leaves an up-to-date tree alone', () => {
  const copy = tempDir('engine-template-');
  writeFileSync(join(copy, 'package.json'), readFileSync(join(ROOT, 'package.json')));
  writeFileSync(join(copy, 'AGENTS.md'), readFileSync(join(ROOT, 'AGENTS.md')));
  cpSync(TEMPLATE, join(copy, 'template'), { recursive: true });
  writeFileSync(join(copy, 'template', 'AGENTS.md'), 'stale\n');
  writeFileSync(join(copy, 'template', 'MANIFEST.json'), '{}\n');

  assert.deepEqual(syncTemplate(copy, { write: false }), ['template/AGENTS.md', 'template/MANIFEST.json']);
  assert.equal(readFileSync(join(copy, 'template', 'MANIFEST.json'), 'utf8'), '{}\n', 'write: false writes nothing');
  assert.deepEqual(syncTemplate(copy, { write: true }), ['template/AGENTS.md', 'template/MANIFEST.json']);
  assert.ok(readFileSync(join(copy, 'template', 'AGENTS.md')).equals(readFileSync(join(TEMPLATE, 'AGENTS.md'))));
  assert.ok(readFileSync(join(copy, 'template', 'MANIFEST.json')).equals(readFileSync(join(TEMPLATE, 'MANIFEST.json'))));
  assert.deepEqual(syncTemplate(copy, { write: true }), [], 'idempotent');
  assert.equal(templateManifest(join(copy, 'template'), 'x').includes('"engineVersion": "x"'), true);
});

test("the template ci.yml is the engine's four jobs, minus the engine-only path, plus template-sync on the same pinned actions", () => {
  const engine = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const tpl = readFileSync(join(TEMPLATE, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = (yaml: string): string[] => [...yaml.matchAll(/^ {2}([a-z-]+):$/gmu)].map((m) => m[1] ?? '');
  assert.deepEqual(jobs(tpl), [...jobs(engine), 'template-sync']);
  assert.ok(!tpl.includes('|^src/core/(config|registry)'), 'the privileged-path warning drops src/core: a module repository has none');
  assert.ok(engine.includes('|^src/core/(config|registry)'), 'sanity: the engine still warns on it');
  const uses = (yaml: string): Set<string> => new Set([...yaml.matchAll(/uses:\s*(\S+)/gu)].map((m) => m[1] ?? ''));
  assert.deepEqual(uses(tpl), uses(engine), 'template-sync must pin the same action SHAs as the engine');
  const sync = tpl.slice(tpl.indexOf('  template-sync:'));
  assert.match(sync, /run: npm ci --ignore-scripts/u);
  assert.match(sync, new RegExp(`run: npx ${PKG} template check`, 'u'));
  // Every engine job body is carried over: the disclosure and test-change gates byte for byte.
  for (const job of ['require-operator-disclosure', 'require-test-change']) {
    const body = (yaml: string): string => {
      const at = yaml.indexOf(`  ${job}:`);
      // To the next job, or the comment banner that opens one.
      const next = yaml.slice(at + 3).search(/^ {2}(?:[a-z-]+:$|# -{20})/mu);
      return next === -1 ? yaml.slice(at) : yaml.slice(at, at + 3 + next);
    };
    assert.equal(body(tpl).trimEnd(), body(engine).trimEnd(), `${job} differs between the engine and the template`);
  }
});

test('the template names the engine one way: dependency, imports, tsconfig, engine.d.ts, scripts', () => {
  // The package is renamed in RFC-001 PR 1.8; this makes every place that rename must reach a
  // red assertion here rather than a module repo that cannot resolve #core/*.
  const tpl = readJson(join(TEMPLATE, 'package.json')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    imports: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.equal(pkg.name, PKG, 'the engine package is named once, here and in package.json');
  assert.deepEqual(pkg.bin, { [PKG]: './dist/cli.js' }, 'and its bin is the same name');
  assert.deepEqual(Object.keys(tpl.dependencies).sort(), [PKG, 'zod'].sort());
  assert.equal(tpl.dependencies[PKG], '<version>', 'init replaces the placeholder with the installed version');
  assert.equal(tpl.dependencies['zod'], pkg.peerDependencies?.['zod'], 'zod at exactly the engine peer pin, or two copies break every manifest');
  for (const dev of ['@types/node', 'oxlint', 'typescript']) assert.equal(tpl.devDependencies[dev], pkg.devDependencies?.[dev], dev);
  assert.deepEqual(tpl.imports, { '#core/*': `${PKG}/core/*`, '#modules/*': './src/modules/*.ts', '#testing/*': `${PKG}/testing/*` });
  for (const script of ['start', 'scaffold', 'doctor']) assert.equal(tpl.scripts[script], `${PKG} ${script}`);
  assert.ok(!JSON.stringify(tpl.scripts).includes('--conditions=source'), 'a module repo runs the compiled engine');
  assert.deepEqual(readJson(join(TEMPLATE, 'tsconfig.json')), { extends: `${PKG}/tsconfig.module-repo.json`, include: ['src/**/*.ts', 'src/**/*.d.ts'] });
  assert.equal(readFileSync(join(TEMPLATE, 'src', 'engine.d.ts'), 'utf8'), `import '${PKG}/events';\n`);
  assert.equal(
    readFileSync(join(TEMPLATE, 'src', 'conventions.test.ts'), 'utf8'),
    "import { registerConventionTests } from '#testing/conventions';\nregisterConventionTests({ root: process.cwd(), engineContract: true });\n",
  );
});

test('the template .env.example documents every variable the engine .env.example does', () => {
  const vars = (path: string): Set<string> => new Set([...readFileSync(path, 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gmu)].map((m) => m[1] ?? ''));
  const engine = vars(join(ROOT, '.env.example'));
  const tpl = vars(join(TEMPLATE, '.env.example'));
  assert.ok(engine.size > 10);
  assert.deepEqual([...engine].filter((v) => !tpl.has(v)), []);
  assert.ok(!existsSync(join(TEMPLATE, '.env')), 'the template never carries a .env');
});

test("the tags migration is byte-identical to the one existing installs recorded in core_migrations", () => {
  // RFC-001 section 10 step 4: the owner's database has applied this file, and the ledger
  // refuses to boot when an applied file's checksum moves. This is that checksum.
  assert.equal(sha256(join(TEMPLATE, 'src', 'modules', 'tags', 'migrations', '0001_init.sql')), '781860656b3c36452cbe4d568c960108f4588b402f0a31adb90cc52bc25f8753');
  assert.ok(!existsSync(join(SRC, 'modules', 'tags')), 'tags is no longer an engine built-in');
});

test('publish.yml can only be run by hand, and publishes nothing without an NPM_TOKEN secret', () => {
  const yaml = readFileSync(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  const on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\npermissions:'));
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gmu)].map((m) => m[1]), ['workflow_dispatch'], 'no push, tag or schedule trigger');
  const gate = yaml.indexOf('id: gate');
  assert.ok(gate !== -1 && gate < yaml.indexOf('uses: actions/checkout@'), 'the NPM_TOKEN gate is the first step');
  // Every step after the gate is conditional on it.
  const steps = yaml.slice(gate).split(/\n {6}- /u).slice(1);
  assert.ok(steps.length >= 5);
  for (const step of steps) assert.match(step, /if: steps\.gate\.outputs\.enabled == 'true'/u, step.split('\n')[0]);
  assert.match(yaml, /npm publish --provenance/u);
  assert.match(yaml, /init "\$OUT"[\s\S]*npm ci --ignore-scripts[\s\S]*npm run check/u, 'the template lockfile is generated and proven installable');
});

test('publish.yml pushes exactly the generated template to the template repository, and only with its own token', () => {
  // RFC-001 4.1 B, the deferral PR 1.5 left: "Use this template" must yield the tree init writes,
  // lockfile included, or every npm ci in a new module repository fails.
  const yaml = readFileSync(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
  const step = (name: string): string => {
    const at = yaml.indexOf(`- name: ${name}`);
    assert.notEqual(at, -1, `publish.yml has no step "${name}"`);
    const next = yaml.indexOf('\n      - ', at + 1);
    return next === -1 ? yaml.slice(at) : yaml.slice(at, next);
  };
  const gate = step('Stop unless the NPM_TOKEN secret is set');
  assert.match(gate, /TEMPLATE_REPO_TOKEN: \$\{\{ secrets\.TEMPLATE_REPO_TOKEN \}\}/u);
  assert.match(gate, /echo "template=false"/u, 'no TEMPLATE_REPO_TOKEN, no push');

  const generate = step('Generate and verify the template lockfile against the published engine');
  // The pushed tree is copied aside BEFORE npm ci, so it holds what init wrote and no node_modules.
  assert.ok(generate.indexOf('cp -a "$OUT" "$TREE"') > generate.indexOf('init "$OUT"'));
  assert.ok(generate.indexOf('cp -a "$OUT" "$TREE"') < generate.indexOf('npm ci --ignore-scripts'));

  const push = step('Push the generated template to the template repository');
  assert.match(push, /if: steps\.gate\.outputs\.enabled == 'true' && steps\.gate\.outputs\.template == 'true'/u);
  assert.match(push, /'bool-\/guildwright-template'/u, 'the default template repository');
  assert.ok(yaml.indexOf('- name: Push the generated template') > yaml.indexOf('- name: Generate and verify the template lockfile'), 'only a verified tree is pushed');
  assert.ok(push.includes('git rm -rq --ignore-unmatch .') && push.includes('cp -a "$TREE"/. .'), 'the template repository holds exactly the generated tree');
  assert.ok(!push.includes('git push --force') && !push.includes(' -f '), 'never a force push');
  assert.ok(!/https:\/\/[^"\s]*@github\.com/u.test(push), 'the token never goes into a URL');

  const privateRepo = step('Refuse a release from a private repository (npm provenance needs a public one)');
  assert.ok(yaml.indexOf('- name: Refuse a release from a private repository') < yaml.indexOf('- name: Publish with provenance'));
  assert.match(privateRepo, /REPO_PRIVATE: \$\{\{ github\.event\.repository\.private \}\}/u);

  // No ${{ }} inside any run: block - every value reaches the shell through env:.
  for (const block of yaml.split(/\n {8}run: /u).slice(1)) {
    const body = block.split(/\n {6}- /u)[0] ?? '';
    assert.ok(!body.includes('${{'), `a run: block interpolates an expression: ${body.slice(0, 80)}`);
  }
});

/** Every file under `dir` as sorted POSIX paths (no fixture skipping: for template/). */
function walkTree(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTree(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out.sort();
}

test('npm pack ships the whole template, dotfiles included, and no lockfile for it', { timeout: 120_000 }, (t) => {
  // npm never packs a file named `.gitignore`, which is why the template stores `gitignore` and
  // `init` renames it. Every other dotfile must survive packing, or `init` writes a repo without it.
  const npmCli = findNpmCli();
  if (npmCli === null) {
    t.skip('npm could not be found next to this Node');
    return;
  }
  const r = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, output(r));
  const [manifest] = JSON.parse(r.stdout) as [{ files: { path: string }[] }];
  const shipped = new Set(manifest.files.map((f) => f.path).filter((p) => p.startsWith('template/')).map((p) => p.slice('template/'.length)));
  assert.deepEqual([...shipped].sort(), walkTree(TEMPLATE));
  for (const p of ['gitignore', '.gitattributes', '.editorconfig', '.nvmrc', '.env.example', 'MANIFEST.json', '.github/workflows/ci.yml']) assert.ok(shipped.has(p), p);
  // RFC-001 9.1 "The lockfile": it pins the PUBLISHED engine, so it cannot exist in the tarball
  // that publishes it; `init` and publish.yml generate it.
  assert.ok(!shipped.has('package-lock.json'));
});

test('npm pack ships exactly the expected file list: dist, core source, the template and five root files', { timeout: 120_000 }, (t) => {
  // RFC-001 PR 1.8. The package is public from 1.0.0, so a file that lands in the tarball by
  // accident (a fixture, docs/, .github/, an .env.example) is published to everyone, and a file
  // that falls out of it (a template file, a migration) breaks every install. `files` in
  // package.json is the policy; this is the list it must produce.
  const npmCli = findNpmCli();
  if (npmCli === null) {
    t.skip('npm could not be found next to this Node');
    return;
  }
  const r = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, output(r));
  const [manifest] = JSON.parse(r.stdout) as [{ name: string; version: string; files: { path: string }[] }];
  assert.equal(manifest.name, PKG);
  const shipped = manifest.files.map((f) => f.path).sort();
  const expected = [
    'AGENTS.md',
    'CHANGELOG.md',
    'README.md',
    'package.json',
    'tsconfig.module-repo.json',
    ...walkTree(DIST).map((p) => `dist/${p}`),
    ...walkTree(join(SRC, 'core')).map((p) => `src/core/${p}`),
    ...walkTree(TEMPLATE).map((p) => `template/${p}`),
  ].sort();
  const missing = expected.filter((p) => !shipped.includes(p));
  const unexpected = shipped.filter((p) => !expected.includes(p));
  assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] });
  // The shape of what that means, so a reader of a failure knows what was promised.
  for (const p of ['dist/cli.js', 'dist/main.js', 'dist/core/module.d.ts', 'dist/engine-events.d.ts', 'src/core/module.ts', 'template/MANIFEST.json']) {
    assert.ok(shipped.includes(p), p);
  }
  for (const prefix of ['src/adapters/', 'src/modules/', 'src/testing/', 'docs/', '.github/', 'scripts/', 'brand/', 'dist/testing/fixtures/']) {
    assert.ok(!shipped.some((p) => p.startsWith(prefix)), `nothing under ${prefix} ships`);
  }
  for (const root of ['.env.example', 'Dockerfile', 'compose.yaml', 'package-lock.json', 'tsconfig.json']) {
    assert.ok(!shipped.includes(root), `${root} does not ship`);
  }
});

// ---------------------------------------------------------------------------------------
// 2. Pack and install
// ---------------------------------------------------------------------------------------

/** npm's own CLI script, so it can be run through this Node without a shell. */
function findNpmCli(): string | null {
  const candidates = [
    process.env['npm_execpath'],
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (c !== undefined && c.endsWith('.js') && existsSync(c)) return c;
  }
  return null;
}

const DEMO_EVENTS = `export {};

declare module '#core/events' {
  interface AppEvents {
    'demo.poked': { readonly by: string };
  }
}
`;

const DEMO_MODULE = `import { z } from 'zod';
import { defineModule } from '#core/module';
//CAPS_IMPORT

//CAPS_DECL
export default defineModule({
  id: 'demo',
  summary: 'The pack-and-install smoke test module.',
  capabilities: ['db', 'audit'],
  config: z.object({}),
  permissions: {},
  publishes: {
    // Declared in ./events.d.ts, an augmentation of the INSTALLED engine's AppEvents.
    'demo.poked': z.object({ by: z.string() }),
  },
  migrations: false,

  setup(ctx) {
    // A built-in's event, typed through 'guildwright/events' in src/engine.d.ts.
    const off = ctx.bus.on('builder.pr_opened', (e) => {
      const issue: number = e.issueNumber;
      const url: string = e.prUrl;
      ctx.emit('demo.poked', { by: \`\${url}#\${String(issue)}\` });
    });
    // @ts-expect-error an event nobody declared is still a compile error across the boundary
    ctx.bus.on('builder.no_such_event', () => {});
    const db = ctx.ports.db;
    const audit = ctx.ports.audit;
    // @ts-expect-error the tuple says db and audit, so there is no github port
    void ctx.ports.github;
    return {
      commands: [],
      subscriptions: [off],
      async health() {
        return { status: 'ok' as const, detail: \`\${typeof db}/\${typeof audit}\` };
      },
    };
  },
});
`;

const DISCOVER = `import { builtinRoot, discoverModules } from '${PKG}/loader';
import { fileURLToPath } from 'node:url';

const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
const r = await discoverModules({
  roots: [builtinRoot(), { dir: fileURLToPath(new URL('./src/modules', import.meta.url)), entry: 'module.ts', required: true }],
  disabled: new Set(),
  logger,
});
if (!r.ok) {
  console.error(JSON.stringify(r.error));
  process.exit(2);
}
console.log(JSON.stringify({
  builtin: builtinRoot(),
  discovered: r.value.discovered.map((m) => ({ id: m.descriptor.manifest.id, source: m.source })),
  quarantined: r.value.quarantined.map((q) => q.moduleId),
}));
`;

/** `npm pack` once per run, shared by the two pack tests. `--ignore-scripts`: `prepack` is `npm run check`, which would run this file. */
let packedOnce: { readonly tarball: string; readonly shipped: ReadonlySet<string> } | null = null;
function packEngine(npmCli: string): { readonly tarball: string; readonly shipped: ReadonlySet<string> } {
  if (packedOnce !== null) return packedOnce;
  const packDir = tempDir('engine-pack-');
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDir], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
  assert.equal(packed.status, 0, output(packed));
  const [manifest] = JSON.parse(packed.stdout) as [{ filename: string; files: { path: string }[] }];
  packedOnce = { tarball: join(packDir, manifest.filename), shipped: new Set(manifest.files.map((f) => f.path)) };
  return packedOnce;
}

test('pack, install into a module repo, typecheck it there, and discover its modules', { timeout: 300_000 }, (t) => {
  // Network-bound, so opt-in: CI always runs it; locally, `ENGINE_PACK_TEST=1 npm test` does.
  if (process.env['CI'] === undefined && process.env['ENGINE_PACK_TEST'] === undefined) {
    t.skip('needs the npm registry; set ENGINE_PACK_TEST=1 to run it locally (CI runs it always)');
    return;
  }
  const npmCli = findNpmCli();
  if (npmCli === null) {
    t.skip('npm could not be found next to this Node');
    return;
  }
  const npm = (args: readonly string[], cwd: string): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 240_000 });

  // --- pack ---------------------------------------------------------------------------------
  const { tarball, shipped } = packEngine(npmCli);
  for (const path of [
    'package.json',
    'tsconfig.module-repo.json',
    'AGENTS.md',
    'dist/engine-events.d.ts',
    'dist/modules/builder/events.d.ts',
    'dist/core/migrations/0001_init.sql',
    'dist/modules/ping/module.js',
    'src/core/module.ts',
    'template/MANIFEST.json',
    'template/AGENTS.md',
    'template/src/modules/tags/module.ts',
  ]) {
    assert.ok(shipped.has(path), `the tarball does not contain ${path}`);
  }
  assert.ok(![...shipped].some((p) => p.startsWith('src/modules/') || p.startsWith('src/adapters/')), 'only src/core ships as source');

  // --- a module repo laid out like the template (RFC-001 9.1) ------------------------------
  const repo = tempDir('module-repo-');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'my-bot-modules',
        version: '0.0.1',
        private: true,
        type: 'module',
        imports: {
          '#core/*': `${PKG}/core/*`,
          '#testing/*': `${PKG}/testing/*`,
          '#modules/*': './src/modules/*.ts',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repo, 'tsconfig.json'),
    JSON.stringify({ extends: `${PKG}/tsconfig.module-repo.json`, include: ['src/**/*.ts', 'src/**/*.d.ts'] }, null, 2),
  );
  mkdirSync(join(repo, 'src', 'modules', 'demo'), { recursive: true });
  writeFileSync(join(repo, 'src', 'engine.d.ts'), `import '${PKG}/events';\n`);
  writeFileSync(join(repo, 'src', 'modules', 'demo', 'events.d.ts'), DEMO_EVENTS);
  const demoPath = join(repo, 'src', 'modules', 'demo', 'module.ts');
  writeFileSync(demoPath, DEMO_MODULE);
  writeFileSync(join(repo, 'discover.mjs'), DISCOVER);

  // --- install: the tarball, zod at the engine's peer pin, @types/node for `types: ["node"]` --
  const zod = pkg.peerDependencies?.['zod'] ?? '';
  const typesNode = pkg.devDependencies?.['@types/node'] ?? '';
  const installed = npm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', tarball, `zod@${zod}`, `@types/node@${typesNode}`],
    repo,
  );
  assert.equal(installed.status, 0, output(installed));

  const tsc = (): SpawnSyncReturns<string> => node([tscEntry(), '-p', join(repo, 'tsconfig.json')], repo);

  // --- it typechecks against the installed declarations -------------------------------------
  const clean = tsc();
  assert.equal(clean.status, 0, `the demo module must typecheck against the installed engine:\n${output(clean)}`);

  // --- without src/engine.d.ts the built-ins' events are not in the program -------------------
  // The control for the line above: proves `builder.pr_opened` type-checked BECAUSE of the
  // `/events` export, not because event names had quietly widened to `string`.
  rmSync(join(repo, 'src', 'engine.d.ts'));
  const noEngineEvents = tsc();
  assert.notEqual(noEngineEvents.status, 0, 'builder.pr_opened must be unknown without the engine events import');
  assert.match(noEngineEvents.stdout, /builder\.pr_opened/u);
  writeFileSync(join(repo, 'src', 'engine.d.ts'), `import '${PKG}/events';\n`);

  // --- a widened tuple is still the named compile error ------------------------------------
  writeFileSync(
    demoPath,
    DEMO_MODULE.replace('//CAPS_IMPORT', "import type { Capability } from '#core/ports';")
      .replace('//CAPS_DECL', "const caps: Capability[] = ['db'];")
      .replace("capabilities: ['db', 'audit'],", 'capabilities: caps,'),
  );
  const widened = tsc();
  assert.notEqual(widened.status, 0, 'a widened capabilities tuple must not typecheck');
  // The text of `CapabilityTupleMessage` in `src/core/ports.ts`: the error PRINTS the fix.
  assert.match(widened.stdout, /`capabilities` must be an inline tuple of port names/u, output(widened));
  writeFileSync(demoPath, DEMO_MODULE);

  // --- the installed loader finds the built-ins as module.js and the repo's module.ts ---------
  const discovered = node([join(repo, 'discover.mjs')], repo);
  assert.equal(discovered.status, 0, output(discovered));
  const report = JSON.parse(discovered.stdout) as {
    builtin: { dir: string; entry: string };
    discovered: { id: string; source: string }[];
    quarantined: string[];
  };
  assert.equal(report.builtin.entry, 'module.js', 'an installed engine looks for compiled modules');
  assert.ok(report.builtin.dir.includes(join('node_modules', PKG, 'dist', 'modules')), report.builtin.dir);
  assert.deepEqual(report.quarantined, []);
  // `source` is the loader's display path (relative to the cwd); normalise the separator.
  const byId = new Map(report.discovered.map((m) => [m.id, m.source.split('\\').join('/')]));
  for (const id of ['access', 'admin', 'builder', 'credentials', 'help', 'ping', 'repos']) {
    const source = byId.get(id);
    assert.ok(source !== undefined, `built-in ${id} was not discovered: ${discovered.stdout}`);
    assert.ok(source.endsWith(`node_modules/${PKG}/dist/modules/${id}/module.js`), source);
  }
  assert.ok(byId.get('demo')?.endsWith('src/modules/demo/module.ts'), discovered.stdout);

  // --- the installed BIN runs: `<bin> doctor --offline` from the module repo (RFC-001 PR 1.4) ---
  // Through the package's own `bin` entry, the way `npx <bin>` resolves it, with no source
  // condition: the compiled CLI must find the built-ins as module.js beside the repo's module.ts.
  const installedPkg = readJson(join(repo, 'node_modules', PKG, 'package.json')) as { bin: Record<string, string> };
  const bin = installedPkg.bin[PKG];
  assert.equal(bin, './dist/cli.js');
  const doctor = spawnSync(process.execPath, [join(repo, 'node_modules', PKG, bin), 'doctor', '--offline'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DISCORD_TOKEN: 'x'.repeat(60),
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_OWNER_ID: '223456789012345678',
      GITHUB_TOKEN: `github_pat_${'C'.repeat(40)}`,
      GITHUB_OWNER: 'o',
      GITHUB_REPO: 'r',
      APPROVAL_HMAC_KEY: 'h'.repeat(48),
    },
  });
  assert.equal(doctor.status, 0, output(doctor));
  const listed = /modules discovered: (.+)/u.exec(doctor.stdout)?.[1]?.split(', ') ?? [];
  for (const id of ['access', 'admin', 'builder', 'credentials', 'help', 'ping', 'repos', 'demo']) assert.ok(listed.includes(id), `${id}: ${output(doctor)}`);
});

// ---------------------------------------------------------------------------------------
// 3b. The template, end to end, against the packed tarball (RFC-001 PR 1.5)
// ---------------------------------------------------------------------------------------

/** The env `doctor` needs to parse a config: valid shapes, no real credential anywhere. */
const DOCTOR_ENV = {
  DISCORD_TOKEN: 'x'.repeat(60),
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_OWNER_ID: '223456789012345678',
  GITHUB_TOKEN: `github_pat_${'C'.repeat(40)}`,
  GITHUB_OWNER: 'o',
  GITHUB_REPO: 'r',
  APPROVAL_HMAC_KEY: 'h'.repeat(48),
};

test('init the template, npm ci against the packed tarball, scaffold demo --db, and npm run check is green', { timeout: 900_000 }, async (t) => {
  if (process.env['CI'] === undefined && process.env['ENGINE_PACK_TEST'] === undefined) {
    t.skip('needs the npm registry; set ENGINE_PACK_TEST=1 to run it locally (CI runs it always)');
    return;
  }
  const npmCli = findNpmCli();
  if (npmCli === null) {
    t.skip('npm could not be found next to this Node');
    return;
  }
  // NODE_TEST_CONTEXT marks a process as a child of a running test: inherited, the module repo's
  // `node --test` would report to THIS run instead of printing, and exit 0 whatever happened.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const quiet = { ...inherited, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const npm = (args: readonly string[], cwd: string): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 300_000, env: quiet });
  const { tarball } = packEngine(npmCli);
  const version = (readJson(join(ROOT, 'package.json')) as { version: string }).version;

  // --- init, from this checkout's template - the tree the tarball carries (asserted below) ----
  // The engine is not on the registry, so `init`'s lockfile is generated against the TARBALL:
  // resolve it once as `file:<tarball>`, then put the exact-version pin back in package.json
  // and in the lockfile's root entry. The engine's lock entry keeps `resolved: file:...`, so
  // `npm ci` installs the packed engine while package.json says what a real module repo says.
  const parent = tempDir('template-init-');
  const target = join(parent, 'my-bot');
  const tarballLockfile = (dir: string): Result<void, string> => {
    const pkgPath = join(dir, 'package.json');
    const original = readFileSync(pkgPath, 'utf8');
    const asTarball = JSON.parse(original) as { dependencies: Record<string, string> };
    assert.equal(asTarball.dependencies[PKG], version, 'init pinned the engine to the installed version');
    asTarball.dependencies[PKG] = `file:${tarball}`;
    writeFileSync(pkgPath, JSON.stringify(asTarball, null, 2));
    const lock = npm(['install', '--package-lock-only', '--ignore-scripts'], dir);
    writeFileSync(pkgPath, original);
    if (lock.status !== 0) return Err(output(lock));
    const lockPath = join(dir, 'package-lock.json');
    const lockfile = readJson(lockPath) as { packages: Record<string, { dependencies?: Record<string, string> }> };
    const rootEntry = lockfile.packages[''];
    if (rootEntry?.dependencies !== undefined) rootEntry.dependencies[PKG] = version;
    writeFileSync(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`);
    return Ok(undefined);
  };
  const io = captureIo(parent);
  assert.equal(await runCli(['init', 'my-bot'], io.io, { engineRoot: ROOT, regenerateLockfile: tarballLockfile }), 0, io.all());
  assert.ok(existsSync(join(target, '.gitignore')) && existsSync(join(target, 'package-lock.json')));

  // --- npm ci, NOT npm install: the lockfile init wrote must be in sync with package.json ------
  const ci = npm(['ci', '--ignore-scripts'], target);
  assert.equal(ci.status, 0, `npm ci must succeed in a freshly initialised module repo:\n${output(ci)}`);
  const installed = join(target, 'node_modules', PKG);
  assert.equal((readJson(join(installed, 'package.json')) as { version: string }).version, version);
  assert.ok(
    readFileSync(join(installed, 'template', 'MANIFEST.json')).equals(readFileSync(join(TEMPLATE, 'MANIFEST.json'))),
    'the tarball ships the template init was run from',
  );

  // --- scaffold a second module through the installed bin, then the module repo's own gate ----
  const scaffolded = npm(['run', 'scaffold', '--', 'demo', '--summary', 'The pack test module.', '--db'], target);
  assert.equal(scaffolded.status, 0, output(scaffolded));
  assert.ok(existsSync(join(target, 'src', 'modules', 'demo', 'migrations', '0001_init.sql')));

  const check = npm(['run', 'check'], target);
  assert.equal(check.status, 0, `npm run check must be green in the module repo (typecheck, lint, tags + demo + conventions with the engine contract):\n${output(check)}`);
  assert.match(check.stdout, /every gated file matches the installed engine's template/u, 'the engine-contract tests ran');
  assert.match(check.stdout, /the module installs with exactly its declared ports/u, "the template's tags test ran");
  assert.match(check.stdout, /greet accepts a normal name and keeps it/u, "the scaffolded demo's test ran");
  assert.match(check.stdout, /^ℹ fail 0$/mu);

  // --- the installed bin, as `npx <bin>` runs it, with no source condition -------------------
  const bin = join(installed, (readJson(join(installed, 'package.json')) as { bin: Record<string, string> }).bin[PKG] ?? '');
  const runBin = (args: readonly string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [bin, ...args], { cwd: target, encoding: 'utf8', timeout: 120_000, env: { ...inherited, ...DOCTOR_ENV } });

  const sync = runBin(['template', 'check']);
  assert.equal(sync.status, 0, `the template-sync job's command must pass on a fresh repo:\n${output(sync)}`);

  const doctor = runBin(['doctor', '--offline']);
  assert.equal(doctor.status, 0, output(doctor));
  const listed = /modules discovered: (.+)/u.exec(doctor.stdout)?.[1]?.split(', ') ?? [];
  assert.deepEqual([...listed].sort(), ['access', 'admin', 'builder', 'credentials', 'demo', 'help', 'ping', 'repos', 'tags'], output(doctor));
});
