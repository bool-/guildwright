/**
 * GitHub App auth (RFC-001 PR 1.6), driven through a fake transport. Nothing here reaches the
 * network, and no real key is committed: every key is generated per run with `node:crypto`.
 *
 * WHAT IS ASSERTED, AND WHY EACH IS WORTH IT:
 *  - The JWT the bundled `@octokit/auth-app` signs is RS256, verifies against the generated
 *    public key, names the App, and lives at most 600 s. That is the one claim about signing
 *    this repo cannot make by reading its own code, because the signing is not its own code.
 *  - Every fatal boot answer produces its EXACT sentence: installation 404, key 401, missing
 *    permissions (each one named), `repository_selection: all`.
 *  - Tokens are minted once, REUSED, and minted again before the hour is up: see
 *    `app-auth-tokens.test.ts`, which needs a process of its own (it mocks `Date`).
 *  - An uninstall (token-mint 404) reaches a port as the uninstall sentence and is not retryable,
 *    and specifically does NOT read as the benign 404 the variable port maps to `unset`.
 *  - PAT mode still builds the same client, and now warns.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { test } from 'node:test';

import { isRetryable, operatorMessage, type AppError } from '#core/errors';
import { secret } from '#core/config';
import { Ok } from '#core/result';
import type { JsonObject } from '#core/json';
import { toGitRef, toWorkflowFile, type LoggerPort } from '#core/ports';
import { describeGithubAuth } from '#core/version';
import { manualClock } from '#adapters/system/clock';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';

import {
  missingAppPermissions,
  resolveGithubAuth,
  startGithubAppSession,
  type GithubAppSessionInput,
} from '#adapters/github/app-auth';
import { GITHUB_API_VERSION, GITHUB_USER_AGENT } from '#adapters/github/client';
import { PAT_MODE_WARNING, createGithubAdapter, type GithubAdapterInput } from '#adapters/github/index';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const APP_ID = 424242;
const INSTALLATION_ID = 777;
const SLUG = 'gw-builder';
const REPO = { owner: 'octo', repo: 'demo' } as const;
const API = 'https://api.github.com';
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const MINUTE = 60_000;

/** A throwaway key per run. PKCS#1, because that is what GitHub's settings page downloads. */
function freshKey(): { readonly pem: string; readonly publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  return { pem: typeof pem === 'string' ? pem : pem.toString('utf8'), publicKey };
}

const KEY = freshKey();

/** Exactly the 6.1 table, granted. */
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

function installation(over: Partial<{ permissions: Record<string, string>; repository_selection: string; account: string }> = {}) {
  return {
    id: INSTALLATION_ID,
    repository_selection: over.repository_selection ?? 'selected',
    permissions: over.permissions ?? { ...FULL_PERMISSIONS },
    account: { login: over.account ?? REPO.owner },
  };
}

function path(r: RecordedRequest): string {
  return r.url.startsWith(API) ? r.url.slice(API.length).split('?')[0] ?? '' : r.url;
}

/** Answers by route; `routes` overrides the happy path. Token N is `ghs_` + N repeated. */
function github(routes: Readonly<Record<string, (r: RecordedRequest) => StubResponse>> = {}) {
  let minted = 0;
  const happy: Record<string, (r: RecordedRequest) => StubResponse> = {
    'GET /app': () => ({ status: 200, body: { id: APP_ID, slug: SLUG, name: 'GW builder' } }),
    [`GET /repos/${REPO.owner}/${REPO.repo}/installation`]: () => ({ status: 200, body: installation() }),
    [`GET /app/installations/${INSTALLATION_ID}`]: () => ({ status: 200, body: installation() }),
    [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: () => {
      minted += 1;
      return {
        status: 201,
        body: {
          token: `ghs_${String(minted).repeat(36)}`,
          expires_at: new Date(Date.now() + 60 * MINUTE).toISOString(),
          permissions: { ...FULL_PERMISSIONS },
          repository_selection: 'selected',
        },
      };
    },
    [`GET /repos/${REPO.owner}/${REPO.repo}/actions/variables/AGENT_DAILY_RUN_CAP`]: () => ({
      status: 200,
      body: { name: 'AGENT_DAILY_RUN_CAP', value: '4' },
    }),
  };
  return stubFetch((r) => {
    const key = `${r.method} ${path(r)}`;
    const answer = routes[key] ?? happy[key];
    return answer === undefined ? { status: 599, body: { message: `unrouted ${key}` } } : answer(r);
  });
}

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: JsonObject;
}

