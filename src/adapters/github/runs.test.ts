/**
 * Run correlation, run status and PR discovery.
 *
 * These are the three decisions that decide whether the product's payoff message ever arrives,
 * and all three are pure functions over fixtures here - no network, no clock, no octokit.
 *
 * The two failures being defended against are both silent:
 *  - `bot/issue-1` adopting `bot/issue-19`'s pull request, because a prefix match looked fine;
 *  - a `completed` run whose `conclusion` has not landed yet being reported as a FAILURE,
 *    which tells a user their build broke about two seconds before the PR link appears.
 */

import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  createGithubBuilds,
  createdSinceFilter,
  headFilter,
  matchPrForBranch,
  matchRunByName,
  parseRunReport,
  toBuildCredentials,
  toRunStatus,
  type PullSummary,
  type RunSummary,
} from '#adapters/github/runs';
import { toRepositoryVariable } from '#core/ports';
import { createGithubClient } from '#adapters/github/client';
import { operatorMessage, userMessage } from '#core/errors';
import { toGitRef, toWorkflowFile } from '#core/ports';
import { SHARED_BUILD_ENVIRONMENT, actionsToken, buildEnvironmentName, parseHttpsUrl, renderActionsToken } from '#core/text';
import { secret } from '#core/config';
import { fakeClock, fakeLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';

const TOKEN = `ghp_${'C'.repeat(36)}`;
const NOW = 1_700_000_000_000;
/** At least 32 bytes, matching what the workflow's gate insists on. */
const APPROVAL_KEY = 'test-approval-key-0123456789abcdef-0123456789';

function run(over: Partial<RunSummary> & { readonly id: number }): RunSummary {
  return {
    name: '',
    htmlUrl: `https://github.com/o/r/actions/runs/${over.id}`,
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    createdAtMs: NOW,
    ...over,
  };
}

function pull(over: Partial<PullSummary> & { readonly number: number }): PullSummary {
  return {
    htmlUrl: `https://github.com/o/r/pull/${over.number}`,
    headRef: 'agent/req-1',
    state: 'open',
    createdAtMs: NOW,
    // The ordinary case. A draft is the agent saying it did NOT finish, so the fixture that
    // stays silent about it has to be the finished one.
    isDraft: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------------------

/** The run link every arm now carries. `parseHttpsUrl` is the only door to an `HttpsUrl`. */
const RUN_URL = (() => {
  const parsed = parseHttpsUrl('https://github.com/o/r/actions/runs/5');
  if (!parsed.ok) throw new Error('fixture run url is invalid');
  return parsed.value;
})();

test('every non-terminal GitHub status maps to a non-terminal RunStatus', () => {
  for (const status of ['queued', 'requested', 'waiting', 'pending', 'action_required']) {
    assert.deepEqual(toRunStatus({ status, conclusion: null, runUrl: null }), { kind: 'queued', runUrl: null }, status);
  }
  assert.deepEqual(toRunStatus({ status: 'in_progress', conclusion: null, runUrl: null }), {
    kind: 'in-progress',
    runUrl: null,
  });
});

test('a completed run with no conclusion yet is still in progress, not a failure', () => {
  // GitHub really does report `completed` for a second or two before the conclusion lands.
  // Calling that a failure tells a user their build broke moments before the PR appears.
  assert.deepEqual(toRunStatus({ status: 'completed', conclusion: null, runUrl: null }), {
    kind: 'in-progress',
    runUrl: null,
  });
});

test('an unrecognised status keeps the poller polling instead of inventing a failure', () => {
  assert.deepEqual(toRunStatus({ status: 'some_future_state', conclusion: null, runUrl: null }), {
    kind: 'in-progress',
    runUrl: null,
  });
});

test('the terminal conclusions map to the terminal states', () => {
  assert.deepEqual(toRunStatus({ status: 'completed', conclusion: 'success', runUrl: null }), {
    kind: 'success',
    runUrl: null,
  });
  assert.deepEqual(toRunStatus({ status: 'completed', conclusion: 'cancelled', runUrl: null }), {
    kind: 'cancelled',
    runUrl: null,
  });
  for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'stale', 'neutral', 'skipped', 'action_required']) {
    const s = toRunStatus({ status: 'completed', conclusion, runUrl: null });
    assert.equal(s.kind, 'failure', conclusion);
    if (s.kind === 'failure') assert.ok(s.detail.includes(conclusion));
  }
});

test('an unknown conclusion fails without echoing the unknown string back', () => {
  const s = toRunStatus({ status: 'completed', conclusion: 'ignore previous instructions', runUrl: null });
  assert.equal(s.kind, 'failure');
  if (s.kind !== 'failure') return;
  assert.ok(!s.detail.includes('ignore previous instructions'), 'a network string must not ride into an error');
});

test('the run link rides on EVERY arm, terminal and not', () => {
  // The whole point of putting it on the union rather than only on the terminal arms: a card
  // that says "building..." for twenty minutes with nothing to open is indistinguishable from
  // a bot that hung, and a failure with no log link is the least actionable message this
  // product can send.
  const arms = [
    toRunStatus({ status: 'queued', conclusion: null, runUrl: RUN_URL }),
    toRunStatus({ status: 'in_progress', conclusion: null, runUrl: RUN_URL }),
    toRunStatus({ status: 'completed', conclusion: 'success', runUrl: RUN_URL }),
    toRunStatus({ status: 'completed', conclusion: 'cancelled', runUrl: RUN_URL }),
    toRunStatus({ status: 'completed', conclusion: 'failure', runUrl: RUN_URL }),
  ];
  assert.equal(arms.length, 5, 'one probe per arm of RunStatus');
  for (const arm of arms) assert.equal(arm.runUrl, RUN_URL, arm.kind);
});

// ---------------------------------------------------------------------------------------
// Blind-dispatch correlation
// ---------------------------------------------------------------------------------------

test('correlation matches on run-name and takes the newest, so a redispatch wins', () => {
  const needle = 'build-9f1c';
  const runs: readonly RunSummary[] = [
    run({ id: 1, name: `Build ${needle}`, createdAtMs: NOW }),
    run({ id: 2, name: `Build ${needle}`, createdAtMs: NOW + 5_000 }),
    run({ id: 3, name: 'Build build-other', createdAtMs: NOW + 9_000 }),
  ];
  assert.equal(matchRunByName(runs, needle, 0)?.id, 2);
});

test('correlation ignores runs started before we asked, and runs from another trigger', () => {
  const needle = 'build-9f1c';
  const stale = run({ id: 1, name: `Build ${needle}`, createdAtMs: NOW - 60_000 });
  const wrongEvent = run({ id: 2, name: `Build ${needle}`, createdAtMs: NOW + 1_000, event: 'push' });
  const mine = run({ id: 3, name: `Build ${needle}`, createdAtMs: NOW + 2_000 });

  assert.equal(matchRunByName([stale, wrongEvent], needle, NOW), null, 'nothing eligible');
  assert.equal(matchRunByName([stale, wrongEvent, mine], needle, NOW)?.id, 3);
  assert.equal(matchRunByName([], needle, 0), null);
});

test('same-millisecond runs break the tie deterministically, on the higher id', () => {
  const needle = 'build-9f1c';
  const a = run({ id: 10, name: needle, createdAtMs: NOW });
  const b = run({ id: 11, name: needle, createdAtMs: NOW });
  assert.equal(matchRunByName([a, b], needle, 0)?.id, 11);
  assert.equal(matchRunByName([b, a], needle, 0)?.id, 11, 'and does not depend on page order');
});

test('createdSinceFilter is the >=ISO form GitHub expects, and clamps nonsense', () => {
  assert.equal(createdSinceFilter(NOW), `>=${new Date(NOW).toISOString()}`);
  assert.equal(createdSinceFilter(0), '>=1970-01-01T00:00:00.000Z');
  assert.equal(createdSinceFilter(-1), '>=1970-01-01T00:00:00.000Z');
  assert.equal(createdSinceFilter(Number.NaN), '>=1970-01-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------------------
// PR discovery
// ---------------------------------------------------------------------------------------

test('branch matching is exact, so issue-1 cannot adopt issue-19', () => {
  const prs = [pull({ number: 19, headRef: 'bot/issue-19' }), pull({ number: 1, headRef: 'bot/issue-1' })];
  assert.equal(matchPrForBranch(prs, 'bot/issue-1')?.number, 1);
  assert.equal(matchPrForBranch(prs, 'bot/issue-19')?.number, 19);
  assert.equal(matchPrForBranch(prs, 'bot/issue-'), null, 'a prefix is not a match');
  assert.equal(matchPrForBranch(prs, 'bot/issue-2'), null);
});

test('an open pull request beats a closed one on a reused branch', () => {
  const branch = 'agent/req-01J8Z';
  const prs = [
    pull({ number: 7, headRef: branch, state: 'closed' }),
    pull({ number: 4, headRef: branch, state: 'open' }),
    pull({ number: 2, headRef: branch, state: 'closed' }),
  ];
  assert.equal(matchPrForBranch(prs, branch)?.number, 4, 'the live one, even though it is not the newest');
});

test('among equals the newest number wins', () => {
  const branch = 'agent/req-01J8Z';
  const prs = [pull({ number: 4, headRef: branch }), pull({ number: 9, headRef: branch })];
  assert.equal(matchPrForBranch(prs, branch)?.number, 9);
});

test('headFilter is the owner:branch form the pulls endpoint expects', () => {
  assert.equal(headFilter('bool-', 'agent/req-01J8Z'), 'bool-:agent/req-01J8Z');
});

// ---------------------------------------------------------------------------------------
// Wire level: the real adapter over an injected transport. No live API.
// ---------------------------------------------------------------------------------------

function buildsAdapter(responder: (req: RecordedRequest, i: number) => StubResponse) {
  const stub = stubFetch(responder);
  const octokit = createGithubClient({ token: secret(TOKEN), logger: fakeLogger(), fetch: stub.fetch });
  const port = createGithubBuilds({
    octokit,
    repo: { owner: 'o', repo: 'r' },
    clock: fakeClock(NOW),
    logger: fakeLogger(),
    approvalHmacKey: secret(APPROVAL_KEY),
  });
  return { port, stub };
}

function workflowFile() {
  const wf = toWorkflowFile('claude-build.yml');
  if (!wf.ok) throw new Error('fixture workflow file is invalid');
  return wf.value;
}

function gitRef() {
  const ref = toGitRef('main');
  if (!ref.ok) throw new Error('fixture ref is invalid');
  return ref.value;
}

test('a 200 dispatch is adopted immediately; a 204 forces the blind arm', async () => {
  const runName = actionsToken.bareHandle('build-01J8ZQ');
  const dispatchInput = {
    workflowFile: workflowFile(),
    ref: gitRef(),
    inputs: { issue_number: 42, dry_run: false, branch: actionsToken.botBranch(42) },
    runName,
  };

  const adopted = buildsAdapter(() => ({
    status: 200,
    body: {
      workflow_run_id: 33592845695,
      run_url: 'https://api.github.com/repos/o/r/actions/runs/33592845695',
      html_url: 'https://github.com/o/r/actions/runs/33592845695',
    },
  }));
  const a = await adopted.port.dispatch(dispatchInput);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.value.kind, 'adopted');
  if (a.value.kind !== 'adopted') return;
  assert.equal(a.value.run.runId, 33592845695);
  // The request really did ask for run details; that is what makes the 200 arm reachable.
  assert.ok((adopted.stub.requests[0]?.body ?? '').includes('"return_run_details":true'));
  // Numbers and booleans go over the wire as strings; GitHub answers 422 to anything else.
  assert.ok((adopted.stub.requests[0]?.body ?? '').includes('"issue_number":"42"'));
  assert.ok((adopted.stub.requests[0]?.body ?? '').includes('"dry_run":"false"'));

  const blind = buildsAdapter(() => ({ status: 204 }));
  const b = await blind.port.dispatch(dispatchInput);
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.value.kind, 'blind', 'a 204 must force the caller to correlate by run-name');
});

test('a dispatch that throws becomes an AppError rather than an unhandled rejection', async () => {
  const { port } = buildsAdapter(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await port.dispatch({
    workflowFile: workflowFile(),
    ref: gitRef(),
    inputs: {},
    runName: actionsToken.bareHandle('build-01J8ZQ'),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(operatorMessage(r.error).includes('GITHUB_TOKEN'), '404 on a private repo is a token-scope story');
});

test('findRunByName asks for dispatch-triggered runs since the given time', async () => {
  const { port, stub } = buildsAdapter(() => ({
    status: 200,
    body: {
      workflow_runs: [
        {
          id: 5,
          name: 'Build build-01J8ZQ',
          html_url: 'https://github.com/o/r/actions/runs/5',
          status: 'in_progress',
          conclusion: null,
          event: 'workflow_dispatch',
          created_at: new Date(NOW + 1000).toISOString(),
        },
      ],
    },
  }));
  const r = await port.findRunByName(actionsToken.bareHandle('build-01J8ZQ'), NOW);
  assert.equal(r.ok, true);
  if (!r.ok || r.value === null) return assert.fail('the run should have been correlated');
  assert.equal(r.value.runId, 5);
  assert.equal(r.value.runUrl, 'https://github.com/o/r/actions/runs/5');

  const url = new URL(stub.requests[0]?.url ?? 'https://example.invalid');
  assert.equal(url.searchParams.get('event'), 'workflow_dispatch');
  assert.equal(url.searchParams.get('created'), createdSinceFilter(NOW));
});

test('runStatus maps a live-shaped payload', async () => {
  const { port } = buildsAdapter(() => ({
    status: 200,
    body: {
      id: 5,
      name: 'Build',
      html_url: 'https://github.com/o/r/actions/runs/5',
      status: 'completed',
      conclusion: 'failure',
      event: 'workflow_dispatch',
      created_at: new Date(NOW).toISOString(),
    },
  }));
  const r = await port.runStatus(5);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.kind, 'failure');
  // THE REGRESSION THIS PINS. `html_url` was parsed into `RunSummary` and then dropped, so the
  // poller reported "your build failed" while holding — and discarding — the only link that
  // says why.
  assert.equal(r.value.runUrl, 'https://github.com/o/r/actions/runs/5', 'the run link must survive the poll');
});

test('a run whose html_url is not an https URL degrades to no link, not to an error', async () => {
  // A link is an ADDITION to the answer. The run really did finish; refusing to report that
  // because the URL looked odd would trade the whole message for the garnish. And the value is
  // a string off the network that a card turns into a link button, so it must go through
  // `parseHttpsUrl` rather than straight into the view.
  const { port } = buildsAdapter(() => ({
    status: 200,
    body: {
      id: 5,
      name: 'Build',
      // `z.url()` accepts this, and `parseHttpsUrl` must not.
      html_url: 'http://github.com/o/r/actions/runs/5',
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      created_at: new Date(NOW).toISOString(),
    },
  }));
  const r = await port.runStatus(5);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.kind, 'success', 'the outcome still arrives');
  assert.equal(r.value.runUrl, null, 'but an http:// URL never becomes a link button');
});

test('findPrForBranch falls back to an unfiltered scan when the head filter misses', async () => {
  const branch = 'agent/req-01J8ZQ';
  const { port, stub } = buildsAdapter((req) => {
    const url = new URL(req.url);
    // Pass 1 uses `head=owner:branch`; model the case where GitHub returns nothing for it.
    if (url.searchParams.get('head') !== null) return { status: 200, body: [] };
    return {
      status: 200,
      body: [
        { number: 3, html_url: 'https://github.com/o/r/pull/3', state: 'open', created_at: new Date(NOW).toISOString(), head: { ref: 'other' } },
        { number: 8, html_url: 'https://github.com/o/r/pull/8', state: 'open', created_at: new Date(NOW).toISOString(), head: { ref: branch } },
      ],
    };
  });

  const r = await port.findPrForBranch(branch);
  assert.equal(r.ok, true);
  if (!r.ok || r.value === null) return assert.fail('the fallback scan should have found the PR');
  assert.equal(r.value.number, 8);
  assert.equal(r.value.url, 'https://github.com/o/r/pull/8');
  assert.equal(r.value.branch, branch);
  assert.equal(stub.requests.length, 2, 'exactly one extra read, and only when the first missed');
});

test('the draft flag survives the wire, so an unfinished build is not reported as finished', async () => {
  // THE ENDING THIS EXISTS FOR. The composed prompt tells the agent that if it cannot finish it
  // should "still commit, push, and open the PR with --draft". Without `draft` on the payload
  // the builder saw an ordinary pull request and told the requester "Pull request opened" —
  // the one wrong answer of the three, because it invites a merge of work the agent itself
  // said was incomplete.
  const branch = 'agent/req-01J8ZQ';
  const body = (draft: unknown) => [
    {
      number: 8,
      html_url: 'https://github.com/o/r/pull/8',
      state: 'open',
      created_at: new Date(NOW).toISOString(),
      head: { ref: branch },
      ...(draft === undefined ? {} : { draft }),
    },
  ];

  for (const [sent, expected] of [
    [true, true],
    [false, false],
    // A payload that omits the field degrades to "finished", never to "draft": the draft card
    // tells a reviewer NOT to merge, so under-claiming is the safe direction.
    [undefined, false],
  ] as const) {
    const { port } = buildsAdapter(() => ({ status: 200, body: body(sent) }));
    const r = await port.findPrForBranch(branch);
    assert.equal(r.ok, true);
    if (!r.ok || r.value === null) return assert.fail(`draft=${String(sent)} should still find the PR`);
    assert.equal(r.value.isDraft, expected, `draft=${String(sent)}`);
    // And the link still arrives either way — the flag is an addition, never a gate.
    assert.equal(r.value.url, 'https://github.com/o/r/pull/8');
  }
});

test('findPrForBranch returns null - not an error - while the PR is not open yet', async () => {
  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));
  const r = await port.findPrForBranch('agent/req-01J8ZQ');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, null, 'the poller must be able to retry rather than declare failure');
});

