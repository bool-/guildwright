/**
 * ONE ADAPTER PER CONFIGURED REPOSITORY (RFC-001 PR 2.1), driven through the real composition:
 * `GITHUB_REPOS_JSON` parsed by the real `loadConfig` rules, the real `createGithubRepoSet`, the
 * real per-repository `assembleGithubAdapter`, a stub transport for the client and the fake
 * GitHub seam for the containment probes.
 *
 * WHAT IS ASSERTED, AND WHY EACH IS WORTH IT:
 *  - Each repository's calls reach THAT repository, through `.at(ref)`, in PAT mode (one token
 *    for the whole set) and in App mode (one App, `GET /app` once, an installation looked up per
 *    repository, each repository's calls carrying its own installation's token).
 *  - The boot preflight runs for EVERY repository, and an App missing from one repository is a
 *    refusal naming that repository, after every repository was asked.
 *  - Isolation: a transient probe failure in one repository disables builds in THAT repository
 *    only; a refusal in one repository is that repository's answer, not its neighbour's.
 *  - The compatibility shim: the old `GITHUB_OWNER`/`GITHUB_REPO` env is a one-repository set
 *    whose adapter makes exactly the requests the single-repository adapter always made.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { githubRepoSet, secret, type GithubRepoConfig } from '#core/config';
import type { AppError } from '#core/errors';
import { Ok } from '#core/result';
import { userEnvironmentName, type RepoRef } from '#core/ports';
import { createRepoSet } from '#core/ports/repos';
import { toUserId } from '#core/ids';
import { fakeClock, fakeLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';
import { engineReference, fakeGithub, githubError, SHA_A, type FakeGithub } from '#testing/fixtures/github-fake';
import { createGithubRepoSet, type GithubRepoSet, type GithubRepoSetInput } from '#adapters/github/repo-set';
import { approvalSecretMissingError, unverifiedWarning } from '#adapters/github/containment';
import { appNotInstalledError } from '#adapters/github/app-auth';

const API = 'https://api.github.com';
const TOKEN = `github_pat_${'R'.repeat(40)}`;
const HMAC_KEY = 'h'.repeat(48);
const APP_ID = 515151;
const SLUG = 'set-builder';

const TWO_REPOS = JSON.stringify({
  main: { owner: 'acme', repo: 'bot-modules', default: true },
  events: { owner: 'acme', repo: 'events-modules', ref: 'trunk' },
});

/** The set exactly as `loadConfig` would build it from the env. */
function reposFrom(env: Readonly<Record<string, string>>): readonly GithubRepoConfig[] {
  const parsed = githubRepoSet(env);
  if (!('repos' in parsed)) throw new Error(`fixture env is invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.repos;
}

function path(r: RecordedRequest): string {
  return r.url.startsWith(API) ? r.url.slice(API.length).split('?')[0] ?? '' : r.url;
}

const FULL_PERMISSIONS: Readonly<Record<string, string>> = {
  metadata: 'read',
  issues: 'write',
  actions: 'write',
  pull_requests: 'read',
  contents: 'read',
  environments: 'write',
  administration: 'write',
  secrets: 'read',
  actions_variables: 'read',
};

/**
 * A GitHub that knows `acme/bot-modules` and `acme/events-modules`. `installations` maps a repo
 * name to its installation id (App mode); a repo left out answers the installation lookup 404.
 */
function github(installations: Readonly<Record<string, number>> = {}) {
  return stubFetch((r): StubResponse => {
    const p = path(r);
    const key = `${r.method} ${p}`;
    if (key === 'GET /app') return { status: 200, body: { id: APP_ID, slug: SLUG } };
    const inst = /^GET \/repos\/acme\/([^/]+)\/installation$/u.exec(key);
    if (inst !== null) {
      const id = installations[inst[1] ?? ''];
      return id === undefined
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 200, body: { id, repository_selection: 'selected', permissions: { ...FULL_PERMISSIONS }, account: { login: 'acme' } } };
    }
    const mint = /^POST \/app\/installations\/(\d+)\/access_tokens$/u.exec(key);
    if (mint !== null) {
      return {
        status: 201,
        body: { token: `ghs_${(mint[1] ?? '').repeat(36).slice(0, 36)}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { ...FULL_PERMISSIONS }, repository_selection: 'selected' },
      };
    }
    const repo = /^GET \/repos\/acme\/([^/]+)$/u.exec(key);
    if (repo !== null) return { status: 200, body: { full_name: `acme/${repo[1] ?? ''}`, private: true, has_issues: true } };
    if (/^GET \/repos\/acme\/[^/]+\/actions\/workflows\/[^/]+$/u.test(key)) return { status: 200, body: { state: 'active' } };
    if (/^GET \/repos\/acme\/[^/]+\/commits\/[^/]+$/u.test(key)) return { status: 200, body: { sha: SHA_A } };
    if (/^PATCH \/repos\/acme\/[^/]+\/issues\/\d+$/u.test(key)) return { status: 200, body: { number: 5 } };
    if (/^POST \/repos\/acme\/[^/]+\/actions\/runs\/\d+\/cancel$/u.test(key)) return { status: 202, body: {} };
    if (/^GET \/repos\/acme\/[^/]+\/environments\/[^/]+\/secrets$/u.test(key)) return { status: 200, body: { total_count: 0, secrets: [] } };
    return { status: 599, body: { message: `unrouted ${key}` } };
  });
}