function recordingLogger(lines: LogLine[]): LoggerPort {
  const at = (level: string) => (msg: string, fields: JsonObject = {}) => {
    lines.push({ level, msg, fields });
  };
  const self: LoggerPort = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => self };
  return self;
}

function sessionInput(fetchImpl: typeof globalThis.fetch, over: Partial<GithubAppSessionInput> = {}): GithubAppSessionInput {
  return {
    appId: APP_ID,
    privateKey: secret(KEY.pem),
    installationId: null,
    repo: REPO,
    clock: manualClock(NOW),
    logger: recordingLogger([]),
    fetch: fetchImpl,
    ...over,
  };
}

function adapterInput(fetchImpl: typeof globalThis.fetch, auth: GithubAdapterInput['auth'], logger: LoggerPort): GithubAdapterInput {
  const workflowFile = toWorkflowFile('agent-implement-request.yml');
  const ref = toGitRef('main');
  if (!workflowFile.ok || !ref.ok) throw new Error('fixture is invalid');
  return {
    auth,
    repo: REPO,
    clock: manualClock(NOW),
    logger,
    approvalHmacKey: secret('k'.repeat(48)),
    workflowFile: workflowFile.value,
    ref: ref.value,
    allowPublicTargetRepo: false,
    builder: null,
    engineVersion: '0.0.0-test',
    gateReference: Ok([]),
    fetch: fetchImpl,
  };
}

function expectConfig(error: AppError, location: string, internal: string, nextStep: string): void {
  assert.equal(error.kind, 'config');
  assert.equal(error.kind === 'config' ? error.location : '', location);
  assert.equal(error.internal, internal);
  assert.equal(error.nextStep, nextStep);
  assert.equal(isRetryable(error), false, 'a configuration problem is never retried');
}

function base64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------------------
// The JWT
// ---------------------------------------------------------------------------------------

test('the App JWT is RS256, verifies against the key, names the App, and lives at most 600 s', async () => {
  const stub = github();
  const started = await startGithubAppSession(sessionInput(stub.fetch));
  assert.ok(started.ok, started.ok ? '' : operatorMessage(started.error));

  const getApp = stub.requests.find((r) => r.method === 'GET' && path(r) === '/app');
  assert.ok(getApp !== undefined, 'GET /app must be the first thing the App asks');
  const authorization = getApp.headers['authorization'] ?? '';
  assert.match(authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/u, 'GET /app is authenticated with a JWT, not a token');
  const jwt = authorization.slice('bearer '.length);
  const [header = '', payload = '', signature = ''] = jwt.split('.');

  assert.deepEqual(base64urlJson(header), { alg: 'RS256', typ: 'JWT' });
  const claims = base64urlJson(payload);
  assert.ok(typeof claims === 'object' && claims !== null);
  const iat = Number(Reflect.get(claims, 'iat'));
  const exp = Number(Reflect.get(claims, 'exp'));
  assert.equal(Reflect.get(claims, 'iss'), APP_ID, 'the JWT names the App by its id');
  assert.ok(exp - iat <= 600, `GitHub refuses a JWT that lives longer than 10 minutes (got ${exp - iat} s)`);
  assert.ok(iat < Math.floor(Date.now() / 1000), 'iat is skewed into the past, against clock drift');
  assert.ok(
    verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), KEY.publicKey, Buffer.from(signature, 'base64url')),
    'the signature is made with the configured key',
  );
});

// ---------------------------------------------------------------------------------------
// The fatal boot answers, each with its exact sentence
// ---------------------------------------------------------------------------------------

