/**
 * Installation-token reuse and refresh (RFC-001 6.4 steps 3-4), in a file - and so a process -
 * of its own.
 *
 * WHY ITS OWN FILE: the only honest way to let an hour pass is to mock `Date`, because the
 * cache that decides reuse is auth-app's real LRU, keyed on `Date.now()`. But octokit's throttler
 * keeps MODULE-GLOBAL limiters that remember "next write not before <instant>"; a mocked clock in
 * one test poisons that instant for every later test in the same process (each then waits for a
 * time that never arrives, or arrives ten minutes late). `node --test` runs each file in its own
 * process, so this file cannot leak its clock into `app-auth.test.ts`.
 *
 * WHAT THIS PROVES: the engine implements no token cache of its own and needs none - the
 * bundled auth hook mints on first use, reuses while more than a minute remains, and mints a
 * fresh token before the hour is up.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { secret } from '#core/config';
import { operatorMessage } from '#core/errors';
import { manualClock } from '#adapters/system/clock';
import { fakeLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest } from '#testing/http';
import { startGithubAppSession } from '#adapters/github/app-auth';

const API = 'https://api.github.com';
const MINUTE = 60_000;
const PERMISSIONS = {
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

function path(r: RecordedRequest): string {
  return r.url.startsWith(API) ? r.url.slice(API.length).split('?')[0] ?? '' : r.url;
}

test('installation tokens are minted once, reused, and re-minted before the hour is up', async (t) => {
  // Ahead of the real clock, so no limiter state from module load can be in this clock's future.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * MINUTE });

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  let minted = 0;
  const stub = stubFetch((r) => {
    const route = `${r.method} ${path(r)}`;
    if (route === 'GET /app') return { status: 200, body: { slug: 'gw-builder' } };
    if (route === 'GET /repos/octo/demo/installation') {
      return { status: 200, body: { id: 777, repository_selection: 'selected', permissions: PERMISSIONS, account: { login: 'octo' } } };
    }
    if (route === 'POST /app/installations/777/access_tokens') {
      minted += 1;
      return {
        status: 201,
        body: { token: `ghs_${String(minted).repeat(36)}`, expires_at: new Date(Date.now() + 60 * MINUTE).toISOString() },
      };
    }
    return { status: 200, body: { name: 'AGENT_DAILY_RUN_CAP', value: '4' } };
  });

  const started = await startGithubAppSession({
    appId: 424242,
    privateKey: secret(typeof pem === 'string' ? pem : pem.toString('utf8')),
    installationId: null,
    repo: { owner: 'octo', repo: 'demo' },
    clock: manualClock(Date.now()),
    logger: fakeLogger(),
    fetch: stub.fetch,
  });
  assert.ok(started.ok, started.ok ? '' : operatorMessage(started.error));
  const octokit = started.value.octokit;
  const mints = () => stub.requests.filter((r) => r.method === 'POST' && path(r).endsWith('/access_tokens'));
  const lastAuth = () => stub.requests.at(-1)?.headers['authorization'];
  const read = () => octokit.request('GET /repos/{owner}/{repo}/actions/variables/{name}', { owner: 'octo', repo: 'demo', name: 'AGENT_DAILY_RUN_CAP' });

  assert.equal(mints().length, 0, 'building the installation client makes no request');

  await read();
  assert.equal(mints().length, 1, 'the first call mints a token');
  assert.equal(lastAuth(), `token ghs_${'1'.repeat(36)}`);
  assert.match(mints()[0]?.headers['authorization'] ?? '', /^bearer /u, 'the mint itself is authenticated with the App JWT');

  t.mock.timers.tick(58 * MINUTE);
  await read();
  assert.equal(mints().length, 1, 'a token is reused while it has more than a minute left');
  assert.equal(lastAuth(), `token ghs_${'1'.repeat(36)}`);

  t.mock.timers.tick(2 * MINUTE);
  await read();
  assert.equal(mints().length, 2, 'a fresh token is minted before the old one expires');
  assert.equal(lastAuth(), `token ghs_${'2'.repeat(36)}`);
});