function input(
  repos: readonly GithubRepoConfig[],
  transport: ReturnType<typeof stubFetch>,
  over: Partial<GithubRepoSetInput> = {},
): GithubRepoSetInput {
  return {
    auth: { kind: 'pat', token: secret(TOKEN) },
    repos,
    clock: fakeClock(),
    logger: fakeLogger(),
    approvalHmacKey: secret(HMAC_KEY),
    allowPublicTargetRepo: false,
    builder: null,
    engineVersion: '2.1.0-test',
    gateReference: () => Ok(engineReference()),
    fetch: transport.fetch,
    ...over,
  };
}

async function created(i: GithubRepoSetInput): Promise<GithubRepoSet> {
  const made = await createGithubRepoSet(i);
  assert.ok(made.ok, made.ok ? '' : made.error.map((e) => e.internal).join(' | '));
  if (!made.ok) throw new Error('unreachable');
  return made.value;
}

function refOf(set: GithubRepoSet, key: string): RepoRef {
  const ref = set.repos.byKey(key);
  assert.ok(ref !== null, `${key} must be configured`);
  if (ref === null) throw new Error('unreachable');
  return ref;
}

function paths(t: ReturnType<typeof stubFetch>, pattern: RegExp): readonly string[] {
  return t.requests.map((r) => `${r.method} ${path(r)}`).filter((k) => pattern.test(k));
}

const userEnv = (() => {
  const id = toUserId('123456789012345678');
  if (!id.ok) throw new Error('fixture');
  const env = userEnvironmentName(id.value);
  if (!env.ok) throw new Error('fixture');
  return env.value;
})();

// ---------------------------------------------------------------------------------------
// Routing: every call reaches its own repository
// ---------------------------------------------------------------------------------------

test('PAT mode, two repositories: .at(ref) routes each port call to that repository, on ONE token', async () => {
  const transport = github();
  const set = await created(input(reposFrom({ GITHUB_TOKEN: TOKEN, GITHUB_REPOS_JSON: TWO_REPOS }), transport));
  const main = refOf(set, 'main');
  const events = refOf(set, 'events');

  const issuesMain = set.issues.at(main);
  const issuesEvents = set.issues.at(events);
  const buildsEvents = set.builds.at(events);
  const secretsMain = set.secrets.at(main);
  assert.ok(issuesMain.ok && issuesEvents.ok && buildsEvents.ok && secretsMain.ok);
  if (!issuesMain.ok || !issuesEvents.ok || !buildsEvents.ok || !secretsMain.ok) return;
  assert.notEqual(issuesMain.value, issuesEvents.value, 'one port per repository, not one shared port');

  assert.ok((await issuesMain.value.close(5, 'not_planned')).ok);
  assert.ok((await issuesEvents.value.close(6, 'not_planned')).ok);
  assert.ok((await buildsEvents.value.cancelRun(9)).ok);
  assert.ok((await secretsMain.value.list(userEnv)).ok);

  assert.deepEqual(paths(transport, /^(PATCH|POST|GET) \/repos\/acme\/[^/]+\/(issues|actions\/runs|environments)\//u), [
    'PATCH /repos/acme/bot-modules/issues/5',
    'PATCH /repos/acme/events-modules/issues/6',
    'POST /repos/acme/events-modules/actions/runs/9/cancel',
    `GET /repos/acme/bot-modules/environments/${userEnv}/secrets`,
  ]);
  // ONE token across the set (RFC-001 6.6): every request carries the same credential.
  assert.deepEqual([...new Set(transport.requests.map((r) => r.headers['authorization']))], [`token ${TOKEN}`]);
  assert.equal(set.authSummaries().length, 1, 'one PAT, one /status line');
});

