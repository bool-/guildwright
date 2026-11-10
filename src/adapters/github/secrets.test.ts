/**
 * The credential-writing suite.
 *
 * THE ONLY ASSERTION THAT PROVES THE ENCRYPTION IS THE ONE THAT DECRYPTS. GitHub answers 201
 * to any well-formed base64 body without ever checking that it decrypts, so a test that asserts
 * on the response status - or on the length of the base64, or on it "looking encrypted" - passes
 * on garbage. Garbage then surfaces as an opaque auth failure half an hour later inside a
 * different user's build. So the wire tests below take the body the adapter actually sent, open
 * it with libsodium's own `crypto_box_seal_open` under the test's private key, and compare the
 * plaintext.
 *
 * The second thing being proven is negative and just as important: the credential appears in
 * NOTHING except that sealed box. Not in a URL, not in a header, not in a log field, and not in
 * any `AppError` this adapter can construct - user-facing or operator-facing. The canary used
 * throughout is deliberately a value `redactSecrets` does NOT match, so a passing test means the
 * adapter never touched it rather than that something scrubbed it afterwards.
 *
 * Nothing here reaches the network: the real client is driven through an injected transport.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import sodium from 'libsodium-wrappers';
import {
  PUBLIC_KEY_TTL_MS,
  createGithubSecrets,
  mapSecretsError,
  sealSecret,
  type SecretPublicKey,
} from '#adapters/github/secrets';
import { createGithubClient } from '#adapters/github/client';
import { operatorMessage, userMessage, type AppError } from '#core/errors';
import { secret } from '#core/config';
import { toEnvironmentName, type EnvironmentName } from '#core/ports/secrets';
import { fakeClock, fakeLogger, fakeRecordingLogger } from '#testing/fakes';
import { stubFetch, type RecordedRequest, type StubResponse } from '#testing/http';

const TOKEN = `ghp_${'D'.repeat(36)}`;
const NOW = 1_700_000_000_000;

/**
 * A real GitHub `key_id`, and the reason it is a string everywhere.
 * 3380204578043523366 > Number.MAX_SAFE_INTEGER (9007199254740991), so a round trip through a
 * JSON number would silently change the last digits and store the secret under a key id that
 * does not exist.
 */
const KEY_ID = '3380204578043523366';

/**
 * THE CANARY. Chosen so `redactSecrets` does NOT match it (it is not `sk-ant-`, not `ghp_`, not
 * 64 hex): every assertion of its absence therefore proves the adapter never put the value
 * anywhere, rather than proving a scrubber ran afterwards.
 */
const CANARY = 'CANARY-plaintext-value-9f3a-do-not-leak';

/**
 * The shortest run that counts as a disclosure, and the scan that looks for it.
 *
 * `includes(CANARY)` alone only fails for a COMPLETE disclosure. An error or a log line that
 * echoed the first twenty characters - which is what a truncated upstream body produces - passed
 * it, and a leading fragment of a credential is both a partial disclosure and a fingerprint that
 * confirms a guess. Sliding a window means no disclosure of this length or longer can pass,
 * wherever in the value it starts.
 */
const MEANINGFUL_RUN = 12;

function traces(haystack: string, value: string): readonly string[] {
  const hits: string[] = [];
  for (let i = 0; i + MEANINGFUL_RUN <= value.length; i += 1) {
    const window = value.slice(i, i + MEANINGFUL_RUN);
    if (haystack.includes(window)) hits.push(`offset ${i}: ${JSON.stringify(window)}`);
  }
  return hits;
}

/** A realistic credential, for the paths where the shape matters. */
const REAL_KEY = `sk-ant-api03-${'x'.repeat(95)}`;

function env(name: string): EnvironmentName {
  const parsed = toEnvironmentName(name);
  if (!parsed.ok) throw new Error(`test fixture is not an environment name: ${name}`);
  return parsed.value;
}

const USER_ENV = env('user-123456789012345678');

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

interface Keypair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