// ---------------------------------------------------------------------------------------
// The approval MAC, and the thing that actually matters about it: that the TypeScript signer
// and the Python verifier agree. They are two implementations of one wire format, in two
// languages, in two repositories' worth of tooling. A disagreement does not fail at boot - it
// fails on every dispatch, at the exact moment a human is watching an approval card.
// ---------------------------------------------------------------------------------------

/** The v2 tuple, complete. Tests vary one field at a time off this. */
const SIGN_BASE = {
  requestId: '01JBXR4T9K2M8N7P6Q5R4S3T2V',
  approvalId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  issueNumber: 42,
  bodySha256: 'a'.repeat(64),
  environmentName: SHARED_BUILD_ENVIRONMENT,
  issuedAtSec: 1_700_000_000,
};

test('signApproval is deterministic and shaped like the workflow expects', () => {
  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));

  const a = renderActionsToken(port.signApproval(SIGN_BASE));
  const b = renderActionsToken(port.signApproval(SIGN_BASE));

  assert.equal(a, b, 'signing must be deterministic or a retry would be rejected');
  assert.match(a, /^[0-9a-f]{64}$/u, 'the workflow validates 64 lowercase hex characters');
});

test('a different issue body produces a different token, which is the whole binding', () => {
  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));

  const approved = renderActionsToken(port.signApproval({ ...SIGN_BASE, bodySha256: 'a'.repeat(64) }));
  const rewritten = renderActionsToken(port.signApproval({ ...SIGN_BASE, bodySha256: 'b'.repeat(64) }));

  assert.notEqual(approved, rewritten, 'editing the issue after approval must invalidate the token');
});

