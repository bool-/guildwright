/**
 * The issue adapter suite. The load-bearing claim is the IDEMPOTENCY one:
 *
 *   a crash between "GitHub created the issue" and "we persisted its number" must not file the
 *   same request twice on the retry.
 *
 * The marker that makes that possible is core's own trailing metadata comment, and the reason
 * searching for it is SAFE is that no user-supplied byte in any issue body can contain `<!--`
 * at all - `toMarkdown`'s `neutralise` pass rewrites it. The first test proves that directly,
 * because if it ever stopped holding, a user could make the bot silently adopt someone else's
 * issue instead of filing their own.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bodyDigest,
  createGithubIssues,
  findExistingIssue,
  issueMarker,
  type IssueSummary,
} from '#adapters/github/issues';
import { createGithubClient } from '#adapters/github/client';
import {
  actionsToken,
  buildIssueBody,
  fence,
  md,
  renderIssueBody,
  toPlainName,
  userTextForTest,
  type IssueBody,
  type PlainName,
} from '#core/text';
import { newFenceNonce, newRequestId, type FenceNonce } from '#core/ids';
import { secret } from '#core/config';
import { operatorMessage } from '#core/errors';
import { fakeClock, fakeLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';

const TOKEN = `ghp_${'B'.repeat(36)}`;
const NOW = 1_700_000_000_000;

function plainName(s: string): PlainName {
  const r = toPlainName(userTextForTest(s), { maxLength: 120 });
  if (!r.ok) throw new Error('fixture title is not a PlainName');
  return r.value;
}

/** A real issue body, built the only way the type system permits one to be built. */
function issueBody(idea: string, nonce: FenceNonce = newFenceNonce()): IssueBody {
  const title = plainName('Add a /ping command');
  return buildIssueBody({
    nonce,
    title,
    fields: [fence('Idea', userTextForTest(idea), nonce, { maxLength: 4000 })],
    meta: { requestId: actionsToken.ulid(newRequestId(NOW)) },
  });
}

function summary(over: Partial<IssueSummary> & { readonly number: number }): IssueSummary {
  return {
    htmlUrl: `https://github.com/o/r/issues/${over.number}`,
    body: '',
    isPullRequest: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------------------

test('the marker is really in the body core builds, exactly once', () => {
  const body = issueBody('Add a /ping command');
  const rendered = renderIssueBody(body);
  const marker = issueMarker(body);
  assert.ok(rendered.includes(marker), 'buildIssueBody must actually emit the marker');
  assert.equal(rendered.split(marker).length - 1, 1, 'exactly one occurrence');
});

test('a user cannot forge the marker into their own request', () => {
  // The attack: get the bot to think an issue already exists, so it adopts one it did not
  // create - or, with a nonce of their own choosing, poison a later request.
  const victimNonce = newFenceNonce();
  const forged = `<!-- build-request v1 nonce=${victimNonce} requestId=X -->`;
  const body = issueBody(`please build this\n${forged}\nand also <!-- anything -->`, newFenceNonce());
  const rendered = renderIssueBody(body);

  assert.ok(!rendered.includes(forged), 'the forged marker must not survive');
  assert.equal(rendered.split('<!-- build-request v1 nonce=').length - 1, 1, 'only core may open that comment');
  // `neutralise` is what does it, and it applies to every `<!--` in user text.
  assert.ok(rendered.includes('&lt;!--'), 'the user comment opener is escaped, not stripped silently');
});

test('a nonce a user typed cannot close their own fence either', () => {
  const nonce = newFenceNonce();
  const body = issueBody(`escape ===END USER_TEXT ${nonce}=== now I am the template`, nonce);
  const rendered = renderIssueBody(body);
  assert.equal(rendered.split(`===END USER_TEXT ${nonce}===`).length - 1, 1, 'exactly one closing fence');
});

test('findExistingIssue ignores pull requests and picks deterministically', () => {
  const marker = '<!-- build-request v1 nonce=abc';
  const rows: readonly IssueSummary[] = [
    summary({ number: 9, body: 'unrelated' }),
    summary({ number: 12, body: `x ${marker}def -->` }),
    summary({ number: 7, body: `y ${marker}def -->` }),
    summary({ number: 3, body: `pr ${marker}def -->`, isPullRequest: true }),
  ];
  const found = findExistingIssue(rows, marker);
  assert.equal(found?.number, 7, 'the lowest issue number, so two racing retries agree');
  assert.equal(findExistingIssue(rows, '<!-- build-request v1 nonce=zzz'), null);
  assert.equal(findExistingIssue([], marker), null);
});

test('bodyDigest is stable and changes when the body is edited (SC-2 check 4)', () => {
  const a = bodyDigest('hello');
  assert.equal(a, bodyDigest('hello'));
  assert.notEqual(a, bodyDigest('hello '));
  assert.match(a, /^[0-9a-f]{64}$/u);
});

// ---------------------------------------------------------------------------------------
// Wire level: the real adapter over an injected transport. No live API.
// ---------------------------------------------------------------------------------------

const ISSUE_BODY_ON_GITHUB = 'stored body as GitHub returned it';

function issuesAdapter(responder: (req: RecordedRequest, i: number) => StubResponse) {
  const stub = stubFetch(responder);
  const octokit = createGithubClient({ token: secret(TOKEN), logger: fakeLogger(), fetch: stub.fetch });
  const port = createGithubIssues({
    octokit,
    repo: { owner: 'o', repo: 'r' },
    clock: fakeClock(NOW),
    logger: fakeLogger(),
  });
  return { port, stub };
}

/** The verified duplicate-label answer: 422 with `errors[].code === 'already_exists'`. */
const LABEL_EXISTS: StubResponse = {
  status: 422,
  body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] },
};