async function keypair(): Promise<Keypair> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

function publicKeyBase64(kp: Keypair): string {
  return sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
}

/** Open what the adapter actually sent. This is the only proof the ciphertext is correct. */
function openSealed(kp: Keypair, armoured: string): string {
  const sealed = sodium.from_base64(armoured, sodium.base64_variants.ORIGINAL);
  return sodium.to_string(sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey));
}

function harness(responder: (req: RecordedRequest, callIndex: number) => StubResponse) {
  const clock = fakeClock(NOW);
  const stub = stubFetch(responder);
  const octokit = createGithubClient({ token: secret(TOKEN), logger: fakeLogger(), fetch: stub.fetch });
  const port = createGithubSecrets({
    octokit,
    repo: { owner: 'o', repo: 'r' },
    clock,
    logger: fakeLogger(),
  });
  return { port, stub, clock };
}

/** The happy path: a public key, then 201 for any write, 204 for any delete. */
function happy(kp: Keypair, over?: (req: RecordedRequest) => StubResponse | null) {
  return (req: RecordedRequest): StubResponse => {
    const custom = over?.(req);
    if (custom !== null && custom !== undefined) return custom;
    if (req.url.endsWith('/secrets/public-key')) {
      return { status: 200, body: { key_id: KEY_ID, key: publicKeyBase64(kp) } };
    }
    if (req.method === 'DELETE') return { status: 204 };
    if (req.method === 'PUT' && req.url.includes('/secrets/')) return { status: 201, body: {} };
    if (req.method === 'PUT') return { status: 200, body: { name: 'user-123456789012345678' } };
    if (req.url.endsWith('/secrets')) {
      return { status: 200, body: { total_count: 1, secrets: [{ name: 'ANTHROPIC_API_KEY' }] } };
    }
    return { status: 200, body: {} };
  };
}

function putBody(stub: { readonly requests: readonly RecordedRequest[] }): { encrypted_value: string; key_id: string } {
  const req = stub.requests.find((r) => r.method === 'PUT' && r.url.includes('/secrets/'));
  assert.ok(req !== undefined, 'expected a secret write');
  assert.ok(req.body !== null, 'the write must carry a body');
  const parsed: unknown = JSON.parse(req.body);
  const value = (parsed as { encrypted_value?: unknown }).encrypted_value;
  const id = (parsed as { key_id?: unknown }).key_id;
  assert.equal(typeof value, 'string');
  assert.equal(typeof id, 'string');
  return { encrypted_value: value as string, key_id: id as string };
}

// ---------------------------------------------------------------------------------------
// Sealing - the part that cannot be verified by a status code
// ---------------------------------------------------------------------------------------

test('sealSecret produces a sealed box libsodium can open', async () => {
  const kp = await keypair();
  const publicKey: SecretPublicKey = { keyId: KEY_ID, keyBase64: publicKeyBase64(kp) };

  for (const plaintext of ['', 'a', REAL_KEY, 'ünïcödé 🔐', 'x'.repeat(4096)]) {
    const armoured = await sealSecret(plaintext, publicKey);
    const sealed = sodium.from_base64(armoured, sodium.base64_variants.ORIGINAL);

    // 32-byte ephemeral public key + 16-byte Poly1305 tag over the UTF-8 plaintext.
    assert.equal(sealed.length, Buffer.byteLength(plaintext, 'utf8') + 48);
    assert.equal(openSealed(kp, armoured), plaintext);
  }
});

test('sealSecret is non-deterministic, so a changed ciphertext is not a changed credential', async () => {
  const kp = await keypair();
  const publicKey: SecretPublicKey = { keyId: KEY_ID, keyBase64: publicKeyBase64(kp) };
  const a = await sealSecret(REAL_KEY, publicKey);
  const b = await sealSecret(REAL_KEY, publicKey);
  assert.notEqual(a, b, 'a fresh ephemeral keypair per call is what makes this safe');
  assert.equal(openSealed(kp, a), REAL_KEY);
  assert.equal(openSealed(kp, b), REAL_KEY);
});

