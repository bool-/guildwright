/**
 * THE CREDENTIALS MODULE, against fakes for everything.
 *
 * Two claims are load-bearing here, and they pull against each other, so both are asserted
 * directly rather than inferred from "the code looks right":
 *
 *   (A) THE CREDENTIAL REACHES THE PORT UNMODIFIED. The rest of this repo runs user text
 *       through `redactUserSecrets`, which rewrites `sk-ant-api03-...` to `[redacted]` — the
 *       credential is precisely what that pattern is built to destroy. Doing it here would
 *       store `[redacted]`, report success, and produce a 401 half an hour into a build. The
 *       test compares bytes.
 *
 *   (B) THE CREDENTIAL REACHES NOTHING ELSE. Not an audit `detail`, not a log line, not an
 *       error message, not a rendered view. That is asserted by SCANNING everything those four
 *       sinks produced for the plaintext, on the success path AND on the refusal path — not by
 *       reading the source and believing it.
 *
 * The leak scan is deliberately crude: stringify everything, search for the value. A subtle
 * assertion here would be a worse assertion, because the failure it is looking for is
 * "somebody interpolated the value somewhere new".
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { operatorMessage, userMessage, type AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { Result } from '#core/result';
import { renderSafeMarkdown, userTextForTest } from '#core/text';
import { decodeActionRef, type UserId } from '#core/ids';
import { permissionRef } from '#core/policy';
import type { View } from '#core/view';
import { fakeAudit, fakeRecordingLogger, fakeRepoSet, fakeRepos, fakeScopedByKey, fakeSecrets, type FakeAudit, type FakeSecrets } from '#testing/fakes';
import type { SecretsPort } from '#core/ports';
import { createEventBus } from '#core/events';
import credentialsModule from '#modules/credentials/module';
import { userEnvironmentName } from '#core/ports/secrets';

import { CredentialService, credentialRepository } from '#modules/credentials/domain';
import {
  CREDENTIAL_FIELD,
  MODULE_ID,
  SET_FORM,
  credentialCommands,
  credentialForm,
  credentialForms,
  present,
  type CredentialPerms,
} from '#modules/credentials/present';

// ---------------------------------------------------------------------------------------
// Fixtures. SHAPES ONLY — no real credential is ever checked into this repo.
// ---------------------------------------------------------------------------------------

const USER = '111111111111111111' as UserId;
const GUILD = '222222222222222222';

/** The environment the integrated port keys on for USER. */
const USER_ENV = (() => { const e = userEnvironmentName(USER); if (!e.ok) throw new Error('fixture'); return e.value; })();

const OAUTH = `sk-ant-oat01-${'o'.repeat(95)}`;
const API_KEY = `sk-ant-api03-${'a'.repeat(95)}`;

/**
 * THE LEAK CANARY, and why it is not `API_KEY`.
 *
 * `API_KEY` is `sk-ant-api03-` followed by ninety-five `a`s, so almost every substring of it is
 * `aaaaaaaaaaaa` — a string no leak scan can search for, because it matches prose, base64,
 * padding, anything. A scan built on that value can only ever check the WHOLE credential and a
 * couple of hand-picked slices, which is exactly what the previous version of the leak test did
 * and exactly why a partial disclosure passed it.
 *
 * This value classifies identically (`sk-ant-api03-`) and has a body with no repeated run, so
 * EVERY window of it is distinctive enough to search for.
 */
const CANARY_BODY = 'q7Zk3Rv9TmXd2Lc8HnW4pB6yJ5gFsA1eQwErTyUiOpAsDfGhJkLzXcVbNm09';
const CANARY_KEY = `sk-ant-api03-${CANARY_BODY}`;

/**
 * The shortest run of the credential that counts as a disclosure.
 *
 * TWELVE, not "the whole value". A leak is rarely the whole thing. It is a prefix in a "we got
 * `sk-ant-api03-q7Zk…`" message, a suffix in a "…ends `LzXcVbNm09`" confirmation, or a slice out
 * of an upstream error body echoed into `AppError.internal`. Every one of those is a real
 * partial disclosure AND a fingerprint that confirms a guess, so every one must fail this test.
 *
 * Twelve is short enough to catch a truncated echo, and long enough that nothing legitimate in
 * this module collides: the refusal text names `sk-ant-api…` and `sk-ant-oat…`, which are ten
 * characters, and nothing anywhere prints the generation digits followed by body bytes.
 */
