/**
 * The boot-time GitHub preflight.
 *
 * WHAT IS ACTUALLY BEING PROVEN, and none of it is about wording:
 *
 *  1. THE LINE BETWEEN FATAL AND NOT. A 401 or a 404 is a value somebody has to edit, so the
 *     bot must refuse to start; a 403, a 429, a 5xx or an unreachable network is GitHub having
 *     a bad day, so the bot must start anyway. Getting that backwards either ships a bot whose
 *     flagship command is guaranteed to fail, or puts the bot in a restart loop against an API
 *     that is already limiting it - and takes `/help` and `/tags` down during someone else's
 *     outage.
 *
 *  2. THAT THE FATAL ERROR NAMES THE ENVIRONMENT VARIABLE. `formatConfigFailure` prints
 *     `where: <location>`, and an operator who reads "where: GET /repos/{owner}/{repo}" has
 *     learned nothing. Each probe indicts the variable a human can change.
 *
 *  3. THAT NOTHING OFF THE ERROR REACHES A SENTENCE. An octokit error carries
 *     `request.headers.authorization`; the whole `AppError` is serialised here and searched for
 *     the token, exactly as `client.test.ts` does for the mapper.
 *
 *  4. THAT THE EXPIRY HEADER IS PARSED WITHOUT `Date.parse` ON A NON-ISO STRING. GitHub sends
 *     `2026-03-10 15:04:05 UTC`, which is not ISO-8601, so `Date.parse` on it is
 *     implementation-defined - a warning that quietly stops working on a runtime upgrade is
 *     worse than no warning.
 *
 * Nothing here touches the network: the wire tests drive the REAL client through an injected
 * transport, so the API-version pin and the never-retry-a-401 policy are the ones the bot runs.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  TOKEN_EXPIRY_HEADER,
  TOKEN_EXPIRY_WARN_MS,
  classifyPreflightFailure,
  daysUntil,
  logPreflightWarnings,
  parseTokenExpiry,
  preflightGithub,
  tokenExpiryWarning,
  workflowStateWarning,
  type GithubPreflightReport,
} from '#adapters/github/preflight';
import { createGithubClient, GITHUB_USER_AGENT } from '#adapters/github/client';
import { toGitRef, toWorkflowFile, type LoggerPort } from '#core/ports';
import { operatorMessage } from '#core/errors';
import type { JsonObject } from '#core/json';
import { secret } from '#core/config';
import { fakeLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';

const TOKEN = `ghp_${'D'.repeat(36)}`;
const NOW = Date.parse('2026-03-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function workflowFile() {
  const wf = toWorkflowFile('agent-implement-request.yml');
  if (!wf.ok) throw new Error('fixture workflow file is invalid');
  return wf.value;
}

function gitRef() {
  const ref = toGitRef('main');
  if (!ref.ok) throw new Error('fixture ref is invalid');
  return ref.value;
}

/** An octokit `RequestError` look-alike, carrying the credential everywhere the real one does. */
function githubError(status: number, headers: Readonly<Record<string, string>> = {}): Error {
  const e = new Error(`HttpError: request failed with Authorization: token ${TOKEN}`);
  e.name = 'HttpError';
  return Object.assign(e, {
    status,
    request: {
      method: 'GET',
      url: 'https://api.github.com/repos/o/r',
      headers: { authorization: `token ${TOKEN}`, 'user-agent': GITHUB_USER_AGENT },
    },
    response: { status, url: 'https://api.github.com/repos/o/r', headers, data: { message: `nope ${TOKEN}` } },
  });
}

/** The real client over a stub transport, plus the request log. */
function preflight(responder: (req: RecordedRequest, i: number) => StubResponse) {
  const stub = stubFetch(responder);
  const octokit = createGithubClient({ token: secret(TOKEN), logger: fakeLogger(), fetch: stub.fetch });
  return {
    stub,
    run: async () =>
      await preflightGithub({
        octokit,
        repo: { owner: 'o', repo: 'r' },
        workflowFile: workflowFile(),
        ref: gitRef(),
        nowMs: NOW,
      }),
  };
}

/** The three happy answers, keyed by which endpoint was asked. */
function ok(headers: Readonly<Record<string, string>> = {}) {
  return (req: RecordedRequest): StubResponse => {
    const path = new URL(req.url).pathname;
    if (path === '/repos/o/r') return { status: 200, body: { full_name: 'o/r', has_issues: true }, headers };
    if (path.startsWith('/repos/o/r/actions/workflows/')) {
      return { status: 200, body: { state: 'active', path: '.github/workflows/agent-implement-request.yml' }, headers };
    }
    return { status: 200, body: { sha: 'a'.repeat(40) }, headers };
  };
}