test('sealSecret emits standard base64, never base64url', async () => {
  const kp = await keypair();
  const publicKey: SecretPublicKey = { keyId: KEY_ID, keyBase64: publicKeyBase64(kp) };
  // `sodium.to_base64` DEFAULTS to URLSAFE_NO_PADDING, which GitHub rejects, so omitting the
  // variant argument is a silent wrong-answer bug. 200 rounds makes a `+` or `/` a certainty.
  let sawUrlUnsafe = false;
  for (let i = 0; i < 200; i += 1) {
    const out = await sealSecret(REAL_KEY, publicKey);
    assert.match(out, /^[A-Za-z0-9+/]+={0,2}$/u, 'GitHub rejects the base64url alphabet');
    if (/[+/]/u.test(out)) sawUrlUnsafe = true;
  }
  assert.ok(sawUrlUnsafe, 'expected the standard alphabet to actually show up');
});

// ---------------------------------------------------------------------------------------
// put - end to end through the real client
// ---------------------------------------------------------------------------------------

test('what GitHub receives decrypts to exactly what the user typed', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));

  const result = await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  assert.equal(result.ok, true);

  const body = putBody(stub);
  assert.equal(openSealed(kp, body.encrypted_value), REAL_KEY);
});

test('key_id survives as a decimal string, not a corrupted number', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));
  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));

  const body = putBody(stub);
  assert.equal(body.key_id, KEY_ID);
  // The proof that nothing round-tripped it through a JS number on the way.
  assert.notEqual(body.key_id, String(Number(KEY_ID)));
  assert.ok(Number(KEY_ID) > Number.MAX_SAFE_INTEGER, 'the fixture must actually exceed 2^53');
});

test('the write goes to this environment and this secret name', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));
  await port.put(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', secret(REAL_KEY));

  const write = stub.requests.find((r) => r.method === 'PUT');
  assert.ok(write !== undefined);
  assert.ok(
    write.url.endsWith('/repos/o/r/environments/user-123456789012345678/secrets/CLAUDE_CODE_OAUTH_TOKEN'),
    `unexpected write url: ${write.url}`,
  );
});

test('THE LEAK CHECK: the plaintext appears in no request the adapter makes', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));
  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(CANARY));

  for (const req of stub.requests) {
    const whole = `${req.method} ${req.url} ${JSON.stringify(req.headers)} ${req.body ?? ''}`;
    assert.ok(!whole.includes(CANARY), `the credential reached the wire in clear: ${req.method} ${req.url}`);
  }
  // ...and it is genuinely in there, sealed - so the assertion above is not passing because
  // nothing was sent at all.
  assert.equal(openSealed(kp, putBody(stub).encrypted_value), CANARY);
});

// ---------------------------------------------------------------------------------------
// The public-key cache
// ---------------------------------------------------------------------------------------

test('the public key is fetched once for a burst of writes', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));

  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  await port.put(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', secret(REAL_KEY));

  const keyReads = stub.requests.filter((r) => r.url.endsWith('/secrets/public-key'));
  assert.equal(keyReads.length, 1, 'a modal submission must not cost two round trips per write');
});

test('the cached key expires, so a rotated environment heals without a restart', async () => {
  const kp = await keypair();
  const { port, stub, clock } = harness(happy(kp));

  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  clock.set(NOW + PUBLIC_KEY_TTL_MS + 1);
  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));

  assert.equal(stub.requests.filter((r) => r.url.endsWith('/secrets/public-key')).length, 2);
});

test('each environment gets its own key, never another environment’s', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));

  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  await port.put(env('ai-agent'), 'ANTHROPIC_API_KEY', secret(REAL_KEY));

  const keyReads = stub.requests.filter((r) => r.url.endsWith('/secrets/public-key'));
  assert.equal(keyReads.length, 2, 'the cache must be keyed by environment');
  assert.ok(keyReads[0]?.url.includes('/environments/user-123456789012345678/'));
  assert.ok(keyReads[1]?.url.includes('/environments/ai-agent/'));
});

