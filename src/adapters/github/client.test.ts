/**
 * The failure-translation suite.
 *
 * Two things are being proven, and only one of them is about wording:
 *  1. A 404 from a private repository is reported as a TOKEN problem, because that is what it
 *     almost always is - GitHub answers 404 rather than 403 to hide the existence of a repo
 *     the credential cannot see. "That does not exist" sends an operator hunting for a deleted
 *     issue for an hour.
 *  2. NOTHING off the error object reaches any string - user-facing, operator-facing, or a
 *     `JSON.stringify` of the whole `AppError`. An octokit `RequestError` carries
 *     `request.headers.authorization`, and a serialised error is how a PAT reached a log line
 *     in the incident behind SC-6.
 *
 * Nothing here touches the network: the wire tests drive the real client through an injected
 * transport.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DO_NOT_RETRY,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  createGithubClient,
  isAlreadyExists,
  mapGithubError,
  readGithubFailure,
} from '#adapters/github/client';
import { isRetryable, operatorMessage, userMessage } from '#core/errors';
import { secret } from '#core/config';
import { fakeClock, fakeLogger } from '#testing/fakes';
import { stubFetch } from '#testing/http';

/** A token shaped exactly like the ones `redactSecrets` knows about. */
const PAT = `ghp_${'A'.repeat(36)}`;
const NOW = 1_700_000_000_000;

interface ErrorFixture {
  readonly status: number;
  readonly codes?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * An octokit `RequestError` look-alike, complete with the credential in every place the real
 * one carries it: the message, the request headers, and the echoed response body.
 */
function githubError(fixture: ErrorFixture): Error {
  const e = new Error(`HttpError: request failed with Authorization: token ${PAT}`);
  e.name = 'HttpError';
  return Object.assign(e, {
    status: fixture.status,
    request: {
      method: 'POST',
      url: 'https://api.github.com/repos/o/r/issues',
      headers: { authorization: `token ${PAT}`, 'user-agent': GITHUB_USER_AGENT },
    },
    response: {
      status: fixture.status,
      url: 'https://api.github.com/repos/o/r/issues',
      headers: fixture.headers ?? {},
      data: {
        message: `Validation Failed (token ${PAT})`,
        errors: (fixture.codes ?? []).map((code) => ({ resource: 'Label', field: 'name', code })),
      },
    },
  });
}

test('a 404 blames the token scope, not a missing item', () => {
  const e = mapGithubError(githubError({ status: 404 }), 'issues.create', NOW);
  assert.equal(e.kind, 'upstream');
  assert.ok(!userMessage(e).includes('GITHUB_TOKEN'), 'a user is told to ask an admin, not handed a variable name');
  const text = operatorMessage(e);
  assert.ok(text.includes('GITHUB_TOKEN'), 'the log names the token the operator has to fix');
  assert.ok(text.includes('private repository'), 'must explain why 404 is the answer');
  assert.ok(!/does not exist/iu.test(text), 'must not send anyone hunting for a deleted issue');
});

test('401 and 403 are never retryable, so a bad token cannot be hammered into a block', () => {
  for (const status of [401, 403]) {
    const e = mapGithubError(githubError({ status }), 'issues.create', NOW);
    assert.equal(isRetryable(e), false, `status ${status} must not be retried`);
  }
  assert.ok(DO_NOT_RETRY.includes(401), 'the transport must agree with core');
  assert.ok(DO_NOT_RETRY.includes(403), 'the transport must agree with core');
});

test('409 is on the list, because it is a SUCCESSFUL answer from the cancel endpoint', () => {
  // `POST /actions/runs/{id}/cancel` answers 409 for a run that already finished, and
  // `BuildsPort.cancelRun` reads that as `already-finished` - the routine outcome of clicking
  // Cancel a second after the build ended. The retry plugin retries every >= 400 it has not
  // been told about, so without this entry the commonest successful path through that endpoint
  // costs four requests and roughly fourteen seconds of backoff before the adapter sees it.
  // `runs.test.ts` asserts the request COUNT, which is the behaviour; this pins the reason.
  assert.ok(DO_NOT_RETRY.includes(409));
});

test('a 403 with the rate-limit headers is a rate limit, not a permission denial', () => {
  const e = mapGithubError(
    githubError({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 90_000) / 1000) } }),
    'issues.create',
    NOW,
  );
  assert.equal(e.kind, 'rate-limited');
  if (e.kind !== 'rate-limited') return;
  assert.equal(e.retryAfterMs, 90_000, 'x-ratelimit-reset is an absolute epoch, resolved against the supplied clock');
  assert.equal(e.bucket, 'github');
});

test('a 403 with no rate-limit signal stays a permission problem', () => {
  const e = mapGithubError(githubError({ status: 403 }), 'issues.create', NOW);
  assert.equal(e.kind, 'upstream');
  assert.ok(operatorMessage(e).includes('repository permission'));
  assert.ok(userMessage(e).includes('Ask an admin'));
});