// ---------------------------------------------------------------------------------------
// The expiry header, parsed by hand
// ---------------------------------------------------------------------------------------

test('the fine-grained-PAT expiry header is parsed in the format GitHub actually sends', () => {
  // The exact shape a fine-grained PAT comes back with: a space separator and a bare `UTC`.
  assert.equal(parseTokenExpiry('2026-03-10 15:04:05 UTC'), Date.parse('2026-03-10T15:04:05Z'));
  // And the variants seen in the wild.
  assert.equal(parseTokenExpiry('2026-03-10T15:04:05Z'), Date.parse('2026-03-10T15:04:05Z'));
  assert.equal(parseTokenExpiry('2026-03-10 15:04:05 +0100'), Date.parse('2026-03-10T15:04:05+01:00'));
  assert.equal(parseTokenExpiry('2026-03-10 15:04:05 -08:00'), Date.parse('2026-03-10T15:04:05-08:00'));
  assert.equal(parseTokenExpiry('  2026-03-10 15:04:05 UTC  '), Date.parse('2026-03-10T15:04:05Z'));
});

test('an absent or unreadable expiry header says nothing rather than guessing', () => {
  // Classic PATs and App installation tokens do not send the header at all, and a header this
  // code cannot read is not evidence that a credential is about to expire.
  for (const raw of [null, undefined, '', 'never', '2026-03-10', 'yesterday', '2026-13-45 99:99:99 UTC']) {
    assert.equal(parseTokenExpiry(raw), null, JSON.stringify(raw));
  }
});

test('the expiry warning fires inside the window and stays silent outside it', () => {
  const windowDays = TOKEN_EXPIRY_WARN_MS / DAY;
  assert.equal(windowDays, 14, 'the documented window is two weeks');

  assert.equal(tokenExpiryWarning(null, NOW), null, 'a token with no advertised expiry is not a finding');
  assert.equal(tokenExpiryWarning(NOW + 30 * DAY, NOW), null, 'a month out is not urgent');

  const soon = tokenExpiryWarning(NOW + 3 * DAY, NOW);
  assert.ok(soon !== null, 'three days out must warn');
  assert.ok(soon.includes('GITHUB_TOKEN'), 'and must name the variable to renew');
  assert.ok(soon.includes('3 day'), 'and say how long is left');
});

test('an expiry already in the past warns about the CLOCK, because the API disagreed', () => {
  // Reaching this line means GitHub accepted the credential — if it were really expired the
  // request would have been a 401, which is fatal. So the header and the API disagree, and the
  // API is the authority.
  const past = tokenExpiryWarning(NOW - DAY, NOW);
  assert.ok(past !== null);
  assert.ok(past.includes('already passed'));
  assert.equal(daysUntil(NOW - DAY, NOW), -1);
  assert.equal(daysUntil(NOW + 2 * DAY + 1000, NOW), 2, 'whole days, rounded down');
});

// ---------------------------------------------------------------------------------------
// The fatal / not-fatal line
// ---------------------------------------------------------------------------------------

const CLASSIFY = {
  nowMs: NOW,
  location: 'GITHUB_REPO',
  operation: 'preflight.repo',
  notFoundNextStep: 'Check GITHUB_OWNER and GITHUB_REPO and restart.',
  notFoundIsFatal: true,
} as const;

test('401 and 404 are fatal; everything else lets the bot start', () => {
  for (const status of [401, 404]) {
    const verdict = classifyPreflightFailure({ ...CLASSIFY, cause: githubError(status) });
    assert.ok('fatal' in verdict, `${status} must stop the boot`);
    assert.equal(verdict.fatal.kind, 'config', 'and it must be a config error, so main exits 1');
  }

  // A 403 is a permissions or abuse answer, a 429 is a rate limit, a 5xx is GitHub, and 0 is
  // the network. NONE of them is evidence that a value in the environment is wrong, and
  // refusing to boot on any of them means a GitHub incident takes /help down too — and puts
  // the bot in a restart loop against an API that is already limiting it.
  for (const status of [0, 403, 429, 500, 502, 503]) {
    const verdict = classifyPreflightFailure({ ...CLASSIFY, cause: githubError(status) });
    assert.ok('warning' in verdict, `${status} must not stop the boot`);
    assert.ok(verdict.warning.length > 0, 'but it must still say something');
  }
});