test('deleting an environment forgets its cached key', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));

  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  await port.deleteEnvironment(USER_ENV);
  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));

  // A recreated environment has a NEW key id, and a stale one is accepted with a 201 and fails
  // invisibly inside a build - the one failure mode GitHub will not report.
  assert.equal(stub.requests.filter((r) => r.url.endsWith('/secrets/public-key')).length, 2);
});

test('a rejected write forgets the cached key rather than repeating it', async () => {
  const kp = await keypair();
  let failNext = true;
  const { port, stub } = harness(
    happy(kp, (req) => {
      if (req.method === 'PUT' && req.url.includes('/secrets/') && failNext) {
        failNext = false;
        return { status: 422, body: { message: 'Validation Failed' } };
      }
      return null;
    }),
  );

  const first = await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  assert.equal(first.ok, false);
  const second = await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  assert.equal(second.ok, true);

  assert.equal(stub.requests.filter((r) => r.url.endsWith('/secrets/public-key')).length, 2);
});

// ---------------------------------------------------------------------------------------
// The other four methods
// ---------------------------------------------------------------------------------------

test('ensureEnvironment is a create-or-update that sends no protection rules', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));

  assert.equal((await port.ensureEnvironment(USER_ENV)).ok, true);
  assert.equal((await port.ensureEnvironment(USER_ENV)).ok, true, 'must be idempotent');

  const puts = stub.requests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 2);
  for (const p of puts) {
    assert.ok(p.url.endsWith('/repos/o/r/environments/user-123456789012345678'), `unexpected url: ${p.url}`);
    // An empty body here would RESET reviewers, wait timers and branch policies an operator
    // configured by hand, so the request must carry none of those fields.
    const body = p.body ?? '';
    assert.ok(!body.includes('reviewers'), 'must not touch reviewers');
    assert.ok(!body.includes('deployment_branch_policy'), 'must not touch branch policy');
    assert.ok(!body.includes('wait_timer'), 'must not touch the wait timer');
  }
  // No pre-read: create-or-update is idempotent by GitHub's own contract, so a GET would only
  // add a race.
  assert.equal(stub.requests.filter((r) => r.method === 'GET').length, 0);
});

test('list returns names and nothing else', async () => {
  const kp = await keypair();
  const { port, stub } = harness(
    happy(kp, (req) =>
      req.url.endsWith('/secrets')
        ? {
            status: 200,
            body: {
              total_count: 2,
              secrets: [
                { name: 'ANTHROPIC_API_KEY', created_at: '2026-09-01T00:00:00Z' },
                { name: 'SOMETHING_AN_OPERATOR_SET' },
              ],
            },
          }
        : null,
    ),
  );

  const listed = await port.list(USER_ENV);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.exists, true);
  // The operator's own secret is reported too: silently dropping names the bot does not manage
  // would make this the least trustworthy debugging tool in the product.
  assert.deepEqual([...listed.value.names], ['ANTHROPIC_API_KEY', 'SOMETHING_AN_OPERATOR_SET']);
  assert.ok(stub.requests.every((r) => r.method === 'GET'), 'listing must not write');
});

// ---------------------------------------------------------------------------------------
// GITHUB'S TWO 404s, WHICH ARE THE SAME 404
// ---------------------------------------------------------------------------------------
//
// `.../environments/{env}/secrets` answers 404 both for "no such environment" - the ordinary
// state of everyone who has never run `/credentials set` - and for "this token cannot see this
// repository", which GitHub reports as 404 rather than 403 on a private repo, on purpose.
//
// Collapsing them is wrong in opposite directions, and both directions have shipped: reporting
// absence as an error sent the MAJORITY case off to bother an admin, and reporting a permission
// failure as absence tells somebody whose credential IS stored that it is not, forever, while
// they paste it again. So the adapter probes the repository's environment LISTING - a route with
// no per-environment existence precondition - and reads its STATUS CODE only.
//
// Every affected method is pinned on both sides below.

