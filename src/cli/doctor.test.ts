/**
 * `<bin> doctor` (RFC-001 4.2, 4.3, 5.4, 6.6), over temp directories: a fake installed engine, a
 * module repository, and - for the GitHub half - the stub transport for the client's own three
 * reads plus the fake GitHub seam for every containment probe and the gate check, so nothing
 * reaches the network and no 5xx costs a backoff.
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkZodSingleCopy } from '#adapters/system/version';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';
import { captureIo, ENGINE_NAME, tempDir, VALID_ENV } from '#testing/fixtures/cli-io';
import { ENGINE_FILES, fakeGithub, githubError, SETTINGS, SHA_A, VERIFIER, WORKFLOW_PATH, type FakeGithub } from '#testing/fixtures/github-fake';

import { runCli } from '../cli.ts';
import { isUnansweredWarning } from './doctor.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** A package directory `node_modules/zod` with just a manifest, which is all resolution reads. */
function fakeZod(root: string, version: string): void {
  writeJson(join(root, 'node_modules', 'zod', 'package.json'), { name: 'zod', version, main: 'index.js' });
}

/**
 * An installed engine at `version`: its package.json, and a `template/` holding the three gate
 * files the fake GitHub serves with the `MANIFEST.json` that records them, which is where the
 * gate check reads its reference digests.
 */
function engineAt(dir: string, version: string): string {
  writeJson(join(dir, 'package.json'), { name: ENGINE_NAME, version, peerDependencies: { zod: '4.5.4' } });
  const files: Record<string, string> = {};
  for (const [path, body] of [
    [WORKFLOW_PATH, ENGINE_FILES.workflow],
    [VERIFIER, ENGINE_FILES.verifier],
    [SETTINGS, ENGINE_FILES.settings],
  ] as const) {
    mkdirSync(join(dir, 'template', ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, 'template', ...path.split('/')), body);
    files[path] = createHash('sha256').update(body, 'utf8').digest('hex');
  }
  writeJson(join(dir, 'template', 'MANIFEST.json'), { engineVersion: version, files });
  return dir;
}

/** No built-ins and no module dirs: the offline checks run without importing the real modules. */
const NO_MODULES = { MODULES_BUILTIN: 'false' };