test('a probe whose 404 is AMBIGUOUS warns instead of refusing the boot', () => {
  // The ref probe is the one that cannot tell "GITHUB_REF is wrong" from "the token has no
  // Contents permission", and nothing else in this bot needs Contents — a dispatch needs
  // Actions write. Making that fatal would refuse to start a bot that has been working.
  const verdict = classifyPreflightFailure({
    ...CLASSIFY,
    location: 'GITHUB_REF',
    notFoundIsFatal: false,
    cause: githubError(404),
  });
  assert.ok('warning' in verdict, 'an ambiguous 404 must not stop the boot');
  assert.ok(verdict.warning.includes('GITHUB_REF'), 'but the warning still names the variable');
  assert.ok(verdict.warning.includes(CLASSIFY.notFoundNextStep), 'and still says what to do');

  // A 401 is fatal on EVERY probe, ambiguous or not: nothing works without a valid credential.
  const dead = classifyPreflightFailure({ ...CLASSIFY, notFoundIsFatal: false, cause: githubError(401) });
  assert.ok('fatal' in dead);
});

test('a 401 blames GITHUB_TOKEN; a 404 blames the variable the caller named', () => {
  // `formatConfigFailure` prints `where: <location>`. An operator who reads a REST path there
  // has learned nothing they can act on.
  const unauthorised = classifyPreflightFailure({ ...CLASSIFY, cause: githubError(401) });
  assert.ok('fatal' in unauthorised);
  assert.equal(unauthorised.fatal.kind === 'config' ? unauthorised.fatal.location : '', 'GITHUB_TOKEN');

  const missing = classifyPreflightFailure({
    ...CLASSIFY,
    location: 'GITHUB_WORKFLOW_FILE',
    cause: githubError(404),
  });
  assert.ok('fatal' in missing);
  assert.equal(missing.fatal.kind === 'config' ? missing.fatal.location : '', 'GITHUB_WORKFLOW_FILE');
  assert.equal(missing.fatal.nextStep, CLASSIFY.notFoundNextStep, 'the 404 sentence is the probe-specific one');
});

test('nothing read off the error reaches any string, including the operator one', () => {
  // SC-6. An octokit error carries `request.headers.authorization`; serialise the whole
  // AppError and go looking for the token.
  for (const status of [401, 404]) {
    const verdict = classifyPreflightFailure({ ...CLASSIFY, cause: githubError(status) });
    assert.ok('fatal' in verdict);
    const serialised = JSON.stringify(verdict.fatal);
    assert.ok(!serialised.includes(TOKEN), `a ${status} leaked the PAT into the AppError`);
    assert.ok(!operatorMessage(verdict.fatal).includes(TOKEN), `a ${status} leaked the PAT into the operator line`);
  }
});

test('a workflow that is not active is a warning, not a boot refusal', () => {
  // It is fixable on the repository's Actions tab WITHOUT a restart, which is exactly the line
  // between a warning and a fatal here: fatal means "edit a value and restart".
  assert.equal(workflowStateWarning('active', 'x.yml'), null);
  for (const state of ['disabled_manually', 'disabled_inactivity', 'disabled_fork']) {
    const warning = workflowStateWarning(state, 'x.yml');
    assert.ok(warning !== null, state);
    assert.ok(warning.includes('x.yml') && warning.includes(state));
  }
});

// ---------------------------------------------------------------------------------------
// The real adapter, over an injected transport
// ---------------------------------------------------------------------------------------

test('the preflight asks about the repository, the workflow file AND the ref', async () => {
  const p = preflight(ok());
  const r = await p.run();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.fullName, 'o/r');
  assert.equal(r.value.workflowState, 'active');
  assert.deepEqual(r.value.warnings, [], 'a healthy repository produces no noise');

  const paths = p.stub.requests.map((req) => new URL(req.url).pathname);
  assert.deepEqual(
    paths,
    ['/repos/o/r', '/repos/o/r/actions/workflows/agent-implement-request.yml', '/repos/o/r/commits/main'],
    'GITHUB_REF is the third value that silently breaks every dispatch, so it is checked too',
  );
  // The pin is a property of the client the bot builds, and this IS the client the bot builds.
  assert.equal(p.stub.requests[0]?.headers['x-github-api-version'], '2026-03-10');
});

test('an expired PAT stops the boot at the FIRST call, not after three', async () => {
  // Running the probes together would report three failures for one cause and spend three
  // requests to say one thing.
  const p = preflight(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  const r = await p.run();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, 'config');
  assert.equal(r.error.kind === 'config' ? r.error.location : '', 'GITHUB_TOKEN');
  assert.equal(p.stub.requests.length, 1, 'the token is dead; asking twice more proves nothing');
});

test('a renamed workflow file is caught at boot and names GITHUB_WORKFLOW_FILE', async () => {
  const p = preflight((req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/repos/o/r/actions/workflows/')) return { status: 404, body: { message: 'Not Found' } };
    return ok()(req);
  });
  const r = await p.run();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind === 'config' ? r.error.location : '', 'GITHUB_WORKFLOW_FILE');
  assert.ok(r.error.nextStep.includes('agent-implement-request.yml'), 'name the file that is missing');
});

