/**
 * REFUSE TO BUILD, END TO END (RFC-001 5.4 "Workflow copy drifted from the engine's template").
 *
 * The real builder, really installed, over the REAL GitHub adapter's containment gate
 * (`verifyGates`, `readiness`, and the refuse-unless-verified `dispatch`), whose GitHub is the
 * fake seam - so the gate files are really read at a commit and really hashed.
 *
 * WHAT IS BEING PROVEN, in the RFC's words:
 *
 *  - a drifted workflow at the dispatch ref makes `/request new` fail with the sync sentence,
 *    before anything is filed;
 *  - `/status` reports `builder: down` naming the file, while `/help` still works;
 *  - drift introduced AFTER boot is caught at the next dispatch, without a restart, and the
 *    dispatch is never sent;
 *  - fixing the files brings builds back, again without a restart.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { secret } from '#core/config';
import { createEventBus } from '#core/events';
import { Ok } from '#core/result';
import { toGitRef, toWorkflowFile, type CatalogPort } from '#core/ports';
import type { View } from '#core/view';
import { renderSafeMarkdown } from '#core/text';
import { fakeClock, fakeLogger, fakeVersion } from '#testing/fakes';
import { stubFetch } from '#testing/http';
import { createGithubAdapter, type GithubAdapter } from '#adapters/github/index';
import { engineReference, fakeGithub, SHA_A, SHA_B, SHA_C, VERIFIER, WORKFLOW_PATH, type FakeGithub } from '#testing/fixtures/github-fake';
import helpModule from '#modules/help/module';

import { harness, invocation, payloadFor, requestForm, runtime, seedDispatching, submission, type Harness } from '#modules/builder/harness.test';

const DRIFT_SENTENCE = (file: string): string =>
  `Builds are disabled: ${file} in o/r does not match the engine's template (engine 1.7.0). Run npx guildwright template apply, commit, and restart.`;

/** The real adapter, booted against the fake GitHub; `dispatches` counts POSTs that reached the wire. */
async function realGate(gh: FakeGithub): Promise<{ readonly adapter: GithubAdapter; readonly dispatches: () => number }> {
  const transport = stubFetch((req) => {
    const p = new URL(req.url).pathname;
    if (p === '/repos/o/r') return { status: 200, body: { full_name: 'o/r', private: true, has_issues: true } };
    if (p.endsWith('/dispatches')) return { status: 204 };
    if (p.includes('/actions/workflows/')) return { status: 200, body: { state: 'active' } };
    return { status: 200, body: { sha: SHA_A } };
  });
  const wf = toWorkflowFile('agent-implement-request.yml');
  const ref = toGitRef('main');
  if (!wf.ok || !ref.ok) throw new Error('fixture is invalid');
  const created = await createGithubAdapter({
    auth: { kind: 'pat', token: secret(`github_pat_${'B'.repeat(40)}`) },
    repo: { owner: 'o', repo: 'r' },
    clock: fakeClock(),
    logger: fakeLogger(),
    approvalHmacKey: secret('k'.repeat(48)),
    workflowFile: wf.value,
    ref: ref.value,
    allowPublicTargetRepo: false,
    builder: { requireOwnCredentials: true },
    engineVersion: '1.7.0',
    gateReference: Ok(engineReference()),
    fetch: transport.fetch,
    probeRequest: gh.request,
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error('unreachable');
  const booted = await created.value.preflight();
  assert.ok(booted.ok, 'drift never refuses the START; it refuses builds');
  return {
    adapter: created.value,
    dispatches: () => transport.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/dispatches')).length,
  };
}

function wired(adapter: GithubAdapter): Harness {
  const b = adapter.builds;
  return harness({}, { verifyGates: b.verifyGates, readiness: b.readiness, dispatch: b.dispatch });
}

/** `/status` and `/help`, from the real help module over a catalog holding the real builder. */
async function helpCommands(h: Harness): Promise<{ readonly status: View; readonly help: { readonly kind: string } }> {
  const catalog: CatalogPort = {
    modules: () => [],
    commands: () => [],
    permissions: () => [],
    health: async () => [{ moduleId: 'builder', ...(await h.installed.health()) }],
  };
  const installed = helpModule.install({
    ports: { catalog, version: fakeVersion() },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(installed.ok);
  if (!installed.ok) throw new Error('unreachable');
  const find = (name: string) => {
    const c = installed.value.commands.find((x) => x.name === name);
    if (c === undefined) throw new Error(`help has no /${name}`);
    return c;
  };
  const status = await find('status').handle(invocation());
  const help = await find('help').handle(invocation());
  assert.equal(status.kind, 'view');
  if (status.kind !== 'view') throw new Error('unreachable');
  return { status: status.view, help };
}

function builderRow(view: View): string {
  const row = view.nodes.find((n) => n.kind === 'field' && n.name === 'builder');
  return row !== undefined && row.kind === 'field' ? renderSafeMarkdown(row.md) : '';
}

test('a drifted workflow at the dispatch ref: /request new fails with the sync sentence, NOTHING is filed', async () => {
  const gh = fakeGithub();
  gh.push(SHA_B, { [WORKFLOW_PATH]: 'name: agent\npermissions: write-all\n' });
  const { adapter } = await realGate(gh);
  const h = wired(adapter);
  try {
    const outcome = await requestForm(h).handle(submission());
    assert.equal(outcome.kind, 'fail');
    if (outcome.kind !== 'fail') return;
    assert.equal(outcome.error.kind, 'config', 'a config error: the operator fixes it, the user is told to ask');
    assert.equal(`${outcome.error.internal ?? ''} ${outcome.error.nextStep}`, DRIFT_SENTENCE(WORKFLOW_PATH));
    assert.equal(h.issues.created.length, 0, 'no issue for a build that could not run');
    assert.equal(h.discord.posted.length, 0, 'and no approval card');
  } finally {
    h.close();
  }
});

test('with the gates drifted, /status reports builder DOWN naming the file, and /help still works', async () => {
  const gh = fakeGithub();
  gh.push(SHA_B, { [VERIFIER]: 'print("approved")\n' });
  const { adapter } = await realGate(gh);
  const h = wired(adapter);
  try {
    const health = await h.installed.health();
    assert.deepEqual(health, { status: 'down', detail: DRIFT_SENTENCE(VERIFIER) });

    const before = gh.calls.length;
    const { status, help } = await helpCommands(h);
    assert.equal(status.accent, 'error');
    assert.match(builderRow(status), /down/u);
    assert.ok(builderRow(status).includes('verify_approval.py'), builderRow(status));
    assert.equal(help.kind, 'view', '/help is untouched by a builder that is down');
    assert.equal(gh.calls.length, before, '/status spent no GitHub request: health reads the last answer only');
  } finally {
    h.close();
  }
});

test('drift introduced AFTER boot is caught at the next dispatch without a restart, and nothing is dispatched', async () => {
  const gh = fakeGithub();
  const { adapter, dispatches } = await realGate(gh);
  const h = wired(adapter);
  try {
    // Clean at boot: a request is accepted and filed.
    const accepted = await requestForm(h).handle(submission());
    assert.notEqual(accepted.kind, 'fail');
    assert.equal(h.issues.created.length, 1);
    assert.equal((await h.installed.health()).status, 'ok');

    // Someone merges a change to the agent's deny list. The bot is NOT restarted.
    gh.push(SHA_B, { '.github/claude/agent-settings.json': '{"permissions":{"allow":["Bash(*)"]}}\n' });

    const id = seedDispatching(h.repo, 42);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(`${outcome.error.internal ?? ''} ${outcome.error.nextStep}`, DRIFT_SENTENCE('.github/claude/agent-settings.json'));
    assert.equal(outcome.error.retryable, false);
    assert.equal(dispatches(), 0, 'THE POINT: no workflow_dispatch reached GitHub');
    assert.equal(h.builds.signed.length, 0, 'and nothing was signed: the check runs before signApproval');
    assert.equal(h.repo.get(id)?.state, 'failed', 'finished, so the slot is released and /request retry works later');
    assert.equal((await h.installed.health()).status, 'down');

    // The fix lands; again no restart. The next request goes through.
    gh.push(SHA_C);
    const again = await requestForm(h).handle(submission());
    assert.notEqual(again.kind, 'fail');
    assert.equal((await h.installed.health()).status, 'ok');
  } finally {
    h.close();
  }
});

test('one commit read per /request new while the ref does not move; the files are not re-read', async () => {
  const gh = fakeGithub();
  const { adapter } = await realGate(gh);
  const h = wired(adapter);
  try {
    const contentsAtBoot = gh.count('contents');
    const commitsAtBoot = gh.count('commit');
    await requestForm(h).handle(submission());
    await requestForm(h).handle(submission());
    assert.equal(gh.count('commit') - commitsAtBoot, 2);
    assert.equal(gh.count('contents'), contentsAtBoot, 'cached by SHA');
  } finally {
    h.close();
  }
});

test('GitHub unreachable at the dispatch check: the build waits and retries, it is not failed', async () => {
  const gh = fakeGithub();
  const { adapter, dispatches } = await realGate(gh);
  const h = wired(adapter);
  try {
    gh.fail.set('commit', Object.assign(new Error('socket hang up'), { name: 'TypeError' }));
    const id = seedDispatching(h.repo, 42);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'retry');
    assert.equal(dispatches(), 0);
    assert.equal(h.repo.get(id)?.state, 'dispatching', 'still alive');
  } finally {
    h.close();
  }
});

test('the fake gate answer drives the same refusal (the seam every other builder test uses)', async () => {
  // `fakeBuilds().gateAnswer` is how the rest of the suite opts in; this pins that it is wired.
  const h = harness();
  try {
    h.builds.gateAnswer = { ok: false, error: { ...DRIFT_ERROR } };
    const outcome = await requestForm(h).handle(submission());
    assert.equal(outcome.kind, 'fail');
    assert.equal(h.builds.gateChecks, 1);
    assert.deepEqual(await h.installed.health(), { status: 'down', detail: DRIFT_ERROR.internal });
  } finally {
    h.close();
  }
});

const DRIFT_ERROR = {
  kind: 'config',
  code: 'config.github.gates',
  location: 'github.gates',
  userDetail: 'This command is broken on our side. Tell an admin.',
  nextStep: 'Run npx guildwright template apply, commit, and restart.',
  internal: 'Builds are disabled: x does not match.',
  retryable: false,
} as const;