test('App mode, two repositories: GET /app ONCE, an installation per repository, and each repository calls with its own token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const transport = github({ 'bot-modules': 11, 'events-modules': 22 });
  const set = await created(
    input(reposFrom({ GITHUB_APP_ID: String(APP_ID), GITHUB_REPOS_JSON: TWO_REPOS }), transport, {
      auth: { kind: 'app', appId: APP_ID, privateKey: secret(pem) },
    }),
  );

  assert.equal(paths(transport, /^GET \/app$/u).length, 1, 'one App: its key is checked once, whatever the set size');
  assert.deepEqual(paths(transport, /\/installation$/u), ['GET /repos/acme/bot-modules/installation', 'GET /repos/acme/events-modules/installation']);

  const main = set.issues.at(refOf(set, 'main'));
  const events = set.issues.at(refOf(set, 'events'));
  assert.ok(main.ok && events.ok);
  if (!main.ok || !events.ok) return;
  assert.ok((await main.value.close(1, 'not_planned')).ok);
  assert.ok((await events.value.close(2, 'not_planned')).ok);

  const auth = (p: string): string | undefined => transport.requests.find((r) => path(r) === p)?.headers['authorization'];
  assert.equal(auth('/repos/acme/bot-modules/issues/1'), `token ghs_${'11'.repeat(18)}`, 'main uses installation 11');
  assert.equal(auth('/repos/acme/events-modules/issues/2'), `token ghs_${'22'.repeat(18)}`, 'events uses installation 22');
  assert.deepEqual(
    set.authSummaries(),
    [
      { kind: 'app', slug: SLUG, appId: APP_ID, repo: 'acme/bot-modules', installationId: 11 },
      { kind: 'app', slug: SLUG, appId: APP_ID, repo: 'acme/events-modules', installationId: 22 },
    ],
  );
});

test('App mode: an App missing from ONE repository refuses naming that repository, after every repository was asked', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const transport = github({ 'bot-modules': 11 });
  const made = await createGithubRepoSet(
    input(reposFrom({ GITHUB_APP_ID: String(APP_ID), GITHUB_REPOS_JSON: TWO_REPOS }), transport, {
      auth: { kind: 'app', appId: APP_ID, privateKey: secret(pem) },
    }),
  );
  assert.ok(!made.ok);
  if (made.ok) return;
  const expected: AppError = appNotInstalledError(SLUG, APP_ID, { owner: 'acme', repo: 'events-modules' });
  assert.deepEqual(made.error, [expected]);
  assert.equal(paths(transport, /\/installation$/u).length, 2);
});

test('.at() refuses a ref this set did not mint, even one equal in every field', async () => {
  const set = await created(input(reposFrom({ GITHUB_TOKEN: TOKEN, GITHUB_REPOS_JSON: TWO_REPOS }), github()));
  const foreign = createRepoSet([{ key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: true }]);
  assert.ok(foreign.ok);
  if (!foreign.ok) return;
  const ref = foreign.value.refs[0];
  assert.ok(ref !== undefined);
  if (ref === undefined) return;
  const answered = set.builds.at(ref);
  assert.ok(!answered.ok, 'routing by identity: a look-alike ref reaches no repository');
  assert.equal(answered.ok ? '' : answered.error.code, 'config.repos');
});

// ---------------------------------------------------------------------------------------
// Per-repository preflight
// ---------------------------------------------------------------------------------------

/** Two repositories with the build-path probes on, each answered by its own fake GitHub. */
async function bootTwo(ghMain: FakeGithub, ghEvents: FakeGithub) {
  const transport = github();
  const set = await created(
    input(reposFrom({ GITHUB_TOKEN: TOKEN, GITHUB_REPOS_JSON: TWO_REPOS }), transport, {
      builder: { requireOwnCredentials: true },
      probeRequest: (r) => (r.key === 'main' ? ghMain.request : ghEvents.request),
    }),
  );
  return { set, transport, preflights: await set.preflight() };
}