test('a different APPROVAL ID or ISSUE TIME produces a different token, which is the replay binding', () => {
  // THE ATTACK THIS CLOSES. The token is printed in plaintext in the run log, so it could be
  // copied out of a finished run and dispatched again as-is until the daily cap stopped it. The
  // workflow consumes each approval id once and bounds the age of `approval_issued_at`, but
  // both are inputs an attacker can type - so they only mean anything because they are signed.
  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));
  const sign = (over: Partial<typeof SIGN_BASE>): string => renderActionsToken(port.signApproval({ ...SIGN_BASE, ...over }));

  const original = sign({});
  assert.notEqual(sign({ approvalId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }), original, 'a fresh approval id must be a fresh token');
  assert.notEqual(sign({ issuedAtSec: SIGN_BASE.issuedAtSec + 1 }), original, 'a re-stamped issue time must be a fresh token');
});

test('the token signs the repository as GitHub spells it, read at signing time', () => {
  // Phase two of RFC-001 lets one key serve several repositories; the repository in the tuple
  // is what stops a token minted for one being honoured by another. It is read through a
  // function because the authoritative spelling arrives from the preflight AFTER the port is
  // built, and `$GITHUB_REPOSITORY` on the runner carries GitHub's case, not .env's.
  const stub = stubFetch(() => ({ status: 200, body: [] }));
  const octokit = createGithubClient({ token: secret(TOKEN), logger: fakeLogger(), fetch: stub.fetch });
  const spelling = { current: 'O/R' };
  const port = createGithubBuilds({
    octokit,
    repo: { owner: 'O', repo: 'R' },
    clock: fakeClock(NOW),
    logger: fakeLogger(),
    approvalHmacKey: secret(APPROVAL_KEY),
    repositoryName: () => spelling.current,
  });

  const configured = renderActionsToken(port.signApproval(SIGN_BASE));
  spelling.current = 'o/r';
  const asGithubSpellsIt = renderActionsToken(port.signApproval(SIGN_BASE));
  const { port: lowercase } = buildsAdapter(() => ({ status: 200, body: [] }));

  assert.notEqual(configured, asGithubSpellsIt, 'the repository name is in the tuple');
  assert.equal(asGithubSpellsIt, renderActionsToken(lowercase.signApproval(SIGN_BASE)), 'and the default is owner/repo from the bound pair');
});