const MEANINGFUL_RUN = 12;

/**
 * Every run of `credential` at least `MEANINGFUL_RUN` long that appears in `haystack`.
 *
 * WHY A SLIDING WINDOW instead of three hand-picked slices: the three-slice version could only
 * fail for a leak that started at index 0, ended at the last character, or was the entire value.
 * A leak of the MIDDLE — which is what an upstream error body echoing a request produces — sailed
 * straight through it. A window cannot be evaded: any disclosure of `MEANINGFUL_RUN` characters
 * or more, wherever it starts, contains at least one whole window.
 */
function traces(haystack: string, credential: string): readonly string[] {
  const hits: string[] = [];
  for (let i = 0; i + MEANINGFUL_RUN <= credential.length; i += 1) {
    const window = credential.slice(i, i + MEANINGFUL_RUN);
    if (haystack.includes(window)) hits.push(`offset ${i}: ${JSON.stringify(window)}`);
  }
  return hits;
}

const perms: CredentialPerms = { manage: permissionRef(MODULE_ID, 'manage') };

function harness(): { svc: CredentialService; secrets: FakeSecrets; audit: FakeAudit } {
  const secrets = fakeSecrets();
  const audit = fakeAudit();
  return { svc: new CredentialService(secrets, audit), secrets, audit };
}

/**
 * Every string a `View` would put in front of a user.
 *
 * WHY THIS HELPER EXISTS AND `JSON.stringify(view)` DOES NOT DO: a `SafeMarkdown` carries its
 * payload behind a module-private symbol, so `JSON.stringify` of a view renders `{}` for every
 * text node. A leak test built on it would pass against code that prints the credential in
 * 72-point type. `renderSafeMarkdown` is the real egress, so it is what the scan reads.
 */
function viewText(view: View): string {
  const out: string[] = [];
  for (const node of view.nodes) {
    switch (node.kind) {
      case 'text':
        out.push(renderSafeMarkdown(node.md));
        break;
      case 'heading':
        out.push(node.text);
        break;
      case 'field':
        out.push(node.name, renderSafeMarkdown(node.md));
        break;
      case 'table':
        out.push(...node.head, ...node.rows.flatMap((r) => [...r]));
        break;
      case 'buttons':
        out.push(...node.buttons.map((b) => `${b.label} ${b.customId}`), ...node.links.map((l) => `${l.label} ${l.url}`));
        break;
      case 'select':
        out.push(
          node.select.placeholder,
          ...node.select.options.flatMap((o) => [o.label, o.value, o.description ?? '']),
        );
        break;
      case 'divider':
        break;
      default: {
        const exhaustive: never = node;
        void exhaustive;
      }
    }
  }
  return out.join('\n');
}

/** Everything an `AppError` could ever put anywhere, operator channel included. */
function errorText(e: AppError): string {
  return [userMessage(e), operatorMessage(e), JSON.stringify(e)].join('\n');
}

// ---------------------------------------------------------------------------------------
// (A) the credential reaches the port unmodified, under the right name
// ---------------------------------------------------------------------------------------