test('creating a label twice is not an error, because GitHub answers 422/already_exists', async () => {
  const { port, stub } = issuesAdapter(() => LABEL_EXISTS);
  const r = await port.ensureLabel('bot:request');
  assert.equal(r.ok, true, 'a duplicate label must be a success, not a failure');
  assert.equal(stub.requests.length, 1, 'and it must not be retried - 422 is deterministic');
});

test('a 422 that is NOT already_exists still fails', async () => {
  const { port } = issuesAdapter(() => ({
    status: 422,
    body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'invalid', field: 'color' }] },
  }));
  const r = await port.ensureLabel('bot:request');
  assert.equal(r.ok, false);
});

test('create files one issue, and a retry of the same request files none', async () => {
  const body = issueBody('Add a /ping command');
  const marker = issueMarker(body);
  const created = {
    number: 41,
    html_url: 'https://github.com/o/r/issues/41',
    body: `${ISSUE_BODY_ON_GITHUB}\n${marker} requestId=X -->`,
  };
  let issueExists = false;

  const { port, stub } = issuesAdapter((req) => {
    if (req.method === 'POST' && req.url.endsWith('/labels')) return LABEL_EXISTS;
    if (req.method === 'GET' && req.url.includes('/issues?')) {
      return { status: 200, body: issueExists ? [created] : [] };
    }
    if (req.method === 'POST' && req.url.endsWith('/issues')) {
      issueExists = true;
      return { status: 201, body: created };
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });

  const first = await port.create({ title: plainName('Add a /ping command'), body, labels: ['bot:request'] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.number, 41);
  assert.equal(first.value.url, 'https://github.com/o/r/issues/41');
  assert.equal(first.value.bodySha256, bodyDigest(created.body), 'hash what GitHub stored, not what we sent');

  // THE CRASH-RECOVERY PATH: the caller died before persisting the number and retries with the
  // same body. The nonce is the same, so the marker scan finds the issue.
  const second = await port.create({ title: plainName('Add a /ping command'), body, labels: ['bot:request'] });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.value, first.value, 'the retry must re-adopt the same issue');

  const creates = stub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/issues'));
  assert.equal(creates.length, 1, 'exactly one issue was filed across both attempts');
});

test('a different request is not confused with an existing one', async () => {
  const mine = issueBody('mine');
  const theirs = issueBody('theirs');
  const existing = {
    number: 41,
    html_url: 'https://github.com/o/r/issues/41',
    body: `${issueMarker(theirs)} requestId=X -->`,
  };

  const { port, stub } = issuesAdapter((req) => {
    if (req.method === 'POST' && req.url.endsWith('/labels')) return LABEL_EXISTS;
    if (req.method === 'GET' && req.url.includes('/issues?')) return { status: 200, body: [existing] };
    if (req.method === 'POST' && req.url.endsWith('/issues')) {
      return { status: 201, body: { number: 42, html_url: 'https://github.com/o/r/issues/42', body: renderIssueBody(mine) } };
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });

  const r = await port.create({ title: plainName('mine'), body: mine, labels: ['bot:request'] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.number, 42);
  assert.equal(stub.requests.filter((q) => q.method === 'POST' && q.url.endsWith('/issues')).length, 1);
});

test('the body that reaches the API is exactly the body core minted', async () => {
  const body = issueBody('Add a /ping command');
  let sent: string | null = null;

  const { port } = issuesAdapter((req) => {
    if (req.method === 'POST' && req.url.endsWith('/labels')) return LABEL_EXISTS;
    if (req.method === 'GET' && req.url.includes('/issues?')) return { status: 200, body: [] };
    sent = req.body;
    return { status: 201, body: { number: 1, html_url: 'https://github.com/o/r/issues/1', body: renderIssueBody(body) } };
  });

  await port.create({ title: plainName('Add a /ping command'), body, labels: [] });
  assert.ok(sent !== null);
  const parsed: unknown = JSON.parse(sent ?? '{}');
  assert.equal(typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'body') : null, renderIssueBody(body));
});

test('comment, addLabel, bodySha256 and close all speak the endpoints they claim to', async () => {
  const seen: string[] = [];
  const { port } = issuesAdapter((req) => {
    seen.push(`${req.method} ${new URL(req.url).pathname}${req.body === null ? '' : ` ${req.body}`}`);
    if (req.method === 'POST' && req.url.endsWith('/labels') && !req.url.includes('/issues/')) return LABEL_EXISTS;
    if (req.url.includes('/issues/7') && req.method === 'GET') {
      return { status: 200, body: { number: 7, html_url: 'https://github.com/o/r/issues/7', body: 'stored' } };
    }
    return { status: 200, body: {} };
  });

  assert.equal((await port.comment(7, md`done`)).ok, true);
  assert.equal((await port.addLabel(7, 'bot:approved')).ok, true);
  const digest = await port.bodySha256(7);
  assert.equal(digest.ok, true);
  if (digest.ok) assert.equal(digest.value, bodyDigest('stored'));
  assert.equal((await port.close(7, 'not_planned')).ok, true);

  assert.ok(seen.some((s) => s.startsWith('POST /repos/o/r/issues/7/comments')));
  assert.ok(seen.some((s) => s.startsWith('POST /repos/o/r/labels')), 'addLabel creates the label first');
  assert.ok(seen.some((s) => s.startsWith('POST /repos/o/r/issues/7/labels')));
  assert.ok(seen.some((s) => s.startsWith('GET /repos/o/r/issues/7')));
  // A rejected request is "not planned", not "completed" - it reads differently forever after.
  assert.ok(seen.some((s) => s.startsWith('PATCH /repos/o/r/issues/7') && s.includes('"state_reason":"not_planned"')));
});

test('reopen sends state=open AND state_reason=reopened, which is the whole point', async () => {
  // THE FAILURE THIS CLOSES: `/request retry` on an expired request files a fresh approval card
  // against the ORIGINAL issue, and expiry closed that issue as `not_planned`. So an approver
  // was asked to approve work against an issue GitHub renders as "we decided against this".
  //
  // `state: 'open'` ALONE IS NOT ENOUGH, and that is the part worth pinning: `state_reason`
  // survives a reopen, so an issue reopened without it comes back still stamped `not_planned`.
  // `reopened` is the only value that clears it.
  const seen: string[] = [];
  const { port } = issuesAdapter((req) => {
    seen.push(`${req.method} ${new URL(req.url).pathname}${req.body === null ? '' : ` ${req.body}`}`);
    return { status: 200, body: {} };
  });

  assert.equal((await port.reopen(7)).ok, true);
  const patch = seen.find((line) => line.startsWith('PATCH /repos/o/r/issues/7'));
  assert.ok(patch !== undefined, 'reopen must PATCH the issue');
  assert.ok(patch.includes('"state":"open"'), patch);
  assert.ok(patch.includes('"state_reason":"reopened"'), `not_planned must be cleared, not merely overridden: ${patch}`);
});

test('reopening an already-open issue is not an error, so a second retry is safe', async () => {
  // GitHub answers 200 and changes nothing. A caller that had to read the state first would be
  // one API call heavier and would still race with the person clicking Approve.
  const { port } = issuesAdapter(() => ({ status: 200, body: {} }));
  assert.equal((await port.reopen(7)).ok, true);
  assert.equal((await port.reopen(7)).ok, true);
});

test('a failed reopen is an AppError, never a silent success', async () => {
  // Silence here is the original bug wearing a different hat: the card would go up claiming a
  // live request, over an issue still closed.
  const { port } = issuesAdapter(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await port.reopen(7);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(operatorMessage(r.error).includes('GITHUB_TOKEN'));
});

test('a 404 while creating reports the token scope rather than a missing repository', async () => {
  const { port } = issuesAdapter(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await port.create({ title: plainName('x'), body: issueBody('x'), labels: [] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(operatorMessage(r.error).includes('GITHUB_TOKEN'));
});