test('an App that is not installed on the repository refuses to start, naming the installations URL', async () => {
  const stub = github({ [`GET /repos/${REPO.owner}/${REPO.repo}/installation`]: () => ({ status: 404, body: { message: 'Not Found' } }) });
  const started = await startGithubAppSession(sessionInput(stub.fetch));
  assert.ok(!started.ok);
  expectConfig(
    started.error,
    'github.app',
    'the GitHub App "gw-builder" (id 424242) is not installed on octo/demo',
    'Open https://github.com/apps/gw-builder/installations/new, pick octo/demo, then restart.',
  );
  assert.ok(
    !stub.requests.some((r) => path(r).endsWith('/access_tokens')),
    'no token is minted for an installation that does not exist',
  );
});

test('a key GitHub rejects (401 on GET /app) refuses to start with the RFC sentence', async () => {
  const stub = github({ 'GET /app': () => ({ status: 401, body: { message: 'A JSON web token could not be decoded' } }) });
  const started = await startGithubAppSession(sessionInput(stub.fetch));
  assert.ok(!started.ok);
  assert.equal(
    started.error.internal,
    'GITHUB_APP_PRIVATE_KEY does not belong to GitHub App 424242; download a new key from the App settings page',
  );
  assert.equal(stub.requests.length, 1, 'a rejected key is never retried and stops the boot at the first call');
});

test('missing and too-weak permissions refuse to start, naming EACH one in table order', async () => {
  const permissions = { ...FULL_PERMISSIONS, issues: 'read' };
  Reflect.deleteProperty(permissions, 'environments');
  Reflect.deleteProperty(permissions, 'secrets');
  const stub = github({
    [`GET /repos/${REPO.owner}/${REPO.repo}/installation`]: () => ({ status: 200, body: installation({ permissions }) }),
  });
  const started = await startGithubAppSession(sessionInput(stub.fetch));
  assert.ok(!started.ok);
  expectConfig(
    started.error,
    'github.app',
    'the GitHub App installation on octo/demo lacks: Issues (write), Environments (write), Secrets (read)',
    'Grant them under Settings -> GitHub Apps -> gw-builder -> Configure (accept the new permissions on the installation if GitHub asks), then restart.',
  );
});

test('the permission comparison: write covers read, admin covers write, and the full 6.1 set passes', () => {
  assert.deepEqual(missingAppPermissions(FULL_PERMISSIONS), []);
  assert.deepEqual(missingAppPermissions({ ...FULL_PERMISSIONS, contents: 'write', administration: 'admin' }), []);
  assert.deepEqual(missingAppPermissions({}).length, 9, 'every one of the nine 6.1 rows is required');
  assert.deepEqual(missingAppPermissions({ ...FULL_PERMISSIONS, actions_variables: 'none' }), ['Variables (read)']);
});

test('an installation on ALL repositories of the account refuses to start', async () => {
  const stub = github({
    [`GET /repos/${REPO.owner}/${REPO.repo}/installation`]: () => ({
      status: 200,
      body: installation({ repository_selection: 'all' }),
    }),
  });
  const started = await startGithubAppSession(sessionInput(stub.fetch));
  assert.ok(!started.ok);
  expectConfig(
    started.error,
    'github.app',
    'the GitHub App is installed on ALL repositories of octo; reinstall it on only the module repository.',
    'Change the installation to "Only select repositories" with just octo/demo selected, then restart.',
  );
});

test('GITHUB_APP_INSTALLATION_ID skips the lookup but NOT the checks', async () => {
  const stub = github({
    [`GET /app/installations/${INSTALLATION_ID}`]: () => ({ status: 200, body: installation({ repository_selection: 'all' }) }),
  });
  const started = await startGithubAppSession(sessionInput(stub.fetch, { installationId: INSTALLATION_ID }));
  assert.ok(!started.ok, 'a configured id must still be refused when the installation covers every repository');
  assert.match(started.error.internal ?? '', /installed on ALL repositories of octo/u);
  assert.ok(
    !stub.requests.some((r) => path(r) === `/repos/${REPO.owner}/${REPO.repo}/installation`),
    'the repository lookup is skipped',
  );
  assert.ok(stub.requests.some((r) => path(r) === `/app/installations/${INSTALLATION_ID}`), 'the installation is still read');
});