test('an OAuth token is stored under CLAUDE_CODE_OAUTH_TOKEN, not the API key name', async () => {
  const { svc, secrets } = harness();

  const stored = await svc.set(USER, GUILD, userTextForTest(OAUTH));

  assert.ok(stored.ok, 'a well-formed OAuth token must be accepted');
  if (!stored.ok) return;
  assert.equal(stored.value, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(secrets.writes.length, 1);
  assert.equal(secrets.writes[0]?.name, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(secrets.writes[0]?.env, USER_ENV);
});

test('an API key is stored under ANTHROPIC_API_KEY', async () => {
  const { svc, secrets } = harness();

  const stored = await svc.set(USER, GUILD, userTextForTest(API_KEY));

  assert.ok(stored.ok);
  if (!stored.ok) return;
  assert.equal(stored.value, 'ANTHROPIC_API_KEY');
  assert.equal(secrets.writes[0]?.name, 'ANTHROPIC_API_KEY');
});

test('THE VALUE REACHES THE PORT BYTE-IDENTICAL — the redactUserSecrets trap', async () => {
  const { svc, secrets } = harness();

  await svc.set(USER, GUILD, userTextForTest(API_KEY));

  const written = secrets.writes[0]?.credential.reveal();
  assert.equal(written, API_KEY, 'sanitising the credential here corrupts it silently');
  assert.ok(written !== undefined && !written.includes('[redacted]'), 'redaction is the specific failure');
});

test('a pasted trailing newline is trimmed, and the SAME bytes are classified and stored', async () => {
  const { svc, secrets } = harness();

  const stored = await svc.set(USER, GUILD, userTextForTest(`${OAUTH}\n`));

  assert.ok(stored.ok);
  assert.equal(secrets.writes[0]?.credential.reveal(), OAUTH, 'the newline must not go to GitHub');
  assert.equal(secrets.writes[0]?.name, 'CLAUDE_CODE_OAUTH_TOKEN', 'and the name must match those bytes');
});

test('a token wrapped across terminal lines is rejoined before it is stored', async () => {
  const { svc, secrets } = harness();

  // `claude setup-token` wraps; a copy of its output carries the break mid-token.
  const stored = await svc.set(USER, GUILD, userTextForTest(`${OAUTH.slice(0, 95)}\r\n  ${OAUTH.slice(95)}\n`));

  assert.ok(stored.ok);
  assert.equal(secrets.writes[0]?.credential.reveal(), OAUTH, 'GitHub must get one unbroken line');
});

// ---------------------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------------------

test('an unrecognised credential is REFUSED, and nothing is written', async () => {
  const { svc, secrets } = harness();

  const stored = await svc.set(USER, GUILD, userTextForTest('hunter2'));

  assert.ok(!stored.ok, 'guessing a name would surface as a 401 inside a build');
  if (stored.ok) return;
  assert.equal(stored.error.kind, 'validation');
  assert.deepEqual([...secrets.writes], [], 'a refusal must not write anything, under any name');
});

test('the refusal says what was expected, in both shapes, so the user can act on it', async () => {
  const { svc } = harness();

  const stored = await svc.set(USER, GUILD, userTextForTest('hunter2'));

  assert.ok(!stored.ok);
  if (stored.ok) return;
  const text = userMessage(stored.error);
  assert.match(text, /sk-ant-api/u, 'it must name the API key shape');
  assert.match(text, /sk-ant-oat/u, 'and the OAuth token shape');
  assert.match(text, /setup-token/u, 'and where an OAuth token comes from');
});

test('an Anthropic ADMIN key is refused rather than stored as an API key', async () => {
  const { svc, secrets } = harness();

  const stored = await svc.set(USER, GUILD, userTextForTest(`sk-ant-admin01-${'z'.repeat(80)}`));

  assert.ok(!stored.ok, 'an org-administration key must never reach a build container');
  assert.deepEqual([...secrets.writes], []);
});

// ---------------------------------------------------------------------------------------
// (B) THE LEAK SCAN
// ---------------------------------------------------------------------------------------

/**
 * WALK EVERY PATH THE SERVICE HAS, and collect everything each one produced.
 *
 * WHY IT IS EXHAUSTIVE RATHER THAN "the two interesting paths": the previous version drove three
 * calls on the happy path and scanned four sinks, so a disclosure on any FAILURE path — which is
 * where an "and here is what you sent" message actually gets added, and where an upstream body
 * lands in `AppError.internal` — was invisible to it. Each arm below is a distinct opportunity
 * to leak, and the returned haystack is every byte any of them could put in front of a person or
 * into a persisted pino line.
 */
async function everySink(credential: string): Promise<{ haystack: string; audit: FakeAudit }> {
  const parts: string[] = [];
  const audit = fakeAudit();
  const logger = fakeRecordingLogger();
  /** Every failure arm contributes its error; a success on these lines would be the bug. */
  const collect = <T,>(r: Result<T, AppError>): void => {
    assert.ok(!r.ok, 'this arm is supposed to fail, or it is scanning nothing');
    if (!r.ok) parts.push(errorText(r.error));
  };

  // 1. STORED. Both names, because `present.stored` branches on which one.
  const stored = fakeSecrets();
  const a = new CredentialService(stored, audit);
  const okApi = await a.set(USER, GUILD, userTextForTest(credential));
  const okOauth = await a.set(USER, GUILD, userTextForTest(OAUTH));
  assert.ok(okApi.ok && okOauth.ok);
  if (!okApi.ok || !okOauth.ok) throw new Error('fixture');
  parts.push(viewText(present.stored(okApi.value)), viewText(present.stored(okOauth.value)));

  // 2. STATUS, on a populated store and on an empty one.
  const populated = await a.status(USER);
  assert.ok(populated.ok);
  if (populated.ok) parts.push(viewText(present.status(populated.value)));
  const empty = await new CredentialService(fakeSecrets(), audit).status(USER);
  assert.ok(empty.ok);
  if (empty.ok) parts.push(viewText(present.status(empty.value)));

  // 3. CLEARED, both arms.
  const clearedReal = await a.clear(USER, GUILD);
  const clearedNothing = await a.clear(USER, GUILD);
  assert.ok(clearedReal.ok && clearedNothing.ok);
  if (clearedReal.ok) parts.push(viewText(present.cleared(clearedReal.value)));
  if (clearedNothing.ok) parts.push(viewText(present.cleared(clearedNothing.value)));

  // 4. REFUSED, with the credential embedded in what the user submitted. This is the arm most
  //    likely to grow a helpful "we got …" sentence, and the embedding means any echo of the
  //    input at all is an echo of the credential.
  collect(await new CredentialService(fakeSecrets(), audit).set(USER, GUILD, userTextForTest(`not-a-key-${credential}`)));

  // 5. EVERY PORT FAILURE, one per call the service makes, with a real credential in hand. The
  //    `put` arm additionally drives the ROLLBACK, whose `list`/`deleteEnvironment` calls are
  //    code the credential is still in scope for.
  for (const method of ['ensureEnvironment', 'put'] as const) {
    const s = fakeSecrets();
    s.failOnce(method, errors.upstream('github', 403, 'Ask an admin to check the token permissions.', `${method} failed`));
    collect(await new CredentialService(s, audit).set(USER, GUILD, userTextForTest(credential)));
  }
  const listFails = fakeSecrets();
  listFails.failOnce('list', errors.upstream('github', 500, 'Try again in a minute.', 'list failed'));
  collect(await new CredentialService(listFails, audit).status(USER));

  const deleteFails = fakeSecrets();
  deleteFails.failOnce('deleteEnvironment', errors.upstream('github', 500, 'Try again in a minute.', 'delete failed'));
  collect(await new CredentialService(deleteFails, audit).clear(USER, GUILD));

  // 6. A CORRUPT ACTOR, which fails before any port call - the branch that constructs an error
  //    from a value the caller supplied.
  collect(await new CredentialService(fakeSecrets(), audit).set('nope' as UserId, GUILD, userTextForTest(credential)));

  logger.info('module ran', { userId: USER });
  parts.push(JSON.stringify(audit.entries), logger.text());
  return { haystack: parts.join('\n'), audit };
}

test('the plaintext never appears in an audit entry, a log line, an error, or a view', async () => {
  const { haystack } = await everySink(CANARY_KEY);

  // The whole assertion, in one line: NO run of the credential twelve characters or longer
  // appears anywhere any of those paths could put it. Not a prefix, not a suffix, not a slice.
  assert.deepEqual(
    traces(haystack, CANARY_KEY),
    [],
    'a run of the credential reached an operator- or user-visible sink',
  );

  // The scan is only worth anything if it can actually find things, so prove the instrument
  // works on the same haystack: a value that IS in there is reported.
  assert.ok(
    traces(`prefix ${CANARY_KEY.slice(20, 40)} suffix`, CANARY_KEY).length > 0,
    'sanity: the scan must detect a middle fragment, or it is asserting nothing',
  );
  assert.ok(haystack.length > 0, 'sanity: the paths must actually have produced output');
});

test('the audit still says enough to answer "what happened"', async () => {
  const { audit } = await everySink(CANARY_KEY);

  // The counterpart to the leak scan: a log that leaks nothing because it records nothing is
  // not a win. Every outcome the service reaches is named, and the details are the secret NAME
  // and the outcome — never the value, which the `JsonObject` type makes unwritable anyway.
  assert.deepEqual(new Set(audit.entries.map((e) => e.action)), new Set(['credentials.set', 'credentials.set_refused', 'credentials.clear']));
  // `supersededRemoved` records what happened to the OTHER credential kind: false when there was
  // none, true when a dead one was cleared, null when the removal itself failed. All three are
  // different answers to "why did my build authenticate with the wrong key?".
  assert.deepEqual(audit.entries[0]?.detail, { secretName: 'ANTHROPIC_API_KEY', supersededRemoved: false });
  assert.deepEqual(audit.entries[1]?.detail, { secretName: 'CLAUDE_CODE_OAUTH_TOKEN', supersededRemoved: true });
  assert.ok(
    audit.entries.some((e) => e.action === 'credentials.clear' && JSON.stringify(e.detail) === '{"existed":true}'),
    'a real removal must be distinguishable in the audit from a no-op one',
  );
  assert.ok(
    audit.entries.some((e) => e.action === 'credentials.clear' && JSON.stringify(e.detail) === '{"existed":false}'),
    'and "there was nothing there" must be recorded as such',
  );
  assert.ok(audit.entries.some((e) => JSON.stringify(e.detail) === '{"reason":"unrecognised-shape"}'));
  // No row for anything that did not happen: a failed write must not leave a "stored" entry.
  assert.equal(audit.entries.filter((e) => e.action === 'credentials.set').length, 2, 'two stores succeeded, no more');
});

test('a Secret cannot be put in an audit detail even by accident — the type is the wall', () => {
  // This is a compile-time claim, so the runtime half is the carrier's backstop: even if the
  // wall were breached, `JSON.stringify` of the entry would still not carry the value.
  const audit = fakeAudit();
  audit.record({ action: 'credentials.set', actorId: USER, guildId: GUILD, detail: { secretName: 'ANTHROPIC_API_KEY' } });
  assert.ok(!JSON.stringify(audit.entries).includes('sk-ant'));
});

// ---------------------------------------------------------------------------------------
// status / clear
// ---------------------------------------------------------------------------------------

test('status reports NAMES and there is no method that could report a value', async () => {
  const { svc, secrets } = harness();
  secrets.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');

  const status = await svc.status(USER);

  assert.ok(status.ok);
  if (!status.ok) return;
  assert.deepEqual([...status.value.names], ['CLAUDE_CODE_OAUTH_TOKEN']);
  // The port has no `get`/`read`/`peek` at all. If one is ever added, this fails.
  assert.deepEqual(
    Object.keys(secrets).filter((k) => ['get', 'read', 'peek', 'reveal'].includes(k)),
    [],
    'SecretsPort must stay write-only; GitHub cannot give a secret back and neither can we',
  );
});

test('status on a user with nothing stored is an empty list, not an error', async () => {
  const { svc } = harness();
  const status = await svc.status(USER);
  assert.ok(status.ok);
  if (!status.ok) return;
  assert.deepEqual([...status.value.names], []);
});

test('clear distinguishes "removed" from "there was nothing there"', async () => {
  const { svc, secrets, audit } = harness();
  secrets.seed(USER_ENV, 'ANTHROPIC_API_KEY');

  const first = await svc.clear(USER, GUILD);
  const second = await svc.clear(USER, GUILD);

  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value, true);
  assert.equal(second.value, false);
  assert.deepEqual(
    audit.entries.map((e) => e.detail),
    [{ existed: true }, { existed: false }],
  );
});

// ---------------------------------------------------------------------------------------
// The failure arm — reachable only because the fake can express it
// ---------------------------------------------------------------------------------------

test('a port failure is reported to the user, not swallowed, and writes no audit row', async () => {
  const { svc, secrets, audit } = harness();
  secrets.failNext(errors.upstream('github', 403, 'Ask an admin to check the token permissions.'));

  const stored = await svc.set(USER, GUILD, userTextForTest(OAUTH));

  assert.ok(!stored.ok, 'a failed write must never read as a stored credential');
  if (stored.ok) return;
  assert.equal(stored.error.kind, 'upstream');
  assert.deepEqual([...audit.entries], [], 'no "stored" row for something that was not stored');
});

// ---------------------------------------------------------------------------------------
// A FAILED `set` MUST NOT STRAND THE USER
// ---------------------------------------------------------------------------------------
//
// `set` is `ensureEnvironment` then `put`. If `put` fails, the environment exists and is empty —
// and `resolveBuildPayer` treats "exists but holds no credential" as a HARD FAILURE, on purpose,
// so a revoked key can never quietly move the bill back to the operator. So a single transient
// GitHub error during a modal submission left that user unable to build ANYTHING, on an install
// whose shared environment was funded and would have paid, with nothing pointing at the cause.

test('a failed put rolls back the environment it just created', async () => {
  const { svc, secrets } = harness();
  secrets.failOnce('put', errors.upstream('github', 500, 'Try again in a minute.'));

  const stored = await svc.set(USER, GUILD, userTextForTest(OAUTH));

  assert.ok(!stored.ok, 'the user must be told the write failed');
  assert.deepEqual(
    [...secrets.environments],
    [],
    'an EMPTY user environment blocks every build that user asks for — it must not outlive the failure',
  );
  assert.deepEqual([...secrets.cleared], [USER_ENV], 'and the rollback is the environment delete, not a secret delete');
});

test('the rollback never destroys a credential that was already working', async () => {
  // THE CASE THAT MAKES "always delete on failure" WRONG. The user has a key stored and submits a
  // replacement; the write fails. Deleting the environment would take the OLD, working key with
  // it — turning a failed update into a lost credential and a blocked user.
  const { svc, secrets } = harness();
  secrets.seed(USER_ENV, 'ANTHROPIC_API_KEY');
  secrets.failOnce('put', errors.upstream('github', 500, 'Try again in a minute.'));

  const stored = await svc.set(USER, GUILD, userTextForTest(OAUTH));

  assert.ok(!stored.ok);
  assert.deepEqual([...secrets.environments], [USER_ENV], 'the environment must survive');
  assert.deepEqual([...secrets.cleared], [], 'and nothing may be deleted');
  const status = await svc.status(USER);
  assert.deepEqual(status.ok ? [...status.value.names] : ['MISSING'], ['ANTHROPIC_API_KEY'], 'the old key still pays');
});

test('the rollback leaves an operator’s own secret alone', async () => {
  // Deleting an environment takes EVERY secret in it, including names this bot does not manage.
  // Emptiness is the exact state `ensureEnvironment` can have produced, so emptiness is the exact
  // state that gets rolled back — anything else is destroying somebody else's data on a whim.
  const { svc, secrets } = harness();
  secrets.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  await svc.clear(USER, GUILD);
  secrets.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  secrets.failOnce('put', errors.upstream('github', 500, 'Try again in a minute.'));

  await svc.set(USER, GUILD, userTextForTest(API_KEY));
  assert.ok(secrets.environments.includes(USER_ENV), 'a non-empty environment is never rolled back');
});

test('a stranded environment from an EARLIER failure heals on the next attempt', async () => {
  // The rollback re-reads rather than remembering "did I create it?", so it also cleans up an
  // environment left empty by a previous deploy or a crash between the two calls.
  const { svc, secrets } = harness();
  secrets.seedEmptyEnvironment(USER_ENV);
  secrets.failOnce('put', errors.upstream('github', 500, 'Try again in a minute.'));

  await svc.set(USER, GUILD, userTextForTest(OAUTH));
  assert.deepEqual([...secrets.environments], [], 'the pre-existing empty environment is cleaned up too');
});

test('a failure while reading status surfaces as a failure, not as "nothing stored"', async () => {
  const { svc, secrets } = harness();
  secrets.failNext(errors.upstream('github', 500, 'Try again in a minute.'));

  const status = await svc.status(USER);

  // "Nothing stored" and "we could not tell" must not look the same: the first invites the user
  // to set a credential they may already have, and replacing it is a real, chargeable action.
  assert.ok(!status.ok);
});

// ---------------------------------------------------------------------------------------
// Wiring — the drift that no other test would catch
// ---------------------------------------------------------------------------------------

test('the modal routes to the handler that reads it', () => {
  const form = credentialForm();
  const ref = decodeActionRef(form.customId);

  assert.ok(ref.ok, 'the modal custom_id must decode');
  if (!ref.ok) return;
  assert.equal(ref.value.moduleId, MODULE_ID);
  assert.equal(
    ref.value.action,
    credentialForms(harness().svc, perms)[0]?.name,
    'the custom_id action segment IS how a submission finds its handler',
  );
  assert.equal(ref.value.action, SET_FORM);
});

test('the handler reads exactly the field the modal declares', () => {
  const form = credentialForm();
  const handler = credentialForms(harness().svc, perms)[0];

  assert.deepEqual(
    form.fields.map((f) => f.name),
    handler?.fields === undefined ? [] : [...handler.fields],
    'a mismatch means the modal is opened and its contents silently discarded',
  );
  assert.deepEqual(form.fields.map((f) => f.name), [CREDENTIAL_FIELD]);
});

test('the credential field is a paragraph with room for any credential Anthropic issues', () => {
  const first = credentialForm().fields[0];
  assert.equal(first?.kind, 'text');
  const field = first?.kind === 'text' ? first : undefined;
  assert.equal(field?.style, 'paragraph');
  assert.equal(field?.required, true);
  // A tight cap does not protect anything: it truncates client-side, and a truncated key still
  // starts `sk-ant-api…`, so it classifies, stores, and fails as a 401 inside a build.
  assert.ok((field?.maxLength ?? 0) >= 1000, 'a tight cap silently truncates a pasted credential');
  // Discord's own caps, which throw at render time rather than returning an error.
  assert.ok((field?.label.length ?? 0) <= 45, 'Discord caps a modal label at 45 characters');
  assert.ok((field?.placeholder.length ?? 0) <= 100, 'Discord caps a placeholder at 100 characters');
});

test('`/credentials set` uses a modal, which is why the value never enters a channel', () => {
  const commands = credentialCommands(harness().svc, perms);

  assert.deepEqual(
    commands.map((c) => c.name),
    ['credentials set', 'credentials status', 'credentials clear'],
  );
  const set = commands[0];
  assert.equal(set?.ack, 'form', 'a string option would render the credential into the channel');
  assert.deepEqual([...(set?.options ?? [])], [], 'and it must take no option that could carry one');
});

test('every reply is ephemeral, and every entry point declares its permission and limits', () => {
  const commands = credentialCommands(harness().svc, perms);
  const forms = credentialForms(harness().svc, perms);

  for (const spec of [...commands, ...forms]) {
    assert.equal(spec.permission, perms.manage, `${spec.name} must be gated on the declared key`);
    assert.ok(spec.limit.length > 0, `${spec.name} must declare a bucket, or NO_LIMIT deliberately`);
    // An ephemeral interaction response needs no channel permission; declaring one would refuse
    // to run in a channel where the command would in fact have worked.
    assert.deepEqual([...spec.needs], [], `${spec.name} should need no channel permission`);
  }
  for (const spec of forms) assert.equal(spec.ack, 'defer-ephemeral');
  for (const view of [
    present.stored('ANTHROPIC_API_KEY'),
    present.status({ names: [] }),
    present.status({ names: ['CLAUDE_CODE_OAUTH_TOKEN'] }),
    present.cleared(true),
  ]) {
    assert.equal(view.ephemeral, true, 'which credential you pay with is nobody else’s business');
  }
});

test('the ack:form handler does not await — Discord forbids defer-then-modal', () => {
  // AGENTS.md names this `no-await-in-form-handler`, and it is the one mistake in this module
  // that NO unit test can see: `showModal` after a defer fails 100% of the time in production
  // and 0% of the time in a test, because a test never talks to Discord. So it is asserted
  // textually, over this module's own source, in the same spirit as `builder/contract.test.ts`.
  //
  // Comments are stripped first, for the reason `conventions.test.ts` gives: this file's own
  // prose EXPLAINS the rule, and a check that fires on the explanation is a check that gets
  // suppressed, after which it protects nothing.
  const code = readFileSync('src/modules/credentials/present.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ');

  const start = code.indexOf("ack: 'form'");
  assert.ok(start > 0, 'sanity: the form command must still be declared with ack: form');

  // From the ack line to the end of that command spec object — a `},` at four spaces, which is
  // where a spec in the returned array closes.
  const end = code.indexOf('\n    },', start);
  assert.ok(end > start, 'sanity: the command spec must terminate');

  assert.ok(
    !/\bawait\b/u.test(code.slice(start, end)),
    'a single await before returning the modal is a 100% reproducible production failure',
  );
});

// ---------------------------------------------------------------------------------------
// Switching credential kind
// ---------------------------------------------------------------------------------------

test('storing the other kind REMOVES the superseded one, so a dead token cannot pay', async () => {
  // The most likely reason anyone runs this twice: an OAuth token expired, so they paste an API
  // key. The workflow hands the action BOTH `anthropic_api_key` and `claude_code_oauth_token`,
  // and precedence between them belongs to that action, not to us — so leaving the dead token
  // behind can produce a build that authenticates with it and fails for a reason the user has
  // already fixed.
  const { svc, secrets } = harness();

  const first = await svc.set(USER, GUILD, userTextForTest(OAUTH));
  assert.ok(first.ok);

  const second = await svc.set(USER, GUILD, userTextForTest(API_KEY));
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.value, 'ANTHROPIC_API_KEY');

  const status = await svc.status(USER);
  assert.ok(status.ok);
  if (!status.ok) return;
  assert.deepEqual(
    [...status.value.names],
    ['ANTHROPIC_API_KEY'],
    'exactly one credential survives a switch; both would let the dead one pay',
  );
  void secrets;
});