test('doctor on a fixture with two zod copies fails with the pin sentence', async (t) => {
  const engine = tempDir('doctor-engine-');
  const repo = tempDir('doctor-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  // The engine resolves its own nested zod; the module repo resolves a different one.
  engineAt(engine.dir, '1.0.0');
  fakeZod(engine.dir, '4.5.4');
  writeJson(join(repo.dir, 'package.json'), { name: 'my-bot', dependencies: { [ENGINE_NAME]: '1.0.0', zod: '^4.0.0' } });
  fakeZod(repo.dir, '4.6.0');

  const c = captureIo(repo.dir, { ...VALID_ENV, ...NO_MODULES });
  const code = await runCli(['doctor', '--offline'], c.io, { engineRoot: engine.dir });
  assert.equal(code, 1, c.all());
  assert.match(c.stderr(), /guildwright cannot start: two copies of zod are installed \(.+ and .+\); pin "zod": "4\.5\.4" in package\.json to match the engine and run npm ci/u);
});

test('one copy of zod, resolved from both sides, is fine; two different directories refuse', (t) => {
  const engine = tempDir('zod-engine-');
  const repo = tempDir('zod-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  // A hoisted install: the engine lives INSIDE the repo's node_modules and finds the repo's zod.
  fakeZod(repo.dir, '4.5.4');
  const installed = join(repo.dir, 'node_modules', ENGINE_NAME);
  writeJson(join(installed, 'package.json'), { name: ENGINE_NAME, version: '1.0.0', peerDependencies: { zod: '4.5.4' } });
  assert.deepEqual(checkZodSingleCopy(installed, repo.dir), { kind: 'ok' });
  // A nested second copy under the engine is exactly the broken install.
  fakeZod(installed, '4.6.0');
  const v = checkZodSingleCopy(installed, repo.dir);
  assert.equal(v.kind, 'refuse');
  // And a side that resolves no zod at all is not a second copy.
  assert.deepEqual(checkZodSingleCopy(engine.dir, repo.dir), { kind: 'ok' });
});

test('doctor refuses a module repo that pins a different engine than is installed', async (t) => {
  const engine = tempDir('doctor-engine-');
  const repo = tempDir('doctor-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  engineAt(engine.dir, '1.0.0');
  writeJson(join(repo.dir, 'package.json'), { name: 'my-bot', dependencies: { [ENGINE_NAME]: '0.9.0' } });
  const c = captureIo(repo.dir, { ...VALID_ENV, ...NO_MODULES });
  assert.equal(await runCli(['doctor', '--offline'], c.io, { engineRoot: engine.dir }), 1);
  assert.match(c.stderr(), /package\.json asks for guildwright@0\.9\.0 but 1\.0\.0 is installed\. Run npm ci\./u);
  // A module repo also needs the built-ins' event declarations in its program.
  assert.match(c.stderr(), /src\/engine\.d\.ts is missing/u);
});

test('doctor reports a broken config AND the rest in one pass, and reads ./.env', async (t) => {
  const engine = tempDir('doctor-engine-');
  const repo = tempDir('doctor-repo-');
  t.after(() => {
    engine.cleanup();
    repo.cleanup();
  });
  engineAt(engine.dir, '1.0.0');
  writeJson(join(repo.dir, 'package.json'), { name: 'my-bot' });
  writeFileSync(join(repo.dir, '.env'), 'GITHUB_OWNER=o\nMODULE_DIRS=./no-such-dir\n');
  const c = captureIo(repo.dir, { MODULES_BUILTIN: 'false' });
  assert.equal(await runCli(['doctor'], c.io, { engineRoot: engine.dir }), 1);
  const err = c.stderr();
  assert.match(err, /→ at DISCORD_TOKEN/u, 'every missing variable');
  assert.doesNotMatch(err, /→ at GITHUB_OWNER/u, 'GITHUB_OWNER came from .env');
  assert.match(err, /MODULE_DIRS/u, 'and the discovery failure, in the same run');
  assert.match(err, /GitHub was not checked, because the configuration above has to be fixed first/u);
});

/** The client's own three preflight reads, healthy; the repo's privacy mirrors the fake's. */
function clientTransport(gh: FakeGithub) {
  return stubFetch((req: RecordedRequest): StubResponse => {
    const p = new URL(req.url).pathname;
    if (p === '/repos/o/r') return { status: 200, body: { full_name: 'o/r', private: gh.state.isPrivate, has_issues: true } };
    if (p.includes('/actions/workflows/')) return { status: 200, body: { state: 'active' } };
    if (p.includes('/commits/')) return { status: 200, body: { sha: SHA_A } };
    return { status: 404, body: { message: 'unexpected in this test' } };
  });
}

async function onlineDoctor(gh: FakeGithub, env: Readonly<Record<string, string>> = {}) {
  const engine = tempDir('doctor-engine-');
  const repo = tempDir('doctor-repo-');
  engineAt(engine.dir, '1.7.0');
  writeJson(join(repo.dir, 'package.json'), { name: 'my-bot' });
  const c = captureIo(repo.dir, { ...VALID_ENV, ...env });
  try {
    // Built-ins ON (the default), so the builder loads and every build-path probe runs.
    const code = await runCli(['doctor'], c.io, { engineRoot: engine.dir, fetch: clientTransport(gh).fetch, probeRequest: gh.request });
    return { code, c };
  } finally {
    engine.cleanup();
    repo.cleanup();
  }
}

test('doctor online: a healthy install passes every 5.4 check, and still prints the warnings boot only logged', async () => {
  const gh = fakeGithub();
  const { code, c } = await onlineDoctor(gh, { MODULES_JSON: '{"builder":{"ref":"release"}}' });
  assert.equal(code, 0, c.all());
  const out = c.all();
  assert.match(out, /modules discovered: .*builder/u);
  assert.match(out, /GitHub: PAT/u);
  assert.match(out, /builder: ready/u);
  // The two lines 1.6 and 1.7 only ever logged at boot:
  assert.match(out, /warning: MODULES_JSON\.builder\.ref is ignored: builds now dispatch at GITHUB_REF/u);
  assert.match(out, /note: GitHub auth: running on a personal access token bound to one GitHub account.*Register a GitHub App/u);
  // Every probe was asked, through the seam.
  for (const key of ['secret', 'environments', 'commit', 'contents'] as const) assert.ok(gh.count(key) > 0, key);
});

test('doctor online: a public target repository refuses with the 5.4 sentence', async () => {
  const gh = fakeGithub();
  gh.state.isPrivate = false;
  const { code, c } = await onlineDoctor(gh);
  assert.equal(code, 1);
  assert.match(c.stderr(), /o\/r is PUBLIC, so every request filed into it would be public\./u);
  assert.match(c.stderr(), /Make the repository private, or set ALLOW_PUBLIC_TARGET_REPO=true/u);
});

test('doctor online: a check GitHub could not answer is a problem, not a pass', async () => {
  const gh = fakeGithub();
  gh.fail.set('secret', githubError(503));
  const { code, c } = await onlineDoctor(gh);
  assert.equal(code, 1, c.all());
  assert.match(c.stderr(), /problem: could not check the APPROVAL_HMAC_KEY repository secret on o\/r \(GitHub answered 503\)/u);
  assert.match(c.stderr(), /problem: builder: down/u);
});

test('doctor online: drifted gate files leave builds disabled, naming the fix', async () => {
  const gh = fakeGithub();
  gh.push('b'.repeat(40), { [VERIFIER]: 'print("weakened")\n' });
  const { code, c } = await onlineDoctor(gh);
  assert.equal(code, 1);
  assert.match(c.stderr(), /\.github\/scripts\/verify_approval\.py in o\/r does not match the engine's template \(engine 1\.7\.0\)\. Run npx guildwright template apply, commit, and restart\./u);
});

test('the unanswered-check shapes are the ones the preflight, the probes and the App session write', () => {
  for (const w of [
    'could not check the APPROVAL_HMAC_KEY repository secret on o/r (GitHub answered 503); the bot is starting',
    'could not reach GitHub during the boot preflight (preflight.workflow); the bot is starting anyway',
    'GitHub answered 502 during the boot preflight (preflight.workflow); the bot is starting anyway',
    'GitHub answered 500 while the bot read GitHub App 12 at boot; the bot is starting anyway, but this is unverified until the next restart.',
    'GitHub got no response while the bot checked installation 7 at boot; the bot is starting anyway, but this is unverified until the next restart.',
  ]) {
    assert.equal(isUnansweredWarning(w), true, w);
  }
  for (const w of [
    'GITHUB_OWNER/GITHUB_REPO is spelled O/R but GitHub spells it o/r.',
    'could not read the ai-agent environment on o/r (HTTP 403); with requireOwnCredentials false, builds are still dispatched',
    'the PAT expires in 3 days',
  ]) {
    assert.equal(isUnansweredWarning(w), false, w);
  }
});

// ---------------------------------------------------------------------------------------
// The repository set (RFC-001 PR 2.1): every repository is checked, and findings name theirs
// ---------------------------------------------------------------------------------------

test('doctor online, GITHUB_REPOS_JSON: every repository is checked in one pass, and a refusal names its repository', async () => {
  const gh = fakeGithub();
  const engine = tempDir('doctor-engine-');
  const repo = tempDir('doctor-repo-');
  engineAt(engine.dir, '1.7.0');
  writeJson(join(repo.dir, 'package.json'), { name: 'my-bot' });
  const { GITHUB_OWNER: _o, GITHUB_REPO: _r, ...rest } = VALID_ENV;
  const env = {
    ...rest,
    GITHUB_REPOS_JSON: JSON.stringify({ main: { owner: 'acme', repo: 'priv', default: true }, events: { owner: 'acme', repo: 'pub', ref: 'trunk' } }),
  };
  const transport = stubFetch((req: RecordedRequest): StubResponse => {
    const p = new URL(req.url).pathname;
    if (p === '/repos/acme/priv') return { status: 200, body: { full_name: 'acme/priv', private: true, has_issues: true } };
    if (p === '/repos/acme/pub') return { status: 200, body: { full_name: 'acme/pub', private: false, has_issues: true } };
    if (p.includes('/actions/workflows/')) return { status: 200, body: { state: 'active' } };
    if (p.includes('/commits/')) return { status: 200, body: { sha: SHA_A } };
    return { status: 404, body: { message: 'unexpected in this test' } };
  });
  const c = captureIo(repo.dir, env);
  try {
    const code = await runCli(['doctor'], c.io, { engineRoot: engine.dir, fetch: transport.fetch, probeRequest: gh.request });
    assert.equal(code, 1, c.all());
    const out = c.all();
    assert.match(out, /repositories: main \(acme\/priv\), events \(acme\/pub\); default: main/u);
    assert.match(out, /\[main\] GitHub: PAT[^\n]*repository acme\/priv, workflow agent-implement-request\.yml \(active\), ref main/u);
    assert.match(out, /\[main\] builder: ready/u, 'the healthy repository is reported healthy');
    assert.match(c.stderr(), /acme\/pub is PUBLIC, so every request filed into it would be public\./u, 'the refusal names the public one');
    assert.doesNotMatch(c.stderr(), /acme\/priv is PUBLIC/u);
    const asked = transport.requests.map((r) => new URL(r.url).pathname);
    assert.ok(asked.includes('/repos/acme/priv') && asked.includes('/repos/acme/pub'), 'both repositories were asked');
    assert.ok(asked.includes('/repos/acme/pub/commits/trunk'), "and each at its own ref");
  } finally {
    engine.cleanup();
    repo.cleanup();
  }
});
