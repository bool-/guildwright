/**
 * The gate-file digest check (RFC-001 5.4, 5.5), against the fake GitHub seam. No network.
 *
 * WHAT IS BEING PROVEN:
 *
 *  1. THE REFERENCE IS THE ENGINE'S OWN BYTES, and the workflow compared is the one the bot
 *     DISPATCHES (`GITHUB_WORKFLOW_FILE`), so a renamed copy is checked rather than skipped.
 *  2. THE FILES ARE READ AT THE COMMIT THE DISPATCH WOULD RUN, by SHA, not by ref name.
 *  3. THE CACHE RE-READS ONLY WHEN THE REF'S SHA MOVES: one commit read per check otherwise.
 *  4. DRIFT AFTER THE FIRST CHECK IS CAUGHT BY THE NEXT ONE, with no restart.
 *  5. EVERY NON-MATCH IS FAIL-CLOSED, and only "GitHub could not answer" is retryable.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Ok } from '#core/result';
import { toGitRef, toWorkflowFile, type WorkflowFile } from '#core/ports';
import { enginePackageRoot } from '#adapters/system/version';
import { fakeLogger } from '#testing/fakes';
import {
  AGENT_SETTINGS_PATH,
  ENGINE_WORKFLOW_PATH,
  TEMPLATE_APPLY_COMMAND,
  VERIFIER_PATH,
  createGateCheck,
  readEngineGateFiles,
  readinessSentence,
  sha256Hex,
} from '#adapters/github/gates';
import {
  SETTINGS,
  SHA_A,
  SHA_B,
  SHA_C,
  VERIFIER,
  WORKFLOW_PATH,
  ENGINE_FILES,
  engineReference,
  fakeGithub,
  githubError,
  type FakeGithub,
} from '#testing/fixtures/github-fake';

function wf(name = 'agent-implement-request.yml'): WorkflowFile {
  const r = toWorkflowFile(name);
  if (!r.ok) throw new Error('fixture workflow is invalid');
  return r.value;
}

function check(gh: FakeGithub, reference: ReturnType<typeof readEngineGateFiles> = Ok(engineReference())) {
  const ref = toGitRef('main');
  if (!ref.ok) throw new Error('fixture ref is invalid');
  return createGateCheck({
    request: gh.request,
    repo: { owner: 'o', repo: 'r' },
    fullName: () => 'o/r',
    ref: ref.value,
    reference,
    engineVersion: '1.7.0',
    nowMs: () => 0,
    logger: fakeLogger(),
  });
}

// ---------------------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------------------

test("the reference is the engine package root's own three files, compared at the dispatched workflow path", () => {
  const root = enginePackageRoot();
  const got = readEngineGateFiles(root, wf('renamed-agent.yml'));
  assert.ok(got.ok, got.ok ? '' : readinessSentence(got.error));
  if (!got.ok) return;
  const bytes = (p: string): Buffer => readFileSync(join(root, ...p.split('/')));
  assert.deepEqual(got.value, [
    // The repository's copy is whatever GITHUB_WORKFLOW_FILE names; the engine's is always this one.
    { repoPath: '.github/workflows/renamed-agent.yml', sha256: sha256Hex(bytes(ENGINE_WORKFLOW_PATH)) },
    { repoPath: '.github/scripts/verify_approval.py', sha256: sha256Hex(bytes(VERIFIER_PATH)) },
    { repoPath: '.github/claude/agent-settings.json', sha256: sha256Hex(bytes(AGENT_SETTINGS_PATH)) },
  ]);
});

test('an engine without its own gate files disables builds rather than trusting the repository', async () => {
  const missing = readEngineGateFiles(join(enginePackageRoot(), 'no-such-dir'), wf());
  assert.ok(!missing.ok);
  if (missing.ok) return;
  assert.match(
    missing.error.internal ?? '',
    /^Builds are disabled: the engine's own copy of \.github\/workflows\/agent-implement-request\.yml is missing/u,
  );

  const gh = fakeGithub();
  const verdict = await check(gh, missing).verify();
  assert.equal(verdict.kind, 'blocked');
  assert.equal(gh.calls.length, 0, 'nothing to compare against, so nothing is asked');
});

test('the published package carries the three reference files', () => {
  // An installed engine is a `node_modules` tree; without these in `files` it would have nothing
  // to compare against and would refuse every build. PR 1.5 replaces them with MANIFEST.json.
  const pkg: { files: string[] } = JSON.parse(readFileSync(join(enginePackageRoot(), 'package.json'), 'utf8'));
  for (const p of [ENGINE_WORKFLOW_PATH, VERIFIER_PATH, AGENT_SETTINGS_PATH]) assert.ok(pkg.files.includes(p), p);
});

// ---------------------------------------------------------------------------------------
// Match, drift, and the sentence
// ---------------------------------------------------------------------------------------

test('identical files match, and they are read AT THE RESOLVED SHA, not at the ref name', async () => {
  const gh = fakeGithub();
  const verdict = await check(gh).verify();
  assert.deepEqual(verdict, { kind: 'match', sha: SHA_A });
  assert.equal(gh.calls.find((c) => c.key === 'commit')?.params['ref'], 'main');
  assert.deepEqual(
    gh.calls.filter((c) => c.key === 'contents').map((c) => [c.params['path'], c.params['ref']]),
    [
      [WORKFLOW_PATH, SHA_A],
      [VERIFIER, SHA_A],
      [SETTINGS, SHA_A],
    ],
  );
});

test('a drifted workflow produces the exact sync sentence, naming the file', async () => {
  const gh = fakeGithub();
  gh.push(SHA_B, { [WORKFLOW_PATH]: 'name: agent\npermissions: write-all\n' });
  const verdict = await check(gh).verify();
  assert.equal(verdict.kind, 'drift');
  if (verdict.kind !== 'drift') return;
  assert.equal(
    readinessSentence(verdict.error),
    `Builds are disabled: .github/workflows/agent-implement-request.yml in o/r does not match the engine's template (engine 1.7.0). Run ${TEMPLATE_APPLY_COMMAND}, commit, and restart.`,
  );
  assert.equal(verdict.error.kind, 'config');
  assert.equal(verdict.error.retryable, false, 'drift is a settled fact, not a blip');
});

test('several drifted or missing files are all named, and a missing file is drift, not an error', async () => {
  const gh = fakeGithub();
  gh.push(SHA_B, { [VERIFIER]: null, [SETTINGS]: '{"permissions":{}}\n' });
  const verdict = await check(gh).verify();
  assert.equal(verdict.kind, 'drift');
  if (verdict.kind !== 'drift') return;
  assert.deepEqual(verdict.files, [VERIFIER, SETTINGS]);
  assert.match(verdict.error.internal ?? '', /verify_approval\.py, \.github\/claude\/agent-settings\.json in o\/r do not match/u);
});

test('a single CRLF is drift: byte-identical is the property, nothing is normalised', async () => {
  const gh = fakeGithub();
  gh.push(SHA_B, { [VERIFIER]: ENGINE_FILES.verifier.replace('\n', '\r\n') });
  assert.equal((await check(gh).verify()).kind, 'drift');
});

// ---------------------------------------------------------------------------------------
// The cache, and drift after the first check
// ---------------------------------------------------------------------------------------

test("the cache re-reads the files ONLY when the ref's SHA moves", async () => {
  const gh = fakeGithub();
  const gate = check(gh);

  await gate.verify();
  assert.equal(gh.count('contents'), 3, 'first check: three Contents reads');

  await gate.verify();
  await gate.verify();
  assert.equal(gh.count('commit'), 3, 'one commit read per check');
  assert.equal(gh.count('contents'), 3, 'and NO further Contents reads while the SHA is unchanged');

  gh.push(SHA_B);
  assert.deepEqual(await gate.verify(), { kind: 'match', sha: SHA_B });
  assert.equal(gh.count('contents'), 6, 'the SHA moved, so the three files are read again');
});

test('drift merged AFTER the first check is caught by the next check, and a fix by the one after', async () => {
  const gh = fakeGithub();
  const gate = check(gh);
  assert.equal((await gate.verify()).kind, 'match');
  assert.equal(gate.last()?.kind, 'match');

  gh.push(SHA_B, { [SETTINGS]: '{"permissions":{"allow":["Bash(*)"]}}\n' });
  assert.equal((await gate.verify()).kind, 'drift', 'no restart needed: the SHA moved, so the files were re-read');
  assert.equal(gate.last()?.kind, 'drift');

  gh.push(SHA_C);
  assert.equal((await gate.verify()).kind, 'match', 'and the fix is picked up the same way');
});

test('a cached DRIFT is served from the cache too: it is a fact about that commit', async () => {
  const gh = fakeGithub();
  gh.push(SHA_B, { [VERIFIER]: 'tampered' });
  const gate = check(gh);
  await gate.verify();
  await gate.verify();
  assert.equal(gh.count('contents'), 3);
  assert.equal(gate.last()?.kind, 'drift');
});

// ---------------------------------------------------------------------------------------
// Fail-closed, and what is retryable
// ---------------------------------------------------------------------------------------

test('an unresolvable ref disables builds with the ref sentence (not a boot refusal)', async () => {
  const gh = fakeGithub();
  gh.fail.set('commit', githubError(404));
  const verdict = await check(gh).verify();
  assert.equal(verdict.kind, 'blocked');
  if (verdict.kind !== 'blocked') return;
  assert.equal(
    readinessSentence(verdict.error),
    'Builds are disabled: GitHub could not resolve GITHUB_REF "main" in o/r (HTTP 404), so the gate files a build would run cannot be checked. Set GITHUB_REF to a branch or tag that exists, and make sure the token has Contents: read (the gate-file check needs it), then restart.',
  );
  assert.equal(verdict.error.retryable, false);
});

test('a 403 on Contents names the permission', async () => {
  const gh = fakeGithub();
  gh.fail.set('contents', githubError(403));
  const verdict = await check(gh).verify();
  assert.equal(verdict.kind, 'blocked');
  assert.match(verdict.kind === 'blocked' ? (verdict.error.internal ?? '') : '', /cannot read repository contents on o\/r \(HTTP 403\)/u);
});

for (const [label, error] of [
  ['429', githubError(429, { 'retry-after': '30' })],
  ['503', githubError(503)],
  ['a rate-limit 403', githubError(403, { 'x-ratelimit-remaining': '0' })],
  ['no network', githubError(0)],
] as const) {
  test(`${label} on either read is UNVERIFIED and retryable, and is never cached`, async () => {
    for (const which of ['commit', 'contents'] as const) {
      const gh = fakeGithub();
      gh.fail.set(which, error);
      const gate = check(gh);
      const verdict = await gate.verify();
      assert.equal(verdict.kind, 'unverified', which);
      if (verdict.kind !== 'unverified') return;
      assert.equal(verdict.error.retryable, true, 'try again later; nothing about the configuration is known to be wrong');
      assert.match(verdict.error.internal ?? '', /could not be checked/u);

      gh.fail.delete(which);
      assert.equal((await gate.verify()).kind, 'match', 'GitHub is back, and the transient was not cached as a verdict');
    }
  });
}

test('a rejected credential is blocked and blames GITHUB_TOKEN', async () => {
  const gh = fakeGithub();
  gh.fail.set('commit', githubError(401));
  const verdict = await check(gh).verify();
  assert.equal(verdict.kind, 'blocked');
  assert.equal(verdict.kind === 'blocked' && verdict.error.kind === 'config' ? verdict.error.location : '', 'GITHUB_TOKEN');
});