test('the audit distinguishes "nothing to supersede" from "the removal failed"', async () => {
  // `false` and `null` are different answers and an operator reading the log needs both.
  const { svc, audit } = harness();

  const fresh = await svc.set(USER, GUILD, userTextForTest(API_KEY));
  assert.ok(fresh.ok);

  const row = audit.entries.at(-1);
  assert.equal(row?.action, 'credentials.set');
  assert.equal(
    row?.detail['supersededRemoved'],
    false,
    'a first-time store had nothing of the other kind to remove',
  );
});

test('THE HONESTY LINE: the /credentials set modal says who can use the credential, and no longer claims nobody can', () => {
  // RFC-001 5.2: a requester who stores a key is trusting whoever runs this bot and administers
  // its repository - any repo admin can write a workflow step that uses an environment secret.
  // The old intro ("Nobody can read it back, including you") was true of the API and false of
  // the people, which is the one place a reassurance must not be wrong.
  const intro = credentialForm().intro ?? '';
  assert.match(intro, /Whoever runs this bot, and any admin of that repository, can use it/u);
  assert.match(intro, /spend-limited key/u, 'and what limits the damage');
  assert.doesNotMatch(intro, /Nobody can read it back/u);
});

// ---------------------------------------------------------------------------------------
// WHICH REPOSITORY (RFC-001 PR 2.1): `secrets` is one port per repository behind `.at()`
// ---------------------------------------------------------------------------------------