/** 404 one environment-scoped route, and steer the probe's answer separately. */
function splitHarness(kp: Keypair, route: (req: RecordedRequest) => boolean, probeStatus: number) {
  return harness(
    happy(kp, (req) => {
      if (isProbe(req)) {
        return probeStatus === 200 ? { status: 200, body: [] } : { status: probeStatus, body: { message: 'Not Found' } };
      }
      return route(req) ? { status: 404, body: { message: 'Not Found' } } : null;
    }),
  );
}

/** The repository-wide environment listing, with or without its `per_page` query. */
const isProbe = (req: RecordedRequest): boolean => /\/repos\/o\/r\/environments(\?|$)/u.test(req.url);
const isSecretsList = (req: RecordedRequest): boolean => req.method === 'GET' && req.url.endsWith('/secrets');
const isSecretDelete = (req: RecordedRequest): boolean => req.method === 'DELETE' && req.url.includes('/secrets/');
const isEnvDelete = (req: RecordedRequest): boolean => req.method === 'DELETE' && !req.url.includes('/secrets/');

test('a 404 on an environment the token CAN reach is absence, not an error', async () => {
  const kp = await keypair();
  const { port } = splitHarness(kp, isSecretsList, 200);

  const listed = await port.list(USER_ENV);
  // The majority case. `/credentials status` for somebody who has never stored anything must be
  // an answer, not "ask an admin to check the token repository access".
  assert.equal(listed.ok, true, 'a user who has stored nothing is not an error');
  if (!listed.ok) return;
  assert.equal(listed.value.exists, false);
  assert.deepEqual([...listed.value.names], []);
});

test('a 404 the token CANNOT explain is still an error, never "you have stored nothing"', async () => {
  const kp = await keypair();
  // The probe fails too, so it is the REPOSITORY this token cannot reach, not the environment.
  // Reading that as an empty list is what has a user re-pasting a credential already stored.
  const { port } = splitHarness(kp, isSecretsList, 404);

  const listed = await port.list(USER_ENV);
  assert.equal(listed.ok, false, 'a permission failure must not be laundered into absence');
  if (listed.ok) return;
  // The admin's hint names the token - in the LOG. The user is told to ask an admin, not handed a variable name.
  assert.ok(operatorMessage(listed.error).includes('GITHUB_TOKEN'));
  assert.ok(!userMessage(listed.error).includes('GITHUB_TOKEN'));
});

test('a 403 is never probed: it is already an answer, and it names Environments', async () => {
  const kp = await keypair();
  const { port, stub } = harness(
    happy(kp, (req) => (isSecretsList(req) ? { status: 403, body: { message: 'Forbidden' } } : null)),
  );

  const listed = await port.list(USER_ENV);
  assert.equal(listed.ok, false);
  if (listed.ok) return;
  assert.ok(operatorMessage(listed.error).includes('Environments'), 'the 403 sentence must survive the 404 splitting');
  assert.equal(
    stub.requests.filter(isProbe).length,
    0,
    'a 403 is unambiguous, so it must not cost an extra round trip',
  );
});

test('deleteEnvironment distinguishes "removed" from "there was nothing there"', async () => {
  const kp = await keypair();

  const present = harness(happy(kp));
  const removed = await present.port.deleteEnvironment(USER_ENV);
  assert.equal(removed.ok && removed.value, true, 'a 204 means it existed and is gone');

  const missing = splitHarness(kp, isEnvDelete, 200);
  const nothing = await missing.port.deleteEnvironment(USER_ENV);
  // `/credentials clear` for a user who never stored anything is a normal request with a normal
  // answer. This is also the rollback path for a half-finished `/credentials set`.
  assert.equal(nothing.ok, true, '"nothing to remove" is an answer, not a failure');
  assert.equal(nothing.ok && nothing.value, false);

  const broken = splitHarness(kp, isEnvDelete, 403);
  assert.equal((await broken.port.deleteEnvironment(USER_ENV)).ok, false, 'but a token problem is still a failure');
});