test('a configured installation id on a different account is refused', async () => {
  const stub = github({
    [`GET /app/installations/${INSTALLATION_ID}`]: () => ({ status: 200, body: installation({ account: 'someone-else' }) }),
  });
  const started = await startGithubAppSession(sessionInput(stub.fetch, { installationId: INSTALLATION_ID }));
  assert.ok(!started.ok);
  assert.equal(started.error.internal, 'GITHUB_APP_INSTALLATION_ID 777 is an installation on someone-else, not on octo');
});

test('a resolved installation is logged with its id and permissions', async () => {
  const lines: LogLine[] = [];
  const stub = github();
  const started = await startGithubAppSession(sessionInput(stub.fetch, { logger: recordingLogger(lines) }));
  assert.ok(started.ok);
  const resolved = lines.find((l) => l.msg === 'github app installation resolved');
  assert.ok(resolved !== undefined, 'the boot log says which installation the bot is running as');
  assert.equal(resolved.fields['installationId'], INSTALLATION_ID);
  assert.deepEqual(resolved.fields['permissions'], FULL_PERMISSIONS);
  assert.deepEqual(started.value.summary, { kind: 'app', slug: SLUG, appId: APP_ID, repo: 'octo/demo', installationId: INSTALLATION_ID });
  assert.equal(describeGithubAuth(started.value.summary), 'GitHub: app gw-builder on octo/demo, installation 777');
});

// ---------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------

test('App clients carry the same policy as a PAT client: pinned API version, one user agent', async () => {
  const stub = github();
  const started = await startGithubAppSession(sessionInput(stub.fetch));
  assert.ok(started.ok);
  await started.value.octokit.request('GET /repos/{owner}/{repo}/actions/variables/{name}', { ...REPO, name: 'AGENT_DAILY_RUN_CAP' });
  for (const r of stub.requests) {
    assert.equal(r.headers['x-github-api-version'], GITHUB_API_VERSION, `${r.method} ${path(r)} must carry the pin`);
    const agent = r.headers['user-agent'] ?? '';
    assert.ok(agent.startsWith(`${GITHUB_USER_AGENT} `), `${path(r)}: ${agent}`);
    assert.equal(agent.split(GITHUB_USER_AGENT).length, 2, `the product name appears once, not once per App hop: ${agent}`);
  }
});

