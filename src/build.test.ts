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
 */

import { strict as assert } from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const FIXTURES = join(SRC, 'testing', 'fixtures');
const PKG = 'discord-ai-feature-builder';

interface PackageJson {
  readonly name: string;
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
  const r = spawnSync(process.execPath, ['--conditions=source', join(ROOT, 'scripts', 'build.ts')], {
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
  assert.ok(setup.some((line) => line.startsWith('ExecStart=')), 'SETUP.md documents a systemd ExecStart');
  for (const line of [...docker, ...setup]) assert.match(line, /--conditions=source/u, line);
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
    // A built-in's event, typed through 'discord-ai-feature-builder/events' in src/engine.d.ts.
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

  // --- pack. `--ignore-scripts`: `prepack` is `npm run check`, which would run this test. --------
  const packDir = tempDir('engine-pack-');
  const packed = npm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], ROOT);
  assert.equal(packed.status, 0, output(packed));
  const [manifest] = JSON.parse(packed.stdout) as [{ filename: string; files: { path: string }[] }];
  const shipped = new Set(manifest.files.map((f) => f.path));
  for (const path of [
    'package.json',
    'tsconfig.module-repo.json',
    'AGENTS.md',
    'dist/engine-events.d.ts',
    'dist/modules/builder/events.d.ts',
    'dist/core/migrations/0001_init.sql',
    'dist/modules/ping/module.js',
    'src/core/module.ts',
  ]) {
    assert.ok(shipped.has(path), `the tarball does not contain ${path}`);
  }
  assert.ok(![...shipped].some((p) => p.startsWith('src/modules/') || p.startsWith('src/adapters/')), 'only src/core ships as source');
  const tarball = join(packDir, manifest.filename);

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
  for (const id of ['access', 'admin', 'builder', 'credentials', 'help', 'ping']) {
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
  for (const id of ['access', 'admin', 'builder', 'credentials', 'help', 'ping', 'demo']) assert.ok(listed.includes(id), `${id}: ${output(doctor)}`);
});