test('remove distinguishes "removed" from "there was nothing there"', async () => {
  const kp = await keypair();

  const present = harness(happy(kp));
  const removed = await present.port.remove(USER_ENV, 'ANTHROPIC_API_KEY');
  assert.equal(removed.ok && removed.value, true);

  const missing = splitHarness(kp, isSecretDelete, 200);
  const nothing = await missing.port.remove(USER_ENV, 'ANTHROPIC_API_KEY');
  assert.equal(nothing.ok, true);
  assert.equal(nothing.ok && nothing.value, false);

  const broken = splitHarness(kp, isSecretDelete, 404);
  assert.equal((await broken.port.remove(USER_ENV, 'ANTHROPIC_API_KEY')).ok, false);
});

test('the probe reads the STATUS ONLY, never the paginated body', async () => {
  const kp = await keypair();
  // The listing is paginated (30 per page). A decision that read the body and looked for the
  // environment by name would report "you have stored nothing" for any environment that is
  // simply not on the page we got - the exact failure the probe exists to prevent. So an EMPTY
  // page must still count as "this token can reach this repository's environments".
  const { port, stub } = splitHarness(kp, isSecretsList, 200);

  const listed = await port.list(USER_ENV);
  assert.equal(listed.ok, true, 'an empty listing page is evidence of ACCESS, not of absence');
  assert.equal(listed.ok && listed.value.exists, false);
  assert.equal(stub.requests.filter(isProbe).length, 1, 'and it costs exactly one extra call, on the 404 path only');
});

test('remove and deleteEnvironment hit the right routes', async () => {
  const kp = await keypair();
  const { port, stub } = harness(happy(kp));

  assert.equal((await port.remove(USER_ENV, 'ANTHROPIC_API_KEY')).ok, true);
  assert.equal((await port.deleteEnvironment(USER_ENV)).ok, true);

  const deletes = stub.requests.filter((r) => r.method === 'DELETE').map((r) => r.url);
  assert.equal(deletes.length, 2);
  assert.ok(deletes[0]?.endsWith('/environments/user-123456789012345678/secrets/ANTHROPIC_API_KEY'));
  assert.ok(deletes[1]?.endsWith('/environments/user-123456789012345678'));
});

test('a malformed public key fails loudly instead of writing an undecryptable secret', async () => {
  const kp = await keypair();
  const { port, stub } = harness(
    happy(kp, (req) =>
      req.url.endsWith('/secrets/public-key')
        ? // The shape that matters: `key_id` as a NUMBER. `Number(KEY_ID)` is written rather
          // than a literal because the literal IS the corruption - it does not round-trip, and
          // that is the whole reason this must be rejected instead of coerced.
          { status: 200, body: { key_id: Number(KEY_ID), key: publicKeyBase64(kp) } }
        : null,
    ),
  );

  const result = await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(REAL_KEY));
  assert.equal(result.ok, false);
  assert.equal(stub.requests.filter((r) => r.method === 'PUT').length, 0, 'nothing may be written');
});

// ---------------------------------------------------------------------------------------
// Failure wording
// ---------------------------------------------------------------------------------------

/** An octokit `RequestError` look-alike carrying the credential everywhere a real one does. */
function githubError(status: number, headers: Readonly<Record<string, string>> = {}): Error {
  const e = new Error(`HttpError: request failed carrying ${CANARY} and Authorization: token ${TOKEN}`);
  e.name = 'HttpError';
  return Object.assign(e, {
    status,
    request: {
      method: 'PUT',
      url: 'https://api.github.com/repos/o/r/environments/user-123456789012345678/secrets/ANTHROPIC_API_KEY',
      headers: { authorization: `token ${TOKEN}` },
    },
    response: {
      status,
      headers,
      data: { message: `Failed (${CANARY})`, errors: [{ code: 'custom', field: 'encrypted_value' }] },
    },
  });
}