test('an uninstalled App (token-mint 404) reaches a port as the uninstall sentence, not as "unset"', async () => {
  const stub = github({
    [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: () => ({ status: 404, body: { message: 'Not Found' } }),
  });
  const lines: LogLine[] = [];
  const adapter = await createGithubAdapter(
    adapterInput(stub.fetch, { kind: 'app', appId: APP_ID, privateKey: secret(KEY.pem), installationId: null }, recordingLogger(lines)),
  );
  assert.ok(adapter.ok, adapter.ok ? '' : operatorMessage(adapter.error));

  // THE PORT WHERE A RAW 404 IS BENIGN: without the rewrite this would be Ok({ kind: 'unset' }).
  const variable = await adapter.value.builds.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.ok(!variable.ok, 'an uninstall must not read as an unset variable');
  expectConfig(
    variable.error,
    'github.app',
    'the GitHub App gw-builder is no longer installed on octo/demo',
    'Reinstall the App on the module repository, then restart the bot.',
  );
  assert.equal(
    stub.requests.filter((r) => path(r).endsWith('/access_tokens')).length,
    1,
    'a 404 from the mint is not retried by the transport',
  );
  assert.ok(lines.some((l) => l.level === 'error' && l.msg === 'github app is no longer installed'));
});

// ---------------------------------------------------------------------------------------
// The adapter, both modes
// ---------------------------------------------------------------------------------------

test('PAT mode is unchanged and warns once at boot; /status shows its expiry after the preflight', async () => {
  const stub = stubFetch((r) => {
    const p = path(r);
    if (p === `/repos/${REPO.owner}/${REPO.repo}`) {
      return {
        status: 200,
        body: { full_name: 'octo/demo' },
        headers: { 'github-authentication-token-expiration': '2027-01-31 10:00:00 UTC' },
      };
    }
    if (p.includes('/actions/workflows/')) return { status: 200, body: { state: 'active' } };
    return { status: 200, body: {} };
  });
  const lines: LogLine[] = [];
  const pat = `github_pat_${'P'.repeat(40)}`;
  const adapter = await createGithubAdapter(adapterInput(stub.fetch, { kind: 'pat', token: secret(pat) }, recordingLogger(lines)));
  assert.ok(adapter.ok);
  assert.deepEqual(
    lines.filter((l) => l.level === 'warn').map((l) => l.msg),
    [PAT_MODE_WARNING],
  );
  assert.equal(
    PAT_MODE_WARNING,
    'running on a personal access token bound to one GitHub account; the template documents a GitHub App as the long-term setup',
  );
  assert.equal(stub.requests.length, 0, 'PAT mode makes no request before the preflight');

  const report = await adapter.value.preflight();
  assert.ok(report.ok);
  assert.equal(stub.requests[0]?.headers['authorization'], `token ${pat}`, 'the PAT is still sent as-is');
  assert.equal(describeGithubAuth(adapter.value.authSummary()), 'GitHub: PAT, expires 2027-01-31');
});

test('App mode: the adapter reports the App line, and the PAT warning is not logged', async () => {
  const lines: LogLine[] = [];
  const stub = github();
  const adapter = await createGithubAdapter(
    adapterInput(stub.fetch, { kind: 'app', appId: APP_ID, privateKey: secret(KEY.pem), installationId: null }, recordingLogger(lines)),
  );
  assert.ok(adapter.ok, adapter.ok ? '' : operatorMessage(adapter.error));
  assert.equal(describeGithubAuth(adapter.value.authSummary()), 'GitHub: app gw-builder on octo/demo, installation 777');
  assert.ok(!lines.some((l) => l.msg === PAT_MODE_WARNING));
});

test('a fatal App answer comes back from createGithubAdapter as the Err the root exits on', async () => {
  const stub = github({ [`GET /repos/${REPO.owner}/${REPO.repo}/installation`]: () => ({ status: 404, body: {} }) });
  const adapter = await createGithubAdapter(
    adapterInput(stub.fetch, { kind: 'app', appId: APP_ID, privateKey: secret(KEY.pem), installationId: null }, recordingLogger([])),
  );
  assert.ok(!adapter.ok);
  assert.match(adapter.error.internal ?? '', /is not installed on octo\/demo/u);
});

// ---------------------------------------------------------------------------------------
// The key file
// ---------------------------------------------------------------------------------------

test('GITHUB_APP_PRIVATE_KEY_FILE is read once into a Secret; an unreadable or non-PEM file is a config error', () => {
  const file = { kind: 'app', appId: APP_ID, privateKey: { kind: 'file', path: './secrets/app.pem' }, installationId: null } as const;

  const read = resolveGithubAuth(file, (p) => {
    assert.equal(p, './secrets/app.pem');
    return KEY.pem;
  });
  assert.ok(read.ok && read.value.kind === 'app');
  if (read.ok && read.value.kind === 'app') {
    assert.equal(JSON.stringify(read.value.privateKey), '"[redacted]"', 'the key is a Secret, never a string');
  }

  const missing = resolveGithubAuth(file, () => {
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  });
  assert.ok(!missing.ok);
  assert.equal(missing.error.kind === 'config' ? missing.error.location : '', 'GITHUB_APP_PRIVATE_KEY_FILE');
  assert.equal(missing.error.internal, 'cannot read the GitHub App private key at ./secrets/app.pem (ENOENT)');

  const notPem = resolveGithubAuth(file, () => 'hello');
  assert.ok(!notPem.ok);
  assert.equal(notPem.error.internal, './secrets/app.pem is not a PEM private key');
  assert.ok(!(notPem.error.internal ?? '').includes('hello'), 'the file contents are never echoed');
});

test('a key that cannot sign is refused before any request is made', async () => {
  const stub = github();
  const started = await startGithubAppSession(
    sessionInput(stub.fetch, { privateKey: secret('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n') }),
  );
  assert.ok(!started.ok);
  assert.match(started.error.internal ?? '', /^the private key could not sign a JWT for GitHub App 424242 \(/u);
  assert.equal(stub.requests.length, 0);
});

