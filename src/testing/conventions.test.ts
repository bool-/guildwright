/**
 * The convention helper is itself under test, because a convention suite that silently registers
 * fewer tests, or passes against the wrong directory, is worse than none (RFC-001 section 4.4).
 *
 * Each case runs the helper in a CHILD `node --test` process: the helper calls node:test's
 * top-level `test(...)`, and registering those inside a running test would nest them in this one.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const REPO = process.cwd();
const HELPER_URL = pathToFileURL(join(REPO, 'src/testing/conventions.ts')).href;
const FIXTURE = join(REPO, 'src/testing/fixtures/conventions');

const scratch = mkdtempSync(join(tmpdir(), 'conventions-test-'));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Run `registerConventionTests(optsJson)` in a child node:test process and return its TAP output.
 * `rootExpr` is a JS expression for the root, because the engine case needs the child's own cwd.
 */
function runHelper(optsSource: string, cwd: string): { readonly tap: string; readonly status: number | null } {
  const dir = mkdtempSync(join(scratch, 'run-'));
  const file = join(dir, 'consumer.test.ts');
  writeFileSync(
    file,
    `import { registerConventionTests } from ${JSON.stringify(HELPER_URL)};\nregisterConventionTests(${optsSource});\n`,
  );
  // NODE_TEST_CONTEXT marks a process as a child of a running test; inherited, the child would
  // report to its parent's stream instead of printing TAP and would always exit 0.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, encoding: 'utf8', env });
  return { tap: `${r.stdout}\n${r.stderr}`, status: r.status };
}

function tapNames(tap: string): { readonly passed: string[]; readonly failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  for (const m of tap.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # .*)?$/gmu)) {
    // TAP escapes `#` and `\` in test names.
    (m[1] === 'ok' ? passed : failed).push((m[2] ?? '').replaceAll('\\#', '#').replaceAll('\\\\', '\\'));
  }
  return { passed, failed };
}

test('registers every assertion the old src/conventions.test.ts made, nothing fewer', () => {
  // `src/conventions.test.ts` had 13 top-level `test(` calls on the day it was moved
  // (RFC-001 PR 1.3). If this number moves, a rule was added or lost; change it on purpose.
  const EXPECTED = 13;

  const { tap, status } = runHelper(
    `{ root: process.cwd(), coreDir: 'src/core', allowedAsNever: ['src/adapters/github/dispatch.ts'] }`,
    REPO,
  );
  const { passed, failed } = tapNames(tap);
  assert.equal(status, 0, `the engine must pass its own conventions:\n${tap}`);
  assert.deepEqual(failed, []);
  assert.equal(passed.length, EXPECTED);
});

test('without coreDir the hexagon and `as never` tests are not registered', () => {
  const { tap } = runHelper(`{ root: process.cwd() }`, REPO);
  const { passed, failed } = tapNames(tap);
  assert.deepEqual(failed, []);
  assert.equal(passed.length, 11);
  assert.ok(!passed.some((n) => n.startsWith('core imports')));
  assert.ok(!passed.some((n) => n.startsWith('`as never`')));
});

/** The fixture ships `.ts` files as `.ts.fixture` so tsc, oxlint and the engine's own walk skip them. */
function materialiseFixture(): string {
  const dest = join(scratch, `fixture-${String(Date.now())}`);
  cpSync(FIXTURE, dest, { recursive: true });
  const unmask = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) unmask(full);
      else if (entry.endsWith('.fixture')) renameSync(full, full.slice(0, -'.fixture'.length));
    }
  };
  unmask(dest);
  return dest;
}

test('a module repo with one violation per rule fails each matching test by name', () => {
  const root = materialiseFixture();
  const { tap, status } = runHelper(`{ root: ${JSON.stringify(root)} }`, scratch);
  const { passed, failed } = tapNames(tap);

  assert.notEqual(status, 0);
  assert.deepEqual(
    [...failed].sort(),
    [
      'modules import only #core, their own folder, and zod',
      'no component collectors anywhere: routing must survive a restart',
      'no module imports another module',
      'no module unwraps a Secret: `.reveal(` appears zero times under src/modules',
      'modules take time from ctx.ports.clock, never ambiently',
      'subpath imports carry no extension; relative imports carry .ts',
    ].sort(),
  );
  // The fixture's guide and workflow stubs are well formed, so the disclosure tests must pass:
  // proving the six failures above are the violations and not a broken stub.
  assert.ok(passed.includes('AGENTS.md documents the same `## Operator action required` rule'));
  assert.ok(passed.includes('the agent prompt requires an `## Operator action required` section in the PR body'));
  assert.ok(passed.includes('CI still fails a pull request whose body omits the section'));
  assert.ok(passed.includes('CI still fails a pull request that changes src/ and touches no test'));

  // The agent reads the sentence AGENTS.md promised.
  assert.ok(tap.includes('Modules reach the outside world through ctx.ports only'));
  assert.ok(tap.includes('see AGENTS.md rule 1'));
  assert.ok(tap.includes('src/modules/bad/wall.ts imports "discord.js"'));
});

test('a #lib import in a module hits the import wall', () => {
  const root = materialiseFixture();
  writeFileSync(join(root, 'src/modules/bad/wall.ts'), `import { x } from '#lib/x';\nexport const wall = x;\n`);
  const { tap } = runHelper(`{ root: ${JSON.stringify(root)} }`, scratch);
  assert.ok(tap.includes('src/modules/bad/wall.ts imports "#lib/x"'));
});