test('a 403 names the Environments permission, not "forbidden"', async () => {
  const kp = await keypair();
  const { port } = harness(happy(kp, (req) => (req.method === 'PUT' ? { status: 403, body: { message: 'Forbidden' } } : null)));

  const result = await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(CANARY));
  assert.equal(result.ok, false);
  if (result.ok) return;

  const text = operatorMessage(result.error);
  assert.ok(text.includes('Environments'), 'must name the permission that is actually missing');
  assert.ok(text.includes('Secrets'), 'must warn about the permission an operator reaches for instead');
  assert.ok(!/forbidden/iu.test(userMessage(result.error)), '"forbidden" tells nobody anything they can act on');
  // The generic 403 sentence sends them to check the three permissions that are NOT the problem.
  assert.ok(!text.includes('contents, issues and actions'), 'must not reuse the generic wording');
});

test('a 403 that is really a rate limit is still reported as a rate limit', async () => {
  const e = mapSecretsError(
    githubError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 90_000) / 1000) }),
    'secrets.put',
    NOW,
  );
  assert.equal(e.kind, 'rate-limited');
  assert.ok(!userMessage(e).includes('Environments'), 'a rate limit is not a permissions problem');
});

test('everything that is not a bare 403 keeps the shared translation', async () => {
  // One place in the repo knows that a 404 usually means "the token cannot see this repository"
  // and that 401 must never be retried. This adapter overrides exactly one status.
  const notFound = mapSecretsError(githubError(404), 'secrets.list', NOW);
  assert.ok(operatorMessage(notFound).includes('private repository'));

  const unauthorised = mapSecretsError(githubError(401), 'secrets.put', NOW);
  assert.ok(operatorMessage(unauthorised).includes('GITHUB_TOKEN'));
  assert.ok(!userMessage(unauthorised).includes('GITHUB_TOKEN'), 'users are never handed a variable name');
  assert.equal(unauthorised.retryable, false);
});

// ---------------------------------------------------------------------------------------
// THE ONE THAT MATTERS MOST
// ---------------------------------------------------------------------------------------

test('no error this adapter can produce contains the credential', async () => {
  const kp = await keypair();
  const produced: AppError[] = [];

  // 1. Every status, through the translator this adapter actually uses - including the ones a
  //    live transport would retry (429, 500) and the ones it cannot produce over the wire.
  for (const status of [0, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    produced.push(mapSecretsError(githubError(status), 'secrets.put', NOW));
  }
  produced.push(
    mapSecretsError(
      githubError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 60_000) / 1000) }),
      'secrets.put',
      NOW,
    ),
  );
  produced.push(mapSecretsError(new Error(`network down while sending ${CANARY}`), 'secrets.put', NOW));

  // 2. Every failure the port itself constructs, driven end to end with a real credential in
  //    hand - the shape errors, and one failure per method.
  const shapeFailures = harness(
    happy(kp, (req) => (req.url.endsWith('/secrets/public-key') ? { status: 200, body: { key_id: 1, key: 2 } } : null)),
  );
  const badKey = await shapeFailures.port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(CANARY));
  assert.equal(badKey.ok, false);
  if (!badKey.ok) produced.push(badKey.error);

  const badList = harness(happy(kp, (req) => (req.url.endsWith('/secrets') ? { status: 200, body: { nope: true } } : null)));
  const listed = await badList.port.list(USER_ENV);
  assert.equal(listed.ok, false);
  if (!listed.ok) produced.push(listed.error);

  // 3. One failing status through every method, which is what proves each `catch` is wired to
  //    the translator. The status axis is already covered synthetically above, and every method
  //    funnels into the same `fail(...)`, so one status is enough here - and it keeps this test
  //    off the throttler's 1s-per-write floor, which a 5x5 matrix would have paid 25 times.
  const failing = harness(happy(kp, () => ({ status: 403, body: { message: `Failed (${CANARY})` } })));
  const perMethod = [
    await failing.port.ensureEnvironment(USER_ENV),
    await failing.port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(CANARY)),
    await failing.port.list(USER_ENV),
    await failing.port.remove(USER_ENV, 'ANTHROPIC_API_KEY'),
    await failing.port.deleteEnvironment(USER_ENV),
  ];
  for (const r of perMethod) {
    assert.equal(r.ok, false, 'a 403 must not read as success on any method');
    if (!r.ok) produced.push(r.error);
  }

  assert.ok(produced.length >= 18, `expected a broad sample, got ${produced.length}`);

  for (const error of produced) {
    // Three surfaces: the whole object (what a logger serialises), the Discord text, and the
    // operator line - the only function permitted to read `internal`.
    for (const surface of [JSON.stringify(error), userMessage(error), operatorMessage(error)]) {
      // A RUN, not just the whole value. `includes(CANARY)` only fails for a complete
      // disclosure, so an error that echoed the first or last twenty characters - which is what
      // a truncated upstream body does - passed. A fragment is a partial disclosure AND a
      // fingerprint that confirms a guess, so any run of `MEANINGFUL_RUN` fails here.
      assert.deepEqual(traces(surface, CANARY), [], `the credential leaked into ${error.code}: ${surface}`);
      assert.deepEqual(traces(surface, TOKEN), [], `the bot token leaked into ${error.code}: ${surface}`);
    }
  }
});