test('signApproval refuses an issue time that is not whole seconds', () => {
  // The verifier does `int()` on the wire value and the shell digit-checks it first; a float or
  // a millisecond value signed here would verify against nothing. Throwing is right: this is a
  // caller bug, not a runtime condition.
  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));
  assert.throws(() => port.signApproval({ ...SIGN_BASE, issuedAtSec: 1_700_000_000.5 }), TypeError);
  assert.throws(() => port.signApproval({ ...SIGN_BASE, issuedAtSec: -1 }), TypeError);
});

test('a different ENVIRONMENT produces a different token, which is the billing binding', () => {
  // THE ATTACK THIS CLOSES. `environment_name` is a non-secret dispatch input, so it is printed
  // in the run title, in the REST API and in the job log; anyone with repo write can read a
  // valid approval token off a real run and dispatch it again. Without this binding they could
  // re-point that approved request at another user's environment and spend that person's
  // Anthropic credits, and the workflow's gate would happily verify it.
  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));
  const sign = (environmentName: string): string =>
    renderActionsToken(port.signApproval({ ...SIGN_BASE, environmentName }));

  const mine = sign(buildEnvironmentName('111111111111111111'));
  const theirs = sign(buildEnvironmentName('222222222222222222'));
  const shared = sign(SHARED_BUILD_ENVIRONMENT);

  assert.notEqual(mine, theirs, 'redirecting the bill to another user must invalidate the token');
  assert.notEqual(mine, shared, 'and falling back to the operator must too');
});

