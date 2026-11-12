/**
 * The containment preflight (RFC-001 5.4, PR 1.7): every misconfiguration row produces its exact
 * sentence and its stated behaviour, and every new probe's transient answer warns, starts, and
 * reports the build capability `down` until a later check passes.
 *
 * Driven through `createGithubAdapter` - the real composition, the real `preflight()` - with the
 * stub transport for the client's own three reads and the fake GitHub seam for the probes, so the
 * 429/5xx/network arms cost no backoff. One test at the end drives a refusal through the real
 * client too, to pin the routes on the wire.
 */

import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { secret } from '#core/config';
import { Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { toGitRef, toWorkflowFile } from '#core/ports';
import { actionsToken, renderActionsToken } from '#core/text';
import { fakeClock, fakeLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';
import { createGithubAdapter, type GithubAdapter, type GithubAdapterInput } from '#adapters/github/index';
import { createContainment, unverifiedWarning, type ProbeId } from '#adapters/github/containment';
import { readinessSentence } from '#adapters/github/gates';
import { engineReference, fakeGithub, githubError, SHA_A, type FakeGithub, type RouteKey } from '#testing/fixtures/github-fake';

const TOKEN = `github_pat_${'C'.repeat(40)}`;
const HMAC_KEY = 'h'.repeat(48);

function branded() {
  const wf = toWorkflowFile('agent-implement-request.yml');
  const ref = toGitRef('main');
  if (!wf.ok || !ref.ok) throw new Error('fixture is invalid');
  return { workflowFile: wf.value, ref: ref.value };
}

/** The client's own three preflight reads, all healthy; `/repos/o/r` mirrors the fake's privacy. */
function clientTransport(gh: FakeGithub, fullName = 'o/r') {
  return stubFetch((req: RecordedRequest): StubResponse => {
    const p = new URL(req.url).pathname;
    if (p === '/repos/o/r') return { status: 200, body: { full_name: fullName, private: gh.state.isPrivate, has_issues: true } };
    if (p.includes('/actions/workflows/') && !p.endsWith('/dispatches')) return { status: 200, body: { state: 'active' } };
    if (p.includes('/commits/')) return { status: 200, body: { sha: SHA_A } };
    return { status: 204 };
  });
}

interface Booted {
  readonly adapter: GithubAdapter;
  readonly result: Awaited<ReturnType<GithubAdapter['preflight']>>;
  readonly transport: ReturnType<typeof stubFetch>;
}

async function boot(
  gh: FakeGithub,
  over: Partial<Pick<GithubAdapterInput, 'allowPublicTargetRepo' | 'builder'>> & { readonly fullName?: string } = {},
): Promise<Booted> {
  const transport = clientTransport(gh, over.fullName);
  const created = await createGithubAdapter({
    auth: { kind: 'pat', token: secret(TOKEN) },
    repo: { owner: 'o', repo: 'r' },
    clock: fakeClock(),
    logger: fakeLogger(),
    approvalHmacKey: secret(HMAC_KEY),
    ...branded(),
    allowPublicTargetRepo: over.allowPublicTargetRepo ?? false,
    builder: over.builder === undefined ? { requireOwnCredentials: true } : over.builder,
    engineVersion: '1.7.0',
    gateReference: Ok(engineReference()),
    fetch: transport.fetch,
    probeRequest: gh.request,
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error('unreachable');
  return { adapter: created.value, result: await created.value.preflight(), transport };
}

/** A refused boot: the exact diagnosis and the exact next step. */
function refused(b: Booted, location: string, internal: string, nextStep: string): void {
  assert.ok(!b.result.ok, 'the bot must refuse to start');
  if (b.result.ok) return;
  const e: AppError = b.result.error;
  assert.equal(e.kind, 'config');
  assert.equal(e.kind === 'config' ? e.location : '', location);
  assert.equal(e.internal, internal);
  assert.equal(e.nextStep, nextStep);
}

function started(b: Booted): readonly string[] {
  assert.ok(b.result.ok, b.result.ok ? '' : readinessSentence(b.result.error));
  return b.result.ok ? b.result.value.warnings : [];
}

// ---------------------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------------------

test('a correctly configured repository starts with builds ready and no containment warning', async () => {
  const gh = fakeGithub();
  const b = await boot(gh);
  assert.deepEqual(started(b), []);
  assert.deepEqual(b.adapter.builds.readiness(), { status: 'ready' });
  // Asked: the secret, the environments listing, and the gate files. Not ai-agent: the gate is on.
  assert.deepEqual(
    [...new Set(gh.calls.map((c) => c.key))].sort(),
    ['commit', 'contents', 'environments', 'secret'],
  );
});

// ---------------------------------------------------------------------------------------
// Refuse to start, row by row (RFC-001 5.4)
// ---------------------------------------------------------------------------------------

test('ROW: a public target repository refuses to start, naming the escape hatch', async () => {
  const gh = fakeGithub();
  gh.state.isPrivate = false;
  refused(
    await boot(gh),
    'ALLOW_PUBLIC_TARGET_REPO',
    'o/r is PUBLIC, so every request filed into it would be public.',
    'Make the repository private, or set ALLOW_PUBLIC_TARGET_REPO=true if that is what you want.',
  );
});

test('ROW: ALLOW_PUBLIC_TARGET_REPO=true starts on a public repository, and still says so', async () => {
  const gh = fakeGithub();
  gh.state.isPrivate = false;
  const b = await boot(gh, { allowPublicTargetRepo: true });
  const warnings = started(b);
  assert.ok(warnings.some((w) => /o\/r is PUBLIC and ALLOW_PUBLIC_TARGET_REPO=true/u.test(w)));
  assert.deepEqual(b.adapter.builds.readiness(), { status: 'ready' }, 'an operator decision, not a fault');
});

test('ROW: the APPROVAL_HMAC_KEY repository secret absent (404, with a readable secrets list) refuses to start', async () => {
  const gh = fakeGithub();
  gh.state.approvalSecret = false;
  refused(
    await boot(gh),
    'APPROVAL_HMAC_KEY',
    'o/r has no repository secret APPROVAL_HMAC_KEY, so every build would be rejected at the approval gate.',
    'Settings -> Secrets and variables -> Actions -> Repository secrets; set it to the same value as APPROVAL_HMAC_KEY in .env.',
  );
  assert.equal(gh.count('secrets-list'), 1, 'the listing is what tells "absent" from "cannot read"');
});

for (const [label, set] of [
  ['403 on the secret', (gh: FakeGithub) => gh.fail.set('secret', githubError(403))],
  ['404 on the secret AND on the list', (gh: FakeGithub) => (gh.fail.set('secret', githubError(404)), gh.fail.set('secrets-list', githubError(404)))],
  ['404 on the secret, 403 on the list', (gh: FakeGithub) => (gh.fail.set('secret', githubError(404)), gh.fail.set('secrets-list', githubError(403)))],
] as const) {
  test(`ROW: a PAT without Secrets: read (${label}) refuses to start naming the PERMISSION, not the secret`, async () => {
    const gh = fakeGithub();
    set(gh);
    const b = await boot(gh);
    const status = label.endsWith('403 on the list') || label.startsWith('403') ? 403 : 404;
    refused(
      b,
      'GITHUB_TOKEN',
      `the token cannot read repository secrets on o/r (HTTP ${status}), so the APPROVAL_HMAC_KEY check cannot run.`,
      'Add Secrets: read to the PAT (or to the GitHub App), then restart.',
    );
    assert.ok(!(b.result.ok ? '' : (b.result.error.internal ?? '')).includes('has no repository secret'), 'never claims the secret is missing');
  });
}

for (const status of [403, 404, 422]) {
  test(`ROW: with the gate on, GitHub refusing to list environments (HTTP ${status}) refuses to start`, async () => {
    const gh = fakeGithub();
    gh.fail.set('environments', githubError(status));
    refused(
      await boot(gh),
      'modules.builder.requireOwnCredentials',
      `GitHub refused to list environments for o/r (HTTP ${status}).`,
      'Bring-your-own-credentials needs environments: grant the App the Environments permission, or check that your GitHub plan allows environments on a private repository, or set MODULES_JSON={"builder":{"requireOwnCredentials":false}} and fund builds yourself.',
    );
  });
}

test('ROW: with requireOwnCredentials false, no ai-agent environment refuses to start', async () => {
  const gh = fakeGithub();
  gh.state.aiAgent = null;
  refused(
    await boot(gh, { builder: { requireOwnCredentials: false } }),
    'modules.builder.requireOwnCredentials',
    'requireOwnCredentials is false but o/r has no environment named ai-agent to pay from.',
    'Create it (Settings -> Environments) and add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.',
  );
});

test('ROW: with requireOwnCredentials false, an ai-agent environment holding no credential refuses to start', async () => {
  const gh = fakeGithub();
  gh.state.aiAgent = ['APPROVAL_HMAC_KEY'];
  const b = await boot(gh, { builder: { requireOwnCredentials: false } });
  assert.ok(!b.result.ok);
  assert.match(b.result.ok ? '' : (b.result.error.internal ?? ''), /holds neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN/u);
});

test('with requireOwnCredentials false and a funded ai-agent, the bot starts and never asks for the environments listing', async () => {
  const gh = fakeGithub();
  gh.state.aiAgent = ['CLAUDE_CODE_OAUTH_TOKEN'];
  const b = await boot(gh, { builder: { requireOwnCredentials: false } });
  assert.deepEqual(started(b), []);
  assert.equal(gh.count('environments'), 0);
  assert.equal(gh.count('ai-agent-secrets'), 1);
});

test('with requireOwnCredentials false and environments unreadable, the bot starts and builds stay ON (unchanged payer behaviour)', async () => {
  // `resolveBuildPayer` with the gate off already dispatches to ai-agent without reading it
  // when environments are unreadable; the operator chose to pay. Warned, not refused, not down.
  const gh = fakeGithub();
  gh.fail.set('ai-agent-secrets', githubError(403));
  const b = await boot(gh, { builder: { requireOwnCredentials: false } });
  assert.ok(started(b).some((w) => /could not read the ai-agent environment on o\/r \(HTTP 403\)/u.test(w)));
  assert.deepEqual(b.adapter.builds.readiness(), { status: 'ready' });
});

test('without the builder, only visibility is probed: nothing builds, so nothing on the build path is asked', async () => {
  const gh = fakeGithub();
  gh.state.approvalSecret = false;
  const b = await boot(gh, { builder: null });
  assert.deepEqual(started(b), []);
  assert.equal(gh.calls.length, 0, 'visibility came from the preflight read; no probe request at all');
});

// ---------------------------------------------------------------------------------------
// Refuse to BUILD: the gate files at boot are never a boot refusal
// ---------------------------------------------------------------------------------------

test('ROW: a drifted gate file at boot STARTS the bot, warns with the sync sentence, and reports builds down', async () => {
  const gh = fakeGithub();
  gh.push('d'.repeat(40), { '.github/scripts/verify_approval.py': 'print("trust me")\n' });
  const b = await boot(gh);
  const warnings = started(b);
  const sentence =
    "Builds are disabled: .github/scripts/verify_approval.py in o/r does not match the engine's template (engine 1.7.0). Run npx guildwright template apply, commit, and restart.";
  assert.ok(warnings.includes(sentence), 'stderr and the log at boot');
  assert.deepEqual(b.adapter.builds.readiness(), { status: 'down', detail: sentence });

  // And the backstop: a dispatch is refused with no request sent.
  const before = b.transport.requests.length;
  const out = await b.adapter.builds.dispatch({ inputs: {}, runName: actionsToken.bareHandle('agent-x') });
  assert.ok(!out.ok);
  assert.equal(out.ok ? '' : out.error.kind, 'config');
  assert.equal(b.transport.requests.length, before, 'nothing reached GitHub');
});

test('ROW: an unresolvable GITHUB_REF at boot is builds-down with the ref sentence, not refuse-to-start', async () => {
  const gh = fakeGithub();
  gh.fail.set('commit', githubError(404));
  const b = await boot(gh);
  started(b);
  const ready = b.adapter.builds.readiness();
  assert.equal(ready.status, 'down');
  assert.match(ready.status === 'down' ? ready.detail : '', /could not resolve GITHUB_REF "main" in o\/r/u);
});

// ---------------------------------------------------------------------------------------
// The transient posture, for EVERY new probe
// ---------------------------------------------------------------------------------------

const TRANSIENTS = [
  ['429', () => githubError(429, { 'retry-after': '5' })],
  ['503', () => githubError(503)],
  ['no network', () => githubError(0)],
] as const;

const PROBES: readonly { readonly id: ProbeId; readonly route: RouteKey; readonly gateOn: boolean; readonly prepare?: (gh: FakeGithub) => void }[] = [
  { id: 'approval-secret', route: 'secret', gateOn: true },
  // The secrets LIST is only asked after a 404 on the secret; its transient is the probe's too.
  { id: 'approval-secret', route: 'secrets-list', gateOn: true, prepare: (gh) => gh.fail.set('secret', githubError(404)) },
  { id: 'environments', route: 'environments', gateOn: true },
  { id: 'shared-environment', route: 'ai-agent-secrets', gateOn: false },
];

for (const [label, make] of TRANSIENTS) {
  for (const probe of PROBES) {
    test(`TRANSIENT: ${label} on ${probe.route} warns, starts, reports builds down, and recovers without a restart`, async () => {
      const gh = fakeGithub();
      probe.prepare?.(gh);
      gh.fail.set(probe.route, make());
      const b = await boot(gh, { builder: { requireOwnCredentials: probe.gateOn } });

      const warnings = started(b);
      const status = label === '429' ? 429 : label === '503' ? 503 : 0;
      assert.ok(warnings.includes(unverifiedWarning(probe.id, 'o/r', status)), warnings.join('\n'));
      const ready = b.adapter.builds.readiness();
      assert.equal(ready.status, 'down', 'the capability is down until the check passes');

      // Still failing: refused, but RETRYABLE - nothing about the configuration is known wrong.
      const still = await b.adapter.builds.verifyGates();
      assert.ok(!still.ok);
      assert.equal(still.ok ? null : still.error.retryable, true);

      // GitHub recovers: the next check re-runs the probe and builds come back. No restart.
      gh.fail.clear();
      const again = await b.adapter.builds.verifyGates();
      assert.ok(again.ok, again.ok ? '' : readinessSentence(again.error));
      assert.deepEqual(b.adapter.builds.readiness(), { status: 'ready' });
    });
  }

  test(`TRANSIENT: ${label} on the repository read leaves visibility unverified (down), re-checked later`, async () => {
    const gh = fakeGithub();
    const containment = createContainment({
      request: gh.request,
      repo: { owner: 'o', repo: 'r' },
      fullName: () => 'o/r',
      authKind: 'pat',
      allowPublicTargetRepo: false,
      builder: null,
      nowMs: () => 0,
      logger: fakeLogger(),
    });
    // `null`: the preflight's own repository read was the transient one.
    const booted = await containment.boot(null);
    assert.ok(booted.ok);
    assert.equal(booted.ok ? booted.value.length : 0, 1);
    assert.notEqual(containment.downDetail(), null);

    gh.fail.set('repo', make());
    const still = await containment.recheck();
    assert.equal(still.ok ? null : still.error.retryable, true);

    gh.fail.clear();
    assert.ok((await containment.recheck()).ok);
    assert.equal(containment.downDetail(), null);

    // And a re-run that finds the repository PUBLIC refuses builds (it cannot refuse the start
    // any more), with the same sentence.
    gh.state.isPrivate = false;
    const fresh = createContainment({
      request: gh.request,
      repo: { owner: 'o', repo: 'r' },
      fullName: () => 'o/r',
      authKind: 'pat',
      allowPublicTargetRepo: false,
      builder: null,
      nowMs: () => 0,
      logger: fakeLogger(),
    });
    await fresh.boot(null);
    const now = await fresh.recheck();
    assert.ok(!now.ok);
    assert.equal(now.ok ? '' : now.error.internal, 'o/r is PUBLIC, so every request filed into it would be public.');
    assert.equal(now.ok ? null : now.error.retryable, false);
  });
}

test('APP MODE: a 403/404 on a secrets read is NOT evidence (the installation check verified Secrets: read)', async () => {
  for (const set of [
    (gh: FakeGithub) => gh.fail.set('secret', githubError(403)),
    (gh: FakeGithub) => (gh.fail.set('secret', githubError(404)), gh.fail.set('secrets-list', githubError(404))),
  ]) {
    const gh = fakeGithub();
    set(gh);
    const containment = createContainment({
      request: gh.request,
      repo: { owner: 'o', repo: 'r' },
      fullName: () => 'o/r',
      authKind: 'app',
      allowPublicTargetRepo: false,
      builder: { requireOwnCredentials: true },
      nowMs: () => 0,
      logger: fakeLogger(),
    });
    const booted = await containment.boot({ isPrivate: true });
    assert.ok(booted.ok, 'starts');
    assert.match(containment.downDetail() ?? '', /APPROVAL_HMAC_KEY repository secret on o\/r has not been verified/u);
  }
});

test('a rate-limit 403 is a transient in PAT mode too, not a missing permission', async () => {
  const gh = fakeGithub();
  gh.fail.set('secret', githubError(403, { 'x-ratelimit-remaining': '0' }));
  const b = await boot(gh);
  started(b);
  assert.equal(b.adapter.builds.readiness().status, 'down');
});

// ---------------------------------------------------------------------------------------
// `repository` from full_name, and the wire
// ---------------------------------------------------------------------------------------

test('a mis-cased .env starts with a notice, and approvals are signed with GitHub\'s spelling', async () => {
  const gh = fakeGithub();
  const b = await boot(gh, { fullName: 'O/R' });
  assert.ok(started(b).some((w) => /GITHUB_OWNER\/GITHUB_REPO is spelled o\/r but GitHub spells it O\/R/u.test(w)));

  const sign = {
    requestId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
    approvalId: '00000000-0000-4000-8000-000000000000',
    issueNumber: 7,
    bodySha256: 'f'.repeat(64),
    environmentName: 'user-111111111111111111',
    issuedAtSec: 1_700_000_000,
  };
  const token = b.adapter.builds.signApproval(sign);
  const expected = createHmac('sha256', HMAC_KEY)
    .update(['v2', sign.requestId, sign.approvalId, '7', sign.bodySha256, sign.environmentName, '1700000000', 'O/R'].join('.'), 'utf8')
    .digest('hex');
  assert.equal(renderActionsToken(token), expected, "the tuple ends in GitHub's full_name, not the .env pair");
});

test('the wire: a refusal through the REAL client asks exactly the documented routes', async () => {
  // No probe seam: the probes run through the bot's own octokit, so the route strings and the
  // two-404 disambiguation are what GitHub would actually be asked.
  const transport = stubFetch((req) => {
    const p = new URL(req.url).pathname;
    if (p === '/repos/o/r') return { status: 200, body: { full_name: 'o/r', private: true } };
    if (p.startsWith('/repos/o/r/actions/workflows/')) return { status: 200, body: { state: 'active' } };
    if (p === '/repos/o/r/actions/secrets/APPROVAL_HMAC_KEY') return { status: 404, body: { message: 'Not Found' } };
    if (p === '/repos/o/r/actions/secrets') return { status: 200, body: { total_count: 0, secrets: [] } };
    return { status: 200, body: { sha: SHA_A } };
  });
  const created = await createGithubAdapter({
    auth: { kind: 'pat', token: secret(TOKEN) },
    repo: { owner: 'o', repo: 'r' },
    clock: fakeClock(),
    logger: fakeLogger(),
    approvalHmacKey: secret(HMAC_KEY),
    ...branded(),
    allowPublicTargetRepo: false,
    builder: { requireOwnCredentials: true },
    engineVersion: '1.7.0',
    gateReference: Ok(engineReference()),
    fetch: transport.fetch,
  });
  assert.ok(created.ok);
  if (!created.ok) return;
  const result = await created.value.preflight();
  assert.ok(!result.ok);
  assert.match(result.ok ? '' : (result.error.internal ?? ''), /has no repository secret APPROVAL_HMAC_KEY/u);
  const paths = transport.requests.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`);
  assert.ok(paths.includes('GET /repos/o/r/actions/secrets/APPROVAL_HMAC_KEY'));
  assert.ok(paths.includes('GET /repos/o/r/actions/secrets?per_page=1'));
  assert.ok(transport.requests.every((r) => r.method === 'GET'), 'the preflight only ever reads');
});