function twoRepoSecrets(defaultKey: 'main' | null) {
  const set = fakeRepoSet([
    { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: defaultKey === 'main' },
    { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
  ]);
  const main = fakeSecrets();
  const events = fakeSecrets();
  return { set, main, events, scoped: fakeScopedByKey<SecretsPort>(set, { main, events }) };
}

test('REPO SET: a credential is sealed into the DEFAULT repository\'s environment, and only there', async () => {
  const r = twoRepoSecrets('main');
  const target = credentialRepository(fakeRepos(r.set), r.scoped);
  assert.equal(target.unavailable, null);
  const svc = new CredentialService(target.secrets, fakeAudit());
  assert.ok((await svc.set(USER, GUILD, userTextForTest(OAUTH))).ok);
  assert.equal(r.main.writes.length, 1, 'stored in acme/bot-modules');
  assert.equal(r.events.writes.length, 0, 'and not in a repository nobody built in');
});

test('REPO SET: several repositories and no default refuse every command, and /status says the module is down', async () => {
  const r = twoRepoSecrets(null);
  const target = credentialRepository(fakeRepos(r.set), r.scoped);
  assert.match(target.unavailable ?? '', /nowhere to store a credential/u);
  const svc = new CredentialService(target.secrets, fakeAudit());
  const refused = await svc.set(USER, GUILD, userTextForTest(OAUTH));
  assert.ok(!refused.ok);
  assert.equal(refused.ok ? '' : refused.error.code, 'config.repos.unmapped');
  assert.equal(r.main.writes.length + r.events.writes.length, 0, 'nothing stored anywhere');

  const installed = credentialsModule.install({
    ports: { audit: fakeAudit(), repos: fakeRepos(r.set), secrets: r.scoped },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeRecordingLogger(),
  });
  assert.ok(installed.ok);
  if (!installed.ok) return;
  assert.equal((await installed.value.health()).status, 'down');
});