test('no LOG LINE this adapter writes contains the credential', async () => {
  // The other persisted sink, and the one the module-side test structurally cannot reach: the
  // credentials module holds no logger, but this adapter does, and pino writes what it is given
  // to disk. `put` logs a confirmation on success - "did the bot write it?" has to be answerable
  // without anybody reaching for the credential - so the line's FIELDS are exactly where a
  // careless edit would put the value it is confirming.
  const kp = await keypair();
  const clock = fakeClock(NOW);
  const stub = stubFetch(happy(kp, (req) => (req.method === 'DELETE' ? { status: 404, body: {} } : null)));
  const logger = fakeRecordingLogger();
  const port = createGithubSecrets({
    octokit: createGithubClient({ token: secret(TOKEN), logger: fakeLogger(), fetch: stub.fetch }),
    repo: { owner: 'o', repo: 'r' },
    clock,
    logger,
  });

  await port.ensureEnvironment(USER_ENV);
  await port.put(USER_ENV, 'ANTHROPIC_API_KEY', secret(CANARY));
  await port.list(USER_ENV);
  await port.remove(USER_ENV, 'ANTHROPIC_API_KEY');
  await port.deleteEnvironment(USER_ENV);

  const text = logger.text();
  assert.deepEqual(traces(text, CANARY), [], `the credential reached a log line: ${text}`);
  assert.deepEqual(traces(text, TOKEN), [], `the bot token reached a log line: ${text}`);
  // And the lines are still USEFUL: the environment and the secret NAME are not secrets, and
  // they are what makes "did the bot write it?" answerable at all.
  assert.ok(text.includes('user-123456789012345678'), 'the environment name must still be logged');
  assert.ok(text.includes('ANTHROPIC_API_KEY'), 'and so must the secret name');
});

// ---------------------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------------------

test('reveal() is called exactly once in this adapter', async () => {
  const source = readFileSync(fileURLToPath(new URL('./secrets.ts', import.meta.url)), 'utf8');
  // Comments discuss `reveal()` at length; only code counts. Same stripper as conventions.test.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ');
  const calls = code.match(/\.reveal\(/gu) ?? [];
  assert.equal(
    calls.length,
    1,
    'one greppable unwrap is what makes an audit of credential handling a one-line grep',
  );
});

test('the port object exposes no read path at run time either', async () => {
  const kp = await keypair();
  const { port } = harness(happy(kp));
  assert.deepEqual(
    Object.keys(port).sort(),
    ['deleteEnvironment', 'ensureEnvironment', 'list', 'put', 'remove'],
    'a `get` here would be a credential oracle for every module holding the capability',
  );
});