// ---------------------------------------------------------------------------------------
// Which environment can actually pay
// ---------------------------------------------------------------------------------------

test('only the two paying secrets count, so an environment with just APPROVAL_HMAC_KEY is empty', () => {
  // The exact fresh-install state: `ai-agent` holds the MAC key and nothing else. Counting "has
  // any secrets" would report that environment as able to fund builds, which is the one answer
  // that makes this whole check pointless.
  assert.deepEqual(toBuildCredentials(['APPROVAL_HMAC_KEY']), []);
  assert.deepEqual(toBuildCredentials(['APPROVAL_HMAC_KEY', 'ANTHROPIC_API_KEY']), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(toBuildCredentials(['CLAUDE_CODE_OAUTH_TOKEN']), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(toBuildCredentials([]), []);
  // Order is the allow-list's, not GitHub's, so the result is stable across pages.
  assert.deepEqual(
    toBuildCredentials(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  );
});

test('environmentCredentials reads NAMES off the environment secrets endpoint', async () => {
  const { port, stub } = buildsAdapter(() => ({
    status: 200,
    body: {
      total_count: 2,
      secrets: [
        { name: 'APPROVAL_HMAC_KEY', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ],
    },
  }));

  const r = await port.environmentCredentials('user-111111111111111111');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.exists, true);
  assert.equal(r.value.environmentName, 'user-111111111111111111');
  assert.deepEqual(r.value.credentials, ['CLAUDE_CODE_OAUTH_TOKEN']);

  const url = stub.requests[0]?.url ?? '';
  assert.ok(
    url.includes('/repos/o/r/environments/user-111111111111111111/secrets'),
    `the environment secrets endpoint must be the one called, got ${url}`,
  );
});

test('a 404 means "no environment", not an error - that is what selects the shared one', async () => {
  // As an AppError, the ordinary case (a user who never configured anything) would fail the
  // build; and "exists but empty" - which must NOT fall back - would be indistinguishable.
  const { port } = buildsAdapter(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await port.environmentCredentials('user-111111111111111111');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.exists, false);
  assert.deepEqual(r.value.credentials, []);
});

test('an environment that exists with no paying secret is NOT the same as no environment', async () => {
  const { port } = buildsAdapter(() => ({ status: 200, body: { total_count: 0, secrets: [] } }));
  const r = await port.environmentCredentials(SHARED_BUILD_ENVIRONMENT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.exists, true, 'it exists...');
  assert.deepEqual(r.value.credentials, [], '...and cannot pay for anything');
});

test('a real API failure is still an error, and never silently "no credentials"', async () => {
  // A 403 reported as `exists: false` would quietly move every build onto the operator's bill.
  const { port } = buildsAdapter(() => ({ status: 403, body: { message: 'Forbidden' } }));
  const r = await port.environmentCredentials(SHARED_BUILD_ENVIRONMENT);
  assert.equal(r.ok, false);
});

test('a 403 here names Environments — the permission that IS the problem', async () => {
  // THIS IS AN ENVIRONMENT ENDPOINT, so a fine-grained token reaches it only with the repository
  // permission named "Environments". It ran through the GENERIC translator, whose 403 sentence
  // sends the operator to check "contents, issues and actions" — the three permissions that are
  // NOT the problem. An operator following it changes three settings, gets the same 403 back, and
  // has been told nothing. It shares `mapSecretsError` with the credential writer now, so one
  // environment-shaped question has one answer wherever it is asked.
  const { port } = buildsAdapter(() => ({ status: 403, body: { message: 'Forbidden' } }));
  const r = await port.environmentCredentials(SHARED_BUILD_ENVIRONMENT);

  assert.equal(r.ok, false);
  if (r.ok) return;
  const text = operatorMessage(r.error);
  assert.ok(text.includes('Environments'), 'it must name the permission the operator has to grant');
  assert.ok(text.includes('Secrets'), 'and warn about the one they will reach for instead');
  assert.ok(
    !text.includes('contents, issues and actions'),
    'the generic sentence names the three permissions that are not the problem',
  );
  assert.equal(r.error.retryable, false, 'and it must stay non-retryable, which is what lets the payer degrade');
});

test('environmentCredentials refuses a name the bot could not have built', async () => {
  // The name becomes a REST path segment. Nothing reaches this port from user input today, and
  // this is what keeps that true if a future caller is less careful.
  const { port, stub } = buildsAdapter(() => ({ status: 200, body: { total_count: 0, secrets: [] } }));
  for (const bad of ['production', '../../ai-agent', 'user-abc', 'user-', '']) {
    const r = await port.environmentCredentials(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
  }
  assert.equal(stub.requests.length, 0, 'and refused without touching the network');
});

test('the TypeScript signer and the Python verifier agree on the wire format', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // Skip rather than fail where python3 is absent; CI (ubuntu-latest) always has it.
  let python = 'python3';
  try {
    execFileSync(python, ['--version'], { stdio: 'ignore' });
  } catch {
    try {
      python = 'python';
      execFileSync(python, ['--version'], { stdio: 'ignore' });
    } catch {
      t.skip('no python interpreter available');
      return;
    }
  }

  const body = 'As a user I want dark mode.\n\nDetails.';
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const requestId = '01JBXR4T9K2M8N7P6Q5R4S3T2V';
  const approvalId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const issueNumber = 42;
  const environmentName = buildEnvironmentName('111111111111111111');
  const issuedAtSec = 1_700_000_000;

  const { port } = buildsAdapter(() => ({ status: 200, body: [] }));
  const token = renderActionsToken(port.signApproval({ requestId, approvalId, issueNumber, bodySha256, environmentName, issuedAtSec }));

  const dir = mkdtempSync(join(tmpdir(), 'approval-'));
  const issuePath = join(dir, 'issue.json');
  writeFileSync(issuePath, JSON.stringify({ title: 'Add dark mode', body }), 'utf8');

  // The environment the workflow's verify step builds, field for field. `REPO` is what the
  // adapter signed by default (`o/r`, the bound pair); `RUN_CREATED_AT` is a run created ten
  // seconds after the token was issued.
  const env = {
    ...process.env,
    APPROVAL_HMAC_KEY: APPROVAL_KEY,
    REQUEST_ID: requestId,
    APPROVAL_ID: approvalId,
    ISSUE_NUMBER: String(issueNumber),
    APPROVAL_TOKEN: token,
    ENVIRONMENT_NAME: environmentName,
    APPROVAL_ISSUED_AT: String(issuedAtSec),
    REPO: 'o/r',
    RUN_CREATED_AT: String(issuedAtSec + 10),
    ISSUE_JSON_PATH: issuePath,
  };
  const verify = (over: Readonly<Record<string, string>>): void => {
    execFileSync(python, ['.github/scripts/verify_approval.py'], { env: { ...env, ...over }, stdio: 'pipe' });
  };

  // Accepts the token this process just produced.
  verify({});

  // ...and rejects a forged one.
  assert.throws(() => verify({ APPROVAL_TOKEN: 'f'.repeat(64) }), 'the verifier must reject a token it did not derive');

  // ...and rejects a token produced by the PREVIOUS tuple, even over the same facts. The `v2.`
  // prefix is what makes this certain rather than probable.
  const v1 = createHmac('sha256', APPROVAL_KEY)
    .update(`${requestId}.${String(issueNumber)}.${bodySha256}.${environmentName}`, 'utf8')
    .digest('hex');
  assert.throws(() => verify({ APPROVAL_TOKEN: v1 }), 'a v1-shaped token must not verify against the v2 script');

  // THE REPLAY BINDING, cross-language. Each of the three new fields must be covered by the
  // Python side in the same position with the same separator, or signing it buys nothing.
  assert.throws(() => verify({ APPROVAL_ID: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }), 'another approval id must not verify');
  assert.throws(() => verify({ APPROVAL_ISSUED_AT: String(issuedAtSec + 1) }), 'an altered issue time must not verify');
  assert.throws(() => verify({ REPO: 'o/other' }), 'a token minted for one repository must not verify in another');

  // THE AGE CHECK, against the run's creation time. 899 s is accepted at the default 900 s
  // limit; 901 s is refused and the refusal names itself as expired through GITHUB_OUTPUT.
  verify({ RUN_CREATED_AT: String(issuedAtSec + 899) });
  const outputPath = join(dir, 'github-output');
  writeFileSync(outputPath, '', 'utf8');
  assert.throws(() => verify({ RUN_CREATED_AT: String(issuedAtSec + 901), GITHUB_OUTPUT: outputPath }), 'a token older than the limit must be refused');
  assert.match(readFileSync(outputPath, 'utf8'), /^reason=expired$/mu, 'and the run report must be able to tell "too old" from "did not verify"');
  verify({ RUN_CREATED_AT: String(issuedAtSec + 1_799), APPROVAL_MAX_AGE_SECONDS: '1800' }, );
  assert.throws(() => verify({ RUN_CREATED_AT: String(issuedAtSec - 301) }), 'a token from the future beyond clock skew must be refused');
  verify({ RUN_CREATED_AT: String(issuedAtSec - 299) });

  // The age check runs only after the MAC verified: a forged token with an ancient issue time
  // must fail as a MAC failure, writing no reason. (The output file is untouched from above.)
  const before = readFileSync(outputPath, 'utf8');
  assert.throws(() => verify({ APPROVAL_TOKEN: 'f'.repeat(64), RUN_CREATED_AT: String(issuedAtSec + 100_000), GITHUB_OUTPUT: outputPath }));
  assert.equal(readFileSync(outputPath, 'utf8'), before, 'an unauthenticated dispatch learns nothing from the age branch');

  // ...and rejects the SAME token dispatched against a different environment. This is the
  // cross-language half of the billing binding: the TypeScript signer covering the environment
  // name buys nothing unless the Python verifier reads the same field, in the same position,
  // with the same separator. Nothing but running both catches a drift here — a disagreement
  // fails on every real dispatch, while somebody watches an approval card.
  assert.throws(
    () => verify({ ENVIRONMENT_NAME: buildEnvironmentName('222222222222222222') }),
    'the verifier must reject an approval re-pointed at another user\'s credentials',
  );

  // ...and refuses to run at all with no environment, rather than defaulting to one.
  const withoutEnvironment: NodeJS.ProcessEnv = { ...env };
  delete withoutEnvironment.ENVIRONMENT_NAME;
  assert.throws(
    () => execFileSync(python, ['.github/scripts/verify_approval.py'], { env: withoutEnvironment, stdio: 'pipe' }),
    'a missing ENVIRONMENT_NAME must fail closed, never fall back to a default',
  );
});

// ---------------------------------------------------------------------------------------
// `runsSince` - the daily cap's only honest source.
//
// The number being capped is Actions minutes and Anthropic spend, both of which are consumed
// by EVERY run of the workflow: runs this bot filed, runs a previous deploy filed against a
// database that has since been replaced, and runs a human started from the Actions tab. A
// counter in the bot's own tables counts only the first kind and resets whenever somebody
// restores a backup, which is not a cap.
// ---------------------------------------------------------------------------------------

test('runsSince counts runs of ONE workflow since a time, and counts every trigger', async () => {
  const { port, stub } = buildsAdapter(() => ({
    status: 200,
    body: { total_count: 4, workflow_runs: [{ id: 9 }] },
  }));
  const r = await port.runsSince(workflowFile(), NOW - 86_400_000);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, 4);

  const url = new URL(stub.requests[0]?.url ?? 'https://example.invalid');
  // The PER-WORKFLOW endpoint: the file name is the `workflow_id` path segment, so an unrelated
  // CI workflow in the same repository cannot eat somebody's build budget.
  assert.ok(url.pathname.endsWith('/actions/workflows/claude-build.yml/runs'), url.pathname);
  assert.equal(url.searchParams.get('created'), createdSinceFilter(NOW - 86_400_000));
  // AND NO `event` FILTER. `findRunByName` pins `workflow_dispatch` because it is hunting for
  // one run this bot started; a CAP must count a run a human kicked off too, because it spends
  // exactly the same money.
  assert.equal(url.searchParams.get('event'), null);
});

test('runsSince reads total_count, not the page - a page-sized cap would never trip', async () => {
  // The page is deliberately shorter than the count. Counting `workflow_runs.length` would
  // report "under the limit" for a repo well over it, which is the one failure a spend cap
  // cannot have.
  const { port } = buildsAdapter(() => ({ status: 200, body: { total_count: 137, workflow_runs: [] } }));
  const r = await port.runsSince(workflowFile(), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, 137);
});

test('an unrecognised runsSince payload is an ERROR, never a zero that opens the gate', async () => {
  const { port } = buildsAdapter(() => ({ status: 200, body: { nope: true } }));
  const r = await port.runsSince(workflowFile(), NOW);
  assert.equal(r.ok, false, 'a zero here would read as "nothing has run today"');
});

test('an API failure while reading the cap is an AppError, not an unhandled rejection', async () => {
  // 401 rather than 500 on purpose: a 5xx is RETRYABLE, so octokit's own retry policy spends
  // its full backoff before answering and the test costs fifteen seconds to prove nothing extra.
  // What matters here is that a thrown transport failure becomes a `Result`, and an expired PAT
  // proves that in one round trip.
  const { port } = buildsAdapter(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  const r = await port.runsSince(workflowFile(), NOW);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(userMessage(r.error).length > 0);
});


// ---------------------------------------------------------------------------------------
// CANCELLING A RUN.
//
// `/request cancel` used to stop the BOT and free the slot while the Actions run carried on to
// the end - burning the requester's own Anthropic credits, and a daily-cap slot, on a build
// nobody would ever look at. The bot said "cancelled"; the only thing it had cancelled was its
// own interest.
// ---------------------------------------------------------------------------------------

test('cancelRun posts to the run cancel endpoint and reads 202 as "requested"', async () => {
  // 202 ACCEPTED, not 200: cancellation is asynchronous on GitHub's side.
  const { port, stub } = buildsAdapter(() => ({ status: 202, body: {} }));
  const r = await port.cancelRun(33592845695);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.kind, 'requested');

  const request = stub.requests[0];
  assert.equal(request?.method, 'POST');
  assert.ok(
    (request?.url ?? '').endsWith('/repos/o/r/actions/runs/33592845695/cancel'),
    `the cancel endpoint must be the one called, got ${request?.url ?? '(nothing)'}`,
  );
});

test('a 409 is "there was nothing left to cancel", not a failure - and costs ONE request', async () => {
  // The routine outcome of clicking Cancel a second after the build finished. As an AppError
  // this would put "GitHub refused that, ask an admin" in front of somebody for whom nothing
  // went wrong; as `requested` it would claim a spend was stopped that had already happened.
  const { port, stub } = buildsAdapter(() => ({ status: 409, body: { message: 'Conflict' } }));
  const r = await port.cancelRun(5);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.kind, 'already-finished');

  // AND THE REASON 409 IS IN `DO_NOT_RETRY`. octokit's retry plugin retries every >= 400 it has
  // not been told about, so this - the COMMONEST successful path through the endpoint - would
  // otherwise cost four requests and about fourteen seconds of backoff before answering.
  assert.equal(stub.requests.length, 1, 'the routine answer must not be hammered');
});

test('a 404 from cancel stays an error: runs are not deleted, so it is a token or an id', async () => {
  const { port } = buildsAdapter(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await port.cancelRun(5);
  assert.equal(r.ok, false, 'folding this into "already finished" would bury a token-scope problem');
  if (r.ok) return;
  assert.ok(operatorMessage(r.error).includes('GITHUB_TOKEN'));
});

// ---------------------------------------------------------------------------------------
// THE OTHER HALF OF THE DAILY CAP.
//
// `modules.builder.dailyRunCap` and the workflow's `AGENT_DAILY_RUN_CAP` are equal only because
// an operator keeps them so. When they drift the bot dispatches builds the workflow then
// refuses, the card says "building", the run dies in its first seconds, and the reason exists
// only in an Actions log nobody is reading.
// ---------------------------------------------------------------------------------------

test('toRepositoryVariable reads exactly what the workflow guard would accept', () => {
  // The workflow's own check is `case "$DAILY_CAP" in ''|*[!0-9]*) ... exit 1`. Anything this
  // function accepts and that guard rejects is a "they agree" report about a value that kills
  // every build, so it has to be at least as strict.
  assert.deepEqual(toRepositoryVariable('CAP', '8'), { kind: 'number', name: 'CAP', value: 8 });
  assert.deepEqual(toRepositoryVariable('CAP', '0'), { kind: 'number', name: 'CAP', value: 0 });
  for (const bad of [' 4 ', '4.0', '+4', '-1', 'four', '', '4x', '1'.repeat(16)]) {
    assert.deepEqual(toRepositoryVariable('CAP', bad), { kind: 'not-a-number', name: 'CAP' }, JSON.stringify(bad));
  }
});

test('repositoryVariable reads the variables endpoint and parses the value', async () => {
  const { port, stub } = buildsAdapter(() => ({
    status: 200,
    body: { name: 'AGENT_DAILY_RUN_CAP', value: '8', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  }));
  const r = await port.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, { kind: 'number', name: 'AGENT_DAILY_RUN_CAP', value: 8 });

  const url = stub.requests[0]?.url ?? '';
  assert.ok(url.includes('/repos/o/r/actions/variables/AGENT_DAILY_RUN_CAP'), url);
});

test('a 404 means "not set, the workflow default applies" - never an error and never zero', async () => {
  // The ORDINARY state of a fresh install: nobody created the variable, and the workflow uses
  // the literal in `vars.AGENT_DAILY_RUN_CAP || '4'`. An error here would report correct
  // configuration as a fault; a zero would report a cap of nothing on a healthy repository.
  const { port } = buildsAdapter(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await port.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, { kind: 'unset', name: 'AGENT_DAILY_RUN_CAP' });
});

test('a variable set to something the workflow cannot read is its own answer', async () => {
  // ` 4 ` passes a human's eye and fails the workflow's guard, so every build dies in its first
  // seconds. Collapsing this into `unset` would hide the one drift nobody ever notices.
  const { port } = buildsAdapter(() => ({ status: 200, body: { name: 'AGENT_DAILY_RUN_CAP', value: ' 4 ' } }));
  const r = await port.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value, { kind: 'not-a-number', name: 'AGENT_DAILY_RUN_CAP' });
});

test('the answer echoes the name we ASKED about, not the casing GitHub stored', async () => {
  // Variable names are case-insensitive on GitHub's side. A caller comparing names must not be
  // handed a difference that means nothing.
  const { port } = buildsAdapter(() => ({ status: 200, body: { name: 'agent_daily_run_cap', value: '4' } }));
  const r = await port.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.name, 'AGENT_DAILY_RUN_CAP');
});