test('a GITHUB_REF that does not resolve is surfaced at boot, loudly, without refusing to start', async () => {
  // The failure this replaces: the bot boots clean, somebody clicks Approve, the dispatch 404s,
  // the retry path swallows it, and the card says "it timed out" six hours later, about a build
  // that never started.
  //
  // It is a WARNING rather than a refusal because resolving a ref needs the Contents
  // permission, which nothing else in this bot uses — so a token that dispatches builds
  // perfectly well can 404 here, and refusing to boot on that would take down a working bot.
  const p = preflight((req) => {
    if (new URL(req.url).pathname === '/repos/o/r/commits/main') return { status: 404, body: { message: 'No commit' } };
    return ok()(req);
  });
  const r = await p.run();
  assert.equal(r.ok, true, 'an ambiguous answer must not stop the boot');
  if (!r.ok) return;
  assert.equal(r.value.warnings.length, 1);
  const warning = r.value.warnings[0] ?? '';
  assert.ok(warning.includes('GITHUB_REF'), 'the variable to check is named');
  assert.ok(warning.includes('main'), 'and so is the value that did not resolve');
  assert.ok(warning.includes('Contents'), 'and the other possible cause, so nobody chases the wrong one');
});

test('a 404 on the repository itself reads as a token-scope story, not a missing repo', async () => {
  // GitHub answers 404 rather than 403 for a private repository the credential cannot see.
  // "That does not exist" sends an operator hunting for a deleted repository for an hour.
  const p = preflight(() => ({ status: 404, body: { message: 'Not Found' } }));
  const r = await p.run();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.error.nextStep.includes('GITHUB_TOKEN'), 'the token is the likely cause and must be named');
  assert.equal(p.stub.requests.length, 1);
});

test('a disabled workflow and a repository with Issues off warn, and the bot still starts', async () => {
  const p = preflight((req) => {
    const path = new URL(req.url).pathname;
    if (path === '/repos/o/r') return { status: 200, body: { full_name: 'o/r', has_issues: false } };
    if (path.startsWith('/repos/o/r/actions/workflows/')) return { status: 200, body: { state: 'disabled_manually' } };
    return { status: 200, body: { sha: 'a'.repeat(40) } };
  });
  const r = await p.run();
  assert.equal(r.ok, true, 'neither is a wrong value in the environment, so neither stops the boot');
  if (!r.ok) return;
  assert.equal(r.value.workflowState, 'disabled_manually');
  assert.equal(r.value.warnings.length, 2, 'and both are reported');
  assert.ok(r.value.warnings.some((w) => w.includes('Issues are disabled')));
  assert.ok(r.value.warnings.some((w) => w.includes('disabled_manually')));
});

test('an expiry header on a live response becomes a warning the operator can act on', async () => {
  const p = preflight(ok({ [TOKEN_EXPIRY_HEADER]: '2026-03-08 09:00:00 UTC' }));
  const r = await p.run();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.tokenExpiresAtMs, Date.parse('2026-03-08T09:00:00Z'));
  assert.equal(r.value.warnings.length, 1);
  assert.ok(r.value.warnings[0]?.includes('GITHUB_TOKEN expires in 7 day'));
});

test('a token with plenty of life left produces no warning at all', async () => {
  const p = preflight(ok({ [TOKEN_EXPIRY_HEADER]: '2026-09-01 09:00:00 UTC' }));
  const r = await p.run();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.warnings, []);
});

test('warnings reach BOTH channels, because one buried in JSON is one nobody reads', () => {
  // `main.ts` already prints its loud findings to stderr AND to the structured log — a
  // quarantine buried in JSON is a quarantine nobody notices, and an expiring credential is
  // exactly the same shape of finding.
  const warned: string[] = [];
  const said: string[] = [];
  const base = fakeLogger();
  const logger: LoggerPort = {
    ...base,
    warn: (msg: string, fields?: JsonObject) => warned.push(`${msg} ${JSON.stringify(fields ?? {})}`),
    child: () => logger,
  };
  const report: GithubPreflightReport = {
    fullName: 'o/r',
    workflowState: 'active',
    tokenExpiresAtMs: null,
    warnings: ['the sky is falling'],
    visibility: null,
  };
  logPreflightWarnings(report, logger, (line) => said.push(line));

  assert.equal(said.length, 1);
  assert.ok(said[0]?.includes('the sky is falling'), 'stderr, where an operator restarting the bot is looking');
  assert.equal(warned.length, 1);
  assert.ok(warned[0]?.includes('the sky is falling'), 'and the structured log, where an aggregator is');
});