test('an absurd retry-after is bounded, so a job cannot be told to sleep for a day', () => {
  const e = mapGithubError(githubError({ status: 429, headers: { 'retry-after': '86400' } }), 'runs.status', NOW);
  assert.equal(e.kind, 'rate-limited');
  if (e.kind !== 'rate-limited') return;
  assert.ok(e.retryAfterMs <= 15 * 60_000, `bounded, got ${e.retryAfterMs}`);
});

test('no credential survives into any string an operator or a user could read', () => {
  for (const status of [0, 401, 403, 404, 422, 429, 500, 503]) {
    const e = mapGithubError(githubError({ status, codes: ['already_exists'] }), 'issues.create', NOW);
    const serialised = JSON.stringify(e);
    assert.ok(!serialised.includes(PAT), `status ${status}: the token must not survive serialisation`);
    assert.ok(!userMessage(e).includes(PAT), `status ${status}: not in the user message`);
    assert.ok(!operatorMessage(e).includes(PAT), `status ${status}: not in the operator message`);
    assert.ok(!serialised.includes('Authorization'), `status ${status}: no echoed auth header`);
  }
});

test('a redacted-looking token in an internal line is still redacted', () => {
  // Belt and braces: `internal` is built from the status and the error codes only, but the
  // redaction pass is what makes that a guarantee rather than a reading of the code.
  const e = mapGithubError(githubError({ status: 422, codes: [`already_exists ${PAT}`] }), 'issues.ensureLabel', NOW);
  assert.ok(e.internal !== null);
  assert.ok(!(e.internal ?? '').includes(PAT));
  assert.ok((e.internal ?? '').includes('[redacted]'));
});

test('a thrown non-Error is still an AppError, because a catch must never throw again', () => {
  const e = mapGithubError('boom', 'issues.create', NOW);
  assert.equal(e.kind, 'upstream');
  if (e.kind !== 'upstream') return;
  assert.equal(e.status, 0);
  assert.equal(isRetryable(e), true, 'a transport failure is worth retrying');
});

test('isAlreadyExists matches the verified 422 shape and nothing else', () => {
  const at = (cause: unknown): boolean => isAlreadyExists(readGithubFailure(cause, NOW));
  assert.equal(at(githubError({ status: 422, codes: ['already_exists'] })), true);
  // The duplicate-label answer is 422. A 409 branch would be dead code, so it must not match.
  assert.equal(at(githubError({ status: 409, codes: ['already_exists'] })), false);
  assert.equal(at(githubError({ status: 422, codes: ['missing_field'] })), false);
  assert.equal(at(githubError({ status: 422 })), false);
  assert.equal(at(new Error('network down')), false);
});

test('readGithubFailure reads only the five safe facts', () => {
  const f = readGithubFailure(githubError({ status: 422, codes: ['already_exists'], headers: { 'x-ratelimit-remaining': '17' } }), NOW);
  assert.deepEqual({ ...f, codes: [...f.codes] }, {
    status: 422,
    name: 'HttpError',
    codes: ['already_exists'],
    retryAfterMs: null,
    rateLimitRemaining: 17,
  });
});

// ---------------------------------------------------------------------------------------
// Wire-level: the client the bot actually builds, driven through an injected transport.
// ---------------------------------------------------------------------------------------

test('every request carries the pinned API version, on the client the bot really builds', async () => {
  const stub = stubFetch(() => ({ status: 200, body: { login: 'octocat' } }));
  const octokit = createGithubClient({ token: secret(PAT), logger: fakeLogger(), fetch: stub.fetch });

  await octokit.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
  await octokit.request('GET /repos/{owner}/{repo}/issues', { owner: 'o', repo: 'r' });

  assert.equal(stub.requests.length, 2);
  for (const req of stub.requests) {
    // THE REGRESSION THIS LOCKS DOWN: a constructor `headers:` option typechecks (OctokitOptions
    // has an `any` index signature) and is then dropped by @octokit/core, so the pin has to be
    // a request hook. Without the hook this assertion fails and nothing else does.
    assert.equal(req.headers['x-github-api-version'], GITHUB_API_VERSION);
    assert.ok((req.headers['user-agent'] ?? '').includes(GITHUB_USER_AGENT));
  }
});

test('the clock the adapter is given is the clock the rate-limit maths uses', () => {
  const clock = fakeClock(NOW);
  const e = mapGithubError(
    githubError({ status: 429, headers: { 'x-ratelimit-reset': String((NOW + 30_000) / 1000) } }),
    'runs.status',
    clock.now(),
  );
  assert.equal(e.kind, 'rate-limited');
  if (e.kind !== 'rate-limited') return;
  assert.equal(e.retryAfterMs, 30_000);
});