test('the preflight runs for EVERY configured repository, each with its own ref and workflow', async () => {
  const ghMain = fakeGithub();
  const ghEvents = fakeGithub();
  const { transport, preflights } = await bootTwo(ghMain, ghEvents);
  assert.deepEqual(
    preflights.map((p) => [p.ref.key, p.result.ok ? p.result.value.fullName : 'refused']),
    [
      ['main', 'acme/bot-modules'],
      ['events', 'acme/events-modules'],
    ],
  );
  assert.deepEqual(paths(transport, /\/commits\//u), ['GET /repos/acme/bot-modules/commits/main', 'GET /repos/acme/events-modules/commits/trunk']);
  // Each repository's containment probes and gate check ran against ITS OWN GitHub.
  for (const gh of [ghMain, ghEvents]) {
    assert.equal(gh.count('secret'), 1);
    assert.equal(gh.count('environments'), 1);
    assert.ok(gh.count('contents') >= 3, 'the three gate files were read');
  }
});

test('ISOLATION: a transient probe failure in one repository disables builds THERE, and only there', async () => {
  const ghMain = fakeGithub();
  const ghEvents = fakeGithub();
  ghEvents.fail.set('secret', githubError(503));
  const { set, preflights } = await bootTwo(ghMain, ghEvents);

  assert.ok(preflights.every((p) => p.result.ok), 'a GitHub blip never refuses to start');
  const events = preflights.find((p) => p.ref.key === 'events');
  assert.ok(events?.result.ok && events.result.value.warnings.includes(unverifiedWarning('approval-secret', 'acme/events-modules', 503)));

  const readiness = (key: string) => {
    const b = set.builds.at(refOf(set, key));
    return b.ok ? b.value.readiness().status : 'missing';
  };
  assert.equal(readiness('main'), 'ready', 'the healthy repository keeps building');
  assert.equal(readiness('events'), 'down', 'the repository GitHub could not answer for is down');
});

test('ISOLATION: a refusal in one repository is THAT repository\'s answer; its neighbour still passes', async () => {
  const ghMain = fakeGithub();
  const ghEvents = fakeGithub();
  ghEvents.state.approvalSecret = false;
  const { preflights } = await bootTwo(ghMain, ghEvents);
  const [main, events] = preflights;
  assert.ok(main?.result.ok, 'main is fine');
  assert.ok(events !== undefined && !events.result.ok);
  if (events === undefined || events.result.ok) return;
  assert.deepEqual(events.result.error, approvalSecretMissingError('acme/events-modules'));
});

// ---------------------------------------------------------------------------------------
// The compatibility shim
// ---------------------------------------------------------------------------------------

test('SHIM: GITHUB_OWNER/GITHUB_REPO is a one-repository set whose adapter makes the requests it always made', async () => {
  const transport = stubFetch((r): StubResponse => {
    const key = `${r.method} ${path(r)}`;
    if (key === 'GET /repos/o/r') return { status: 200, body: { full_name: 'o/r', private: true, has_issues: true } };
    if (key === 'GET /repos/o/r/actions/workflows/agent-implement-request.yml') return { status: 200, body: { state: 'active' } };
    if (key === 'GET /repos/o/r/commits/main') return { status: 200, body: { sha: SHA_A } };
    return { status: 599, body: { message: `unrouted ${key}` } };
  });
  const repos = reposFrom({ GITHUB_TOKEN: TOKEN, GITHUB_OWNER: 'o', GITHUB_REPO: 'r' });
  const set = await created(input(repos, transport));
  assert.deepEqual(set.repos.all().map((r) => [r.key, r.owner, r.repo, r.isDefault]), [['default', 'o', 'r', true]]);
  const preflights = await set.preflight();
  assert.equal(preflights.length, 1);
  assert.ok(preflights[0]?.result.ok);
  assert.deepEqual(
    transport.requests.map((r) => `${r.method} ${path(r)}`),
    ['GET /repos/o/r', 'GET /repos/o/r/actions/workflows/agent-implement-request.yml', 'GET /repos/o/r/commits/main'],
    'exactly the three phase-1 preflight reads, and nothing for a second repository',
  );
});