test('repositoryVariable refuses a name that could not be a variable, without a request', async () => {
  // The name becomes a REST path segment, exactly like the environment name does.
  const { port, stub } = buildsAdapter(() => ({ status: 200, body: { name: 'X', value: '1' } }));
  for (const bad of ['../../secrets', '1CAP', 'AGENT-DAILY-RUN-CAP', '', 'a'.repeat(201)]) {
    const r = await port.repositoryVariable(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
  }
  assert.equal(stub.requests.length, 0, 'and refused without touching the network');
});

test('an API failure reading the variable is an AppError, not a silent "unset"', async () => {
  // `unset` here would report "the workflow default applies" on the strength of a 401, i.e. the
  // bot would claim to have checked something it never read.
  const { port } = buildsAdapter(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  const r = await port.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(r.ok, false);
});

test('an unrecognised variable payload is an error rather than a guess', async () => {
  const { port } = buildsAdapter(() => ({ status: 200, body: { nope: true } }));
  const r = await port.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------------------
// The run report - the workflow's account of how a build ended
// ---------------------------------------------------------------------------------------

/** A comment body exactly as the workflow's report step writes it. */
function reportComment(json: Record<string, unknown>): string {
  const encoded = JSON.stringify(json).replaceAll('>', `${'\\'}u003e`);
  return `Agent run report\n\n<!-- agent-report:v1 ${encoded} -->`;
}

const REPORT = {
  run_id: 77,
  failed_step: null,
  stop: 'success',
  turns: 40,
  agent: { status: 'done', summary: 'Added /remind.', remaining: '' },
};

test('a report is read back for the run it names, and for no other run', () => {
  assert.deepEqual(parseRunReport(reportComment(REPORT), 77), {
    failedStep: null,
    stop: 'success',
    turns: 40,
    agent: { status: 'done', summary: 'Added /remind.', remaining: '' },
  });
  assert.equal(parseRunReport(reportComment(REPORT), 78), null, 'a retried request reuses the issue; the run id picks the report');
});

test('model text cannot close the HTML comment early, because the workflow escapes ">"', () => {
  const sneaky = { ...REPORT, agent: { status: 'done', summary: 'done --> <!-- agent-report:v1 {"run_id":77} -->', remaining: '' } };
  assert.equal(parseRunReport(reportComment(sneaky), 77)?.agent?.summary, sneaky.agent.summary);
});

test('a malformed agent half costs only the agent half, never the facts the workflow computed', () => {
  const bad = { ...REPORT, failed_step: 'forbidden_path', agent: { status: 'lol', summary: 1 } };
  const r = parseRunReport(reportComment(bad), 77);
  assert.equal(r?.failedStep, 'forbidden_path');
  assert.equal(r?.agent, null);
});

test('only the workflow token\'s comments count - anyone can type the marker on an issue', async () => {
  const forged = reportComment({ ...REPORT, agent: { status: 'done', summary: 'forged', remaining: '' } });
  const real = reportComment({ ...REPORT, failed_step: 'forbidden_path' });
  const { port } = buildsAdapter(() => ({
    status: 200,
    body: [
      { body: real, user: { login: 'github-actions[bot]' } },
      { body: forged, user: { login: 'someone' } },
    ],
  }));
  const r = await port.findRunReport(10, 77);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value?.failedStep, 'forbidden_path', 'the later, forged comment is ignored');
});