test('fails loudly, never vacuously, when root has no AGENTS.md', () => {
  const empty = mkdtempSync(join(scratch, 'empty-'));
  const { tap, status } = runHelper(`{ root: ${JSON.stringify(empty)} }`, scratch);
  assert.notEqual(status, 0);
  assert.ok(tap.includes('AGENTS.md not found at'), tap);
});

test('fails loudly when a modules dir holds no files', () => {
  const root = materialiseFixture();
  mkdirSync(join(root, 'elsewhere'));
  const { tap, status } = runHelper(`{ root: ${JSON.stringify(root)}, modulesDirs: ['elsewhere'] }`, scratch);
  assert.notEqual(status, 0);
  assert.ok(tap.includes('would pass vacuously'), tap);
});

test('the fixture README of intent: the shipped fixture files are all masked', () => {
  // Guards the masking itself: a bare `.ts` file in the fixture would be linted, typechecked and
  // scanned by the engine's own walk, failing the engine's suite for the wrong reason.
  const bare: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.endsWith('.ts')) bare.push(full);
    }
  };
  visit(FIXTURE);
  assert.deepEqual(bare, []);
  assert.ok(readFileSync(join(FIXTURE, 'AGENTS.md'), 'utf8').includes('Operator action required'));
});

// ---------------------------------------------------------------------------------------
// The module-repo template (RFC-001 PR 1.5)
// ---------------------------------------------------------------------------------------

const TEMPLATE = join(REPO, 'template');

test('the template passes the module-repo suite, carrying every DISCLOSURES needle in its AGENTS.md', () => {
  // `root: template/` with no `coreDir`: exactly the call a module repo makes, minus the engine
  // contract (the template's package.json still holds the `<version>` placeholder `init` fills).
  const { tap, status } = runHelper(`{ root: ${JSON.stringify(TEMPLATE)} }`, scratch);
  const { passed, failed } = tapNames(tap);
  assert.equal(status, 0, `the template must pass the module-repo conventions:\n${tap}`);
  assert.deepEqual(failed, []);
  assert.equal(passed.length, 11);
  // The needles are asserted by this test of the helper, against the template's own AGENTS.md.
  assert.ok(passed.includes('AGENTS.md documents the same `## Operator action required` rule'));
  assert.ok(passed.includes('CI still fails a pull request whose body omits the section'));
});

/** A copy of the template as `init` leaves it: the engine pinned to this checkout's version. */
function initialisedTemplate(): string {
  const dest = mkdtempSync(join(scratch, 'module-repo-'));
  cpSync(TEMPLATE, dest, { recursive: true });
  const engine = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { name: string; version: string };
  const pkgPath = join(dest, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies[engine.name] = engine.version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return dest;
}

const CONTRACT = [
  'package.json pins the engine to an exact version',
  'the pinned engine version is the installed one',
  "every gated file matches the installed engine's template",
  'the agent workflow has LF line endings',
];

test('with engineContract, the initialised template passes all four contract tests', () => {
  const root = initialisedTemplate();
  const { tap, status } = runHelper(`{ root: ${JSON.stringify(root)}, engineContract: true }`, scratch);
  const { passed, failed } = tapNames(tap);
  assert.equal(status, 0, tap);
  assert.deepEqual(failed, []);
  assert.equal(passed.length, 11 + CONTRACT.length);
  for (const name of CONTRACT) assert.ok(passed.includes(name), name);
});

test('the engine contract fails a ranged pin, a pin to another version, and a drifted or CRLF gate file, by name', () => {
  const ranged = initialisedTemplate();
  const engine = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { name: string; version: string };
  const pkgPath = join(ranged, 'package.json');
  const pin = (spec: string): void => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> };
    pkg.dependencies[engine.name] = spec;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  };
  const contractFailures = (root: string): { readonly failed: string[]; readonly tap: string } => {
    const { tap } = runHelper(`{ root: ${JSON.stringify(root)}, engineContract: true }`, scratch);
    return { failed: tapNames(tap).failed.filter((n) => CONTRACT.includes(n)).sort(), tap };
  };

  pin(`^${engine.version}`);
  const caret = contractFailures(ranged);
  assert.deepEqual(caret.failed, ['package.json pins the engine to an exact version', 'the pinned engine version is the installed one'].sort(), caret.tap);
  assert.ok(caret.tap.includes('Pin an exact version'), caret.tap);

  pin('9.9.9');
  const other = contractFailures(ranged);
  assert.deepEqual(other.failed, ['the pinned engine version is the installed one'], other.tap);
  assert.ok(other.tap.includes('Run npm ci'), other.tap);

  const drifted = initialisedTemplate();
  const ci = join(drifted, '.github', 'workflows', 'ci.yml');
  writeFileSync(ci, `${readFileSync(ci, 'utf8')}# a local edit\n`);
  const edit = contractFailures(drifted);
  assert.deepEqual(edit.failed, ["every gated file matches the installed engine's template"], edit.tap);
  assert.ok(edit.tap.includes('.github/workflows/ci.yml: differs from the engine'), edit.tap);
  assert.ok(edit.tap.includes('template apply and commit'), edit.tap);

  const crlf = initialisedTemplate();
  const wf = join(crlf, '.github', 'workflows', 'agent-implement-request.yml');
  writeFileSync(wf, readFileSync(wf, 'utf8').replace(/\n/gu, '\r\n'));
  const cr = contractFailures(crlf);
  assert.deepEqual(cr.failed, ["every gated file matches the installed engine's template", 'the agent workflow has LF line endings'].sort(), cr.tap);
});
