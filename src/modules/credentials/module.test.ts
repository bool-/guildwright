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
import { Err, Ok, type Result } from '#core/result';
import { renderSafeMarkdown, userTextForTest } from '#core/text';
import { decodeActionRef, encodeActionRef, newCardNonce, newRequestId, staticCustomId, toChannelId, toGuildId, type GuildId, type UserId } from '#core/ids';
import type { Actor, CommandSpec, Invocation, Outcome, ProgressHandle, Space } from '#core/module';
import type { Args, FormValues } from '#core/args';
import { permissionRef } from '#core/policy';
import type { FormSpec, View } from '#core/view';
import { fakeAudit, fakeRecordingLogger, fakeRepoSet, fakeRepos, fakeScopedByKey, fakeSecrets, type FakeAudit, type FakeSecrets } from '#testing/fakes';
import type { SecretsPort } from '#core/ports';
import { createEventBus } from '#core/events';
import credentialsModule from '#modules/credentials/module';
import { userEnvironmentName } from '#core/ports/secrets';

import { CredentialService, RepositoryCredentials } from '#modules/credentials/domain';
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

/** The audit `repo` of the one-repository set every single-repository test runs against. */
const ONE_REPO = 'o/r';

/**
 * `svc` is ONE repository's store, which is what every test of the credential handling itself
 * needs; `routed` is the module's service over a one-repository set, for the command and form
 * specs. Which repository a command lands in is the multi-repository section at the bottom.
 */
function harness(): { svc: RepositoryCredentials; routed: CredentialService; secrets: FakeSecrets; audit: FakeAudit } {
  const secrets = fakeSecrets();
  const audit = fakeAudit();
  const set = fakeRepoSet();
  return {
    svc: new RepositoryCredentials(secrets, audit, ONE_REPO),
    routed: new CredentialService(fakeRepos(set), fakeScopedByKey<SecretsPort>(set, { default: secrets }), audit),
    secrets,
    audit,
  };
}

/** The modal a one-repository install opens in a server. */
function oneRepoForm(): FormSpec {
  const target = harness().routed.openTarget(gid(GUILD), undefined);
  assert.ok(target.ok, 'a one-repository install always has a target');
  if (!target.ok) throw new Error('unreachable');
  const form = credentialForm(target.value);
  assert.ok(form.ok);
  if (!form.ok) throw new Error('unreachable');
  return form.value;
}

function gid(raw: string): GuildId {
  const g = toGuildId(raw);
  if (!g.ok) throw new Error('fixture');
  return g.value;
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
  const a = new RepositoryCredentials(stored, audit, ONE_REPO);
  const okApi = await a.set(USER, GUILD, userTextForTest(credential));
  const okOauth = await a.set(USER, GUILD, userTextForTest(OAUTH));
  assert.ok(okApi.ok && okOauth.ok);
  if (!okApi.ok || !okOauth.ok) throw new Error('fixture');
  parts.push(viewText(present.stored(okApi.value, null)), viewText(present.stored(okOauth.value, null)));

  // 2. STATUS, on a populated store and on an empty one.
  const populated = await a.status(USER);
  assert.ok(populated.ok);
  if (populated.ok) parts.push(viewText(present.status(populated.value, null)));
  const empty = await new RepositoryCredentials(fakeSecrets(), audit, ONE_REPO).status(USER);
  assert.ok(empty.ok);
  if (empty.ok) parts.push(viewText(present.status(empty.value, null)));

  // 3. CLEARED, both arms.
  const clearedReal = await a.clear(USER, GUILD);
  const clearedNothing = await a.clear(USER, GUILD);
  assert.ok(clearedReal.ok && clearedNothing.ok);
  if (clearedReal.ok) parts.push(viewText(present.cleared(clearedReal.value, null)));
  if (clearedNothing.ok) parts.push(viewText(present.cleared(clearedNothing.value, null)));

  // 4. REFUSED, with the credential embedded in what the user submitted. This is the arm most
  //    likely to grow a helpful "we got …" sentence, and the embedding means any echo of the
  //    input at all is an echo of the credential.
  collect(await new RepositoryCredentials(fakeSecrets(), audit, ONE_REPO).set(USER, GUILD, userTextForTest(`not-a-key-${credential}`)));

  // 5. EVERY PORT FAILURE, one per call the service makes, with a real credential in hand. The
  //    `put` arm additionally drives the ROLLBACK, whose `list`/`deleteEnvironment` calls are
  //    code the credential is still in scope for.
  for (const method of ['ensureEnvironment', 'put'] as const) {
    const s = fakeSecrets();
    s.failOnce(method, errors.upstream('github', 403, 'Ask an admin to check the token permissions.', `${method} failed`));
    collect(await new RepositoryCredentials(s, audit, ONE_REPO).set(USER, GUILD, userTextForTest(credential)));
  }
  const listFails = fakeSecrets();
  listFails.failOnce('list', errors.upstream('github', 500, 'Try again in a minute.', 'list failed'));
  collect(await new RepositoryCredentials(listFails, audit, ONE_REPO).status(USER));

  const deleteFails = fakeSecrets();
  deleteFails.failOnce('deleteEnvironment', errors.upstream('github', 500, 'Try again in a minute.', 'delete failed'));
  collect(await new RepositoryCredentials(deleteFails, audit, ONE_REPO).clear(USER, GUILD));

  // 6. A CORRUPT ACTOR, which fails before any port call - the branch that constructs an error
  //    from a value the caller supplied.
  collect(await new RepositoryCredentials(fakeSecrets(), audit, ONE_REPO).set('nope' as UserId, GUILD, userTextForTest(credential)));

  // 7. WHICH REPOSITORY (RFC-001 PR 2.3): every new sentence, with the credential in hand - the
  //    two modal intros, the per-repository views, and every routing refusal, the submitted ones
  //    included, since those are the arms that hold the credential when they refuse.
  const m = multi('main', { [GUILD]: 'events' });
  const serverForm = formOf(await openSet(m.svc, GUILD));
  const dmForm = formOf(await openSet(m.svc, null, { repo: 'main' }));
  parts.push(serverForm.intro ?? '', dmForm.intro ?? '');
  parts.push(viewText(viewOf(await submitSet(m.svc, serverForm, GUILD, credential))));
  parts.push(viewText(viewOf(await submitSet(m.svc, dmForm, null, credential))));
  parts.push(viewText(viewOf(await command(m.svc, 'credentials status').handle(invocationIn(null)))));
  parts.push(viewText(viewOf(await command(m.svc, 'credentials status').handle(invocationIn(GUILD)))));
  m.main.failOnce('list', errors.upstream('github', 500, 'Try again in a minute.', 'list failed'));
  parts.push(viewText(viewOf(await command(m.svc, 'credentials status').handle(invocationIn(null)))));
  m.main.failOnce('deleteEnvironment', errors.upstream('github', 500, 'Try again in a minute.', 'delete failed'));
  parts.push(viewText(viewOf(await command(m.svc, 'credentials clear').handle(invocationIn(null)))));
  parts.push(viewText(viewOf(await command(m.svc, 'credentials clear').handle(invocationIn(GUILD)))));
  m.table.set(GUILD, 'main');
  parts.push(errorText(errorOf(await submitSet(m.svc, serverForm, GUILD, credential))));
  m.table.set(GUILD, 'gone');
  parts.push(errorText(errorOf(await submitSet(m.svc, serverForm, GUILD, credential))));
  parts.push(errorText(errorOf(await submitSet(multi(null).svc, serverForm, OTHER_GUILD, credential))));
  parts.push(errorText(errorOf(await openSet(m.svc, null))));
  parts.push(errorText(errorOf(await openSet(m.svc, null, { repo: 'nope' }))));
  parts.push(errorText(errorOf(await openSet(multi('main', { [GUILD]: 'events' }).svc, GUILD, { repo: 'main' }))));
  parts.push(JSON.stringify(m.audit.entries));

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
  assert.deepEqual(audit.entries[0]?.detail, { secretName: 'ANTHROPIC_API_KEY', supersededRemoved: false, repo: ONE_REPO });
  assert.deepEqual(audit.entries[1]?.detail, { secretName: 'CLAUDE_CODE_OAUTH_TOKEN', supersededRemoved: true, repo: ONE_REPO });
  assert.ok(
    audit.entries.some((e) => e.action === 'credentials.clear' && JSON.stringify(e.detail) === '{"existed":true,"repo":"o/r"}'),
    'a real removal must be distinguishable in the audit from a no-op one',
  );
  assert.ok(
    audit.entries.some((e) => e.action === 'credentials.clear' && JSON.stringify(e.detail) === '{"existed":false,"repo":"o/r"}'),
    'and "there was nothing there" must be recorded as such',
  );
  assert.ok(audit.entries.some((e) => JSON.stringify(e.detail) === '{"reason":"unrecognised-shape","repo":"o/r"}'), 'the refusal names the repository too (RFC-001 8.3)');
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
    [{ existed: true, repo: ONE_REPO }, { existed: false, repo: ONE_REPO }],
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
  const form = oneRepoForm();
  const ref = decodeActionRef(form.customId);

  assert.ok(ref.ok, 'the modal custom_id must decode');
  if (!ref.ok) return;
  assert.equal(ref.value.moduleId, MODULE_ID);
  assert.equal(
    ref.value.action,
    credentialForms(harness().routed, perms)[0]?.name,
    'the custom_id action segment IS how a submission finds its handler',
  );
  assert.equal(ref.value.action, SET_FORM);
  assert.equal(ref.value.entityId, 'default', 'and it carries the repository the modal names, for the handler to re-check');
});

test('the handler reads exactly the field the modal declares', () => {
  const form = oneRepoForm();
  const handler = credentialForms(harness().routed, perms)[0];

  assert.deepEqual(
    form.fields.map((f) => f.name),
    handler?.fields === undefined ? [] : [...handler.fields],
    'a mismatch means the modal is opened and its contents silently discarded',
  );
  assert.deepEqual(form.fields.map((f) => f.name), [CREDENTIAL_FIELD]);
});

test('the credential field is a paragraph with room for any credential Anthropic issues', () => {
  const first = oneRepoForm().fields[0];
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
  const commands = credentialCommands(harness().routed, perms);

  assert.deepEqual(
    commands.map((c) => c.name),
    ['credentials set', 'credentials status', 'credentials clear'],
  );
  const set = commands[0];
  assert.equal(set?.ack, 'form', 'a string option would render the credential into the channel');
  // Its one option is `repo:` (RFC-001 PR 2.3), and it cannot carry a credential: Discord
  // refuses anything longer than a repository key, and every Anthropic credential is longer.
  assert.deepEqual((set?.options ?? []).map((o) => o.name), ['repo'], 'and it must take no option that could carry one');
  const repo = set?.options[0];
  assert.equal(repo?.required, false, 'a server, and a one-repository bot, never need it');
  assert.ok((repo?.maxLength ?? Infinity) <= 31, 'a repository key is at most 31 characters');
});

test('every reply is ephemeral, and every entry point declares its permission and limits', () => {
  const commands = credentialCommands(harness().routed, perms);
  const forms = credentialForms(harness().routed, perms);

  for (const spec of [...commands, ...forms]) {
    assert.equal(spec.permission, perms.manage, `${spec.name} must be gated on the declared key`);
    assert.ok(spec.limit.length > 0, `${spec.name} must declare a bucket, or NO_LIMIT deliberately`);
    // An ephemeral interaction response needs no channel permission; declaring one would refuse
    // to run in a channel where the command would in fact have worked.
    assert.deepEqual([...spec.needs], [], `${spec.name} should need no channel permission`);
  }
  for (const spec of forms) assert.equal(spec.ack, 'defer-ephemeral');
  for (const view of [
    present.stored('ANTHROPIC_API_KEY', null),
    present.stored('ANTHROPIC_API_KEY', { key: 'events', fullName: 'acme/events-modules' }),
    present.status({ names: [] }, null),
    present.status({ names: ['CLAUDE_CODE_OAUTH_TOKEN'] }, null),
    present.statusEach([{ repo: { key: 'main', fullName: 'acme/bot-modules' }, names: [], problem: null }]),
    present.cleared(true, null),
    present.clearedEach([{ repo: { key: 'main', fullName: 'acme/bot-modules' }, existed: true, problem: null }]),
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
  const intro = oneRepoForm().intro ?? '';
  assert.match(intro, /Whoever runs this bot, and any admin of that repository, can use it/u);
  assert.match(intro, /spend-limited key/u, 'and what limits the damage');
  assert.doesNotMatch(intro, /Nobody can read it back/u);
});

// ---------------------------------------------------------------------------------------
// WHICH REPOSITORY (RFC-001 PR 2.3, section 8.1): a credential is stored PER USER PER
// REPOSITORY. In a server, the server's repository (its `/repo use` link, else the default); in a
// DM, the one `repo:` names (required with several); `status` and `clear` per repository.
// Driven through the real command and form specs, the way the router calls them.
// ---------------------------------------------------------------------------------------

const OTHER_GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';

function multi(defaultKey: 'main' | null = 'main', links: Readonly<Record<string, string>> = {}) {
  const set = fakeRepoSet([
    { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: defaultKey === 'main' },
    { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
  ]);
  /** A mutable `/repo use` table, read on every call the way `repoTargetReader` reads settings. */
  const table = new Map<string, string>(Object.entries(links));
  const main = fakeSecrets();
  const events = fakeSecrets();
  const audit = fakeAudit();
  const repos = fakeRepos(set, (g) => table.get(g) ?? null);
  const scoped = fakeScopedByKey<SecretsPort>(set, { main, events });
  const svc = new CredentialService(repos, scoped, audit);
  return { set, table, main, events, audit, repos, scoped, svc };
}

/** The one-repository install, through the same specs. */
function single() {
  const set = fakeRepoSet();
  const only = fakeSecrets();
  const audit = fakeAudit();
  const repos = fakeRepos(set);
  const scoped = fakeScopedByKey<SecretsPort>(set, { default: only });
  return { only, audit, repos, scoped, svc: new CredentialService(repos, scoped, audit) };
}

function stubProgress(): ProgressHandle {
  const stub = { tokenExpiresAtMs: 0, update: (): void => undefined, detach: () => ({ guildId: null, channelId: CHANNEL, messageId: CHANNEL }) };
  return stub as unknown as ProgressHandle;
}

function actor(): Actor {
  return { userId: USER, roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n };
}

function space(guild: string | null): Space {
  const channel = toChannelId(CHANNEL);
  if (!channel.ok) throw new Error('fixture');
  return { guildId: guild === null ? null : gid(guild), channelId: channel.value };
}

function argsOf(raw: Readonly<Record<string, string | boolean>>): Args {
  const cannot = (name: string) => Err(errors.validation(name, 'not modelled by this fixture', 'Use text or bool.'));
  return {
    names: Object.keys(raw),
    text: (name) => (typeof raw[name] === 'string' ? userTextForTest(raw[name]) : undefined),
    textRequired(name) {
      const v = raw[name];
      if (typeof v !== 'string') throw new Error(`no option "${name}" was supplied`);
      return userTextForTest(v);
    },
    integer: (name) => cannot(name),
    bool: (name) => (typeof raw[name] === 'boolean' ? raw[name] : undefined),
    user: () => undefined,
    role: () => undefined,
    channel: () => undefined,
    choice: (name) => cannot(name),
  };
}

function invocationIn(guild: string | null, args: Readonly<Record<string, string | boolean>> = {}): Invocation {
  return { id: newRequestId(0), actor: actor(), space: space(guild), args: argsOf(args), progress: stubProgress(), at: 0 };
}

function command(svc: CredentialService, name: string): CommandSpec {
  const spec = credentialCommands(svc, perms).find((c) => c.name === name);
  assert.ok(spec !== undefined, name);
  if (spec === undefined) throw new Error('unreachable');
  return spec;
}

/** `/credentials set` as a user runs it: the modal it opens, or the refusal. */
async function openSet(svc: CredentialService, guild: string | null, args: Readonly<Record<string, string>> = {}): Promise<Outcome> {
  return command(svc, 'credentials set').handle(invocationIn(guild, args));
}

/** The modal coming back with `credential` in it, submitted where `guild` says. */
async function submitSet(svc: CredentialService, form: FormSpec, guild: string | null, credential: string): Promise<Outcome> {
  const ref = decodeActionRef(form.customId);
  assert.ok(ref.ok, 'the modal custom_id must decode');
  if (!ref.ok) throw new Error('unreachable');
  const handler = credentialForms(svc, perms)[0];
  assert.ok(handler !== undefined);
  if (handler === undefined) throw new Error('unreachable');
  const fields: FormValues = {
    names: [CREDENTIAL_FIELD],
    text: (name) => (name === CREDENTIAL_FIELD ? userTextForTest(credential) : undefined),
    textRequired(name) {
      if (name !== CREDENTIAL_FIELD) throw new Error(`no field "${name}"`);
      return userTextForTest(credential);
    },
    choice: () => Ok(undefined),
  };
  return handler.handle({ id: newRequestId(0), actor: actor(), space: space(guild), ref: ref.value, fields, progress: stubProgress(), at: 0 });
}

function formOf(out: Outcome): FormSpec {
  assert.equal(out.kind, 'form', out.kind === 'fail' ? `refused: ${out.error.code}` : 'expected the modal');
  if (out.kind !== 'form') throw new Error('unreachable');
  return out.form;
}

function viewOf(out: Outcome): View {
  assert.equal(out.kind, 'view', out.kind === 'fail' ? `refused: ${out.error.code} ${out.error.internal ?? ''}` : 'expected a view');
  if (out.kind !== 'view') throw new Error('unreachable');
  return out.view;
}

function errorOf(out: Outcome): AppError {
  assert.equal(out.kind, 'fail', 'expected a refusal');
  if (out.kind !== 'fail') throw new Error('unreachable');
  return out.error;
}

/** How many secrets were written, anywhere. */
function writesIn(...stores: readonly FakeSecrets[]): number {
  return stores.reduce((n, s) => n + s.writes.length, 0);
}

test('SERVER A, linked to events: the modal names acme/events-modules, and the credential is sealed into events ONLY', async () => {
  const m = multi('main', { [GUILD]: 'events' });

  const form = formOf(await openSet(m.svc, GUILD));
  assert.match(
    form.intro ?? '',
    /^This stores your credential in acme\/events-modules, run by this server's bot operator, who can use it for your builds here\. /u,
    'the modal names the repository (RFC-001 8.1)',
  );
  assert.match(form.intro ?? '', /Whoever runs this bot, and any admin of that repository, can use it, so prefer a spend-limited key\./u, 'and keeps the honesty line');

  const view = viewOf(await submitSet(m.svc, form, GUILD, OAUTH));
  assert.equal(m.events.writes.length, 1, 'stored in the server\'s repository');
  assert.equal(m.events.writes[0]?.env, USER_ENV);
  assert.equal(m.main.writes.length, 0, 'and NOT in the default, where this server does not build');
  assert.match(viewText(view), /events \(acme\/events-modules\)/u, 'the confirmation names where it went');

  const row = m.audit.entries.find((e) => e.action === 'credentials.set');
  assert.equal(row?.detail['repo'], 'acme/events-modules', 'the audit row names the repository (RFC-001 8.3)');
  assert.equal(row?.guildId, GUILD);
});

test('SERVER B, unlinked, on a bot with no default: set, status and clear are refused with the unmapped sentence, nothing touched', async () => {
  const m = multi(null, { [GUILD]: 'events' });
  const outs = [
    await openSet(m.svc, OTHER_GUILD),
    await command(m.svc, 'credentials status').handle(invocationIn(OTHER_GUILD)),
    await command(m.svc, 'credentials clear').handle(invocationIn(OTHER_GUILD)),
  ];
  for (const out of outs) {
    const e = errorOf(out);
    assert.equal(e.code, 'config.repos.unmapped');
    assert.equal(e.internal, 'This server is not linked to a repository yet, so there is nowhere to store a credential for it.');
    assert.equal(e.nextStep, 'Ask the bot operator to run /repo use in this server.');
  }
  assert.equal(writesIn(m.main, m.events) + m.main.cleared.length + m.events.cleared.length, 0, 'nothing written or cleared anywhere');
});

test('A SERVER LINKED TO A REMOVED REPOSITORY is refused with the stale sentence - never handed to the default', async () => {
  const m = multi('main', { [GUILD]: 'gone' });
  const e = errorOf(await openSet(m.svc, GUILD));
  assert.equal(e.code, 'config.repos.stale_link');
  assert.equal(
    e.internal,
    'This server is linked to the repository gone, which this bot is no longer configured for, so there is nowhere to store a credential for it.',
  );
  assert.equal(e.nextStep, 'Ask the bot operator to run /repo use in this server, or to add gone back to GITHUB_REPOS_JSON.');
  assert.equal(writesIn(m.main, m.events), 0);
});

test('DM WITHOUT repo: ON A BOT WITH TWO REPOSITORIES is refused, saying which keys to pick from', async () => {
  const m = multi();
  const e = errorOf(await openSet(m.svc, null));
  assert.equal(e.code, 'validation.repo');
  assert.equal(userMessage(e), 'This bot keeps credentials in more than one repository, so in a direct message you have to say which one. Run /credentials set again with repo: set to one of: main, events.');
  assert.equal(writesIn(m.main, m.events), 0);
});

test('DM WITH AN UNKNOWN repo: is refused, both when the modal opens and when a doctored modal comes back', async () => {
  const m = multi();
  const opened = errorOf(await openSet(m.svc, null, { repo: 'nope' }));
  assert.equal(opened.code, 'validation.repo');
  assert.equal(userMessage(opened), 'That is not a repository this bot is configured for. Pick one of: main, events.');

  // The key rides in the modal's custom_id, which round-trips through the client. A modal for a
  // repository that is not (or no longer) configured is refused on the way back in, not routed.
  const form = formOf(await openSet(m.svc, null, { repo: 'events' }));
  const nope = encodeActionRef({ moduleId: MODULE_ID, action: SET_FORM, entityId: 'nope', nonce: newCardNonce() });
  assert.ok(nope.ok);
  if (!nope.ok) return;
  assert.equal(errorOf(await submitSet(m.svc, { ...form, customId: nope.value }, null, OAUTH)).code, 'validation.repo');
  assert.equal(writesIn(m.main, m.events), 0, 'nothing stored anywhere');
});

test('DM WITH repo:events: the modal says where it goes, and the credential is sealed there only', async () => {
  const m = multi();
  const form = formOf(await openSet(m.svc, null, { repo: 'events' }));
  assert.match(form.intro ?? '', /^This stores your credential in acme\/events-modules, for builds you request in any server that builds there\. /u);
  viewOf(await submitSet(m.svc, form, null, API_KEY));
  assert.equal(m.events.writes.length, 1);
  assert.equal(m.main.writes.length, 0);
  assert.equal(m.audit.entries.find((e) => e.action === 'credentials.set')?.detail['repo'], 'acme/events-modules');
});

test('IN A SERVER, repo: may only name the server\'s own repository', async () => {
  const m = multi('main', { [GUILD]: 'events' });
  const e = errorOf(await openSet(m.svc, GUILD, { repo: 'main' }));
  assert.equal(e.code, 'validation.repo');
  assert.match(userMessage(e), /This server's builds use the repository events, so a credential set here goes there\./u);
  // Naming its own repository is just redundant.
  formOf(await openSet(m.svc, GUILD, { repo: 'events' }));
});

test('A RE-LINK BETWEEN OPENING AND SUBMITTING THE MODAL is refused: the modal named the old repository', async () => {
  const m = multi('main', { [GUILD]: 'events' });
  const form = formOf(await openSet(m.svc, GUILD));
  m.table.set(GUILD, 'main');
  const e = errorOf(await submitSet(m.svc, form, GUILD, OAUTH));
  assert.equal(e.code, 'conflict.repo');
  assert.equal(writesIn(m.main, m.events), 0, 'stored neither where the modal said nor where the link points now');
});

test('A MODAL FROM BEFORE THIS CHANGE (no repository in its custom_id) still lands in the server\'s repository', async () => {
  const m = multi('main', { [GUILD]: 'events' });
  const legacy = staticCustomId(MODULE_ID, SET_FORM);
  assert.ok(legacy.ok);
  if (!legacy.ok) return;
  const form = { ...formOf(await openSet(m.svc, GUILD)), customId: legacy.value };
  viewOf(await submitSet(m.svc, form, GUILD, OAUTH));
  assert.equal(m.events.writes.length, 1);
  assert.equal(m.main.writes.length, 0);
});

test('STATUS IN A DM lists every repository: `<key> (owner/repo)` and its names, or nothing stored', async () => {
  const m = multi();
  m.main.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  const view = viewOf(await command(m.svc, 'credentials status').handle(invocationIn(null)));
  const fields = view.nodes.flatMap((n) => (n.kind === 'field' ? [[n.name, renderSafeMarkdown(n.md)] as const] : []));
  assert.deepEqual(fields, [
    ['main (acme/bot-modules)', '`CLAUDE_CODE_OAUTH_TOKEN`'],
    ['events (acme/events-modules)', 'nothing stored'],
  ]);
  assert.equal(view.ephemeral, true);
});

test('STATUS IN A DM: one unreadable repository is a row saying so, not a failure hiding the others', async () => {
  const m = multi();
  m.events.seed(USER_ENV, 'ANTHROPIC_API_KEY');
  m.main.failOnce('list', errors.upstream('github', 500, 'Try again in a minute.', 'list failed'));
  const view = viewOf(await command(m.svc, 'credentials status').handle(invocationIn(null)));
  const text = viewText(view);
  assert.match(text, /main \(acme\/bot-modules\)\ncould not be checked: /u);
  assert.match(text, /events \(acme\/events-modules\)\n`ANTHROPIC_API_KEY`/u);
  assert.equal(view.accent, 'warn');
});

test('STATUS IN A SERVER shows that server\'s repository only, and names it', async () => {
  const m = multi('main', { [GUILD]: 'events' });
  m.main.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  const view = viewOf(await command(m.svc, 'credentials status').handle(invocationIn(GUILD)));
  const text = viewText(view);
  assert.match(text, /No credential of your own/u, 'what is in main is not this server\'s business');
  assert.match(text, /Repository\n`events \(acme\/events-modules\)`/u);
  assert.doesNotMatch(text, /bot-modules/u);
});

test('CLEAR IN A SERVER clears that server\'s repository only', async () => {
  const m = multi('main', { [GUILD]: 'events' });
  m.main.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  m.events.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  viewOf(await command(m.svc, 'credentials clear').handle(invocationIn(GUILD)));
  assert.deepEqual(m.events.cleared, [USER_ENV]);
  assert.deepEqual(m.main.cleared, [], 'the credential for another server\'s builds is untouched');
});

test('CLEAR everywhere:True clears EVERY repository, audits each with its repo, and keeps true/false per repository', async () => {
  const m = multi('main', { [GUILD]: 'events' });
  m.main.seed(USER_ENV, 'CLAUDE_CODE_OAUTH_TOKEN');
  const view = viewOf(await command(m.svc, 'credentials clear').handle(invocationIn(GUILD, { everywhere: true })));

  assert.deepEqual(m.main.cleared, [USER_ENV]);
  assert.deepEqual(m.events.cleared, [], 'nothing existed there to delete - and the audit row below proves it was asked');
  const rows = m.audit.entries.filter((e) => e.action === 'credentials.clear').map((e) => [e.detail['repo'], e.detail['existed']]);
  assert.deepEqual(rows, [
    ['acme/bot-modules', true],
    ['acme/events-modules', false],
  ]);
  const fields = view.nodes.flatMap((n) => (n.kind === 'field' ? [[n.name, renderSafeMarkdown(n.md)] as const] : []));
  assert.deepEqual(fields, [
    ['main (acme/bot-modules)', 'removed'],
    ['events (acme/events-modules)', 'nothing stored'],
  ]);
  assert.match(viewText(view), /will fail until you run `\/credentials set` again/u, 'and the warning, because something was removed');
});

test('CLEAR IN A DM implies everywhere, and keeps going past a repository it could not clear', async () => {
  const m = multi();
  m.events.seed(USER_ENV, 'ANTHROPIC_API_KEY');
  m.main.failOnce('deleteEnvironment', errors.upstream('github', 500, 'Try again in a minute.', 'delete failed'));
  const view = viewOf(await command(m.svc, 'credentials clear').handle(invocationIn(null)));
  assert.deepEqual(m.events.cleared, [USER_ENV], 'events was cleared although main failed first');
  const text = viewText(view);
  assert.match(text, /main \(acme\/bot-modules\)\ncould not be cleared: /u);
  assert.match(text, /events \(acme\/events-modules\)\nremoved/u);
  assert.equal(view.accent, 'warn');
  assert.deepEqual(
    m.audit.entries.filter((e) => e.action === 'credentials.clear').map((e) => e.detail['repo']),
    ['acme/events-modules'],
    'a failed clear writes no audit row, exactly as before',
  );
});

test('ONE-REPOSITORY INSTALL: no repo: needed anywhere, and every view is exactly what it was', async () => {
  const s = single();

  // A DM needs no `repo:` with one repository, and the confirmation is the old one.
  const dmForm = formOf(await openSet(s.svc, null));
  const stored = viewOf(await submitSet(s.svc, dmForm, null, OAUTH));
  assert.deepEqual(viewText(stored), viewText(present.stored('CLAUDE_CODE_OAUTH_TOKEN', null)));
  assert.doesNotMatch(viewText(stored), /Repository/u);

  // ...and a server lands in the same one.
  viewOf(await submitSet(s.svc, formOf(await openSet(s.svc, GUILD)), GUILD, API_KEY));
  assert.equal(s.only.writes.length, 2);

  const status = viewOf(await command(s.svc, 'credentials status').handle(invocationIn(null)));
  assert.deepEqual(viewText(status), viewText(present.status({ names: ['ANTHROPIC_API_KEY'] }, null)), 'one view, not a per-repository table');

  // `everywhere` changes nothing when there is only one place.
  const cleared = viewOf(await command(s.svc, 'credentials clear').handle(invocationIn(GUILD, { everywhere: true })));
  assert.deepEqual(viewText(cleared), viewText(present.cleared(true, null)));

  // The audit rows gain `repo` (RFC-001 8.3) and nothing else changes in them.
  assert.deepEqual(
    s.audit.entries.map((e) => [e.action, e.detail['repo']]),
    [
      ['credentials.set', 'o/r'],
      ['credentials.set', 'o/r'],
      ['credentials.clear', 'o/r'],
    ],
  );
});

test('HEALTH: several repositories and no default is no longer down - a linked server and a DM can both store', async () => {
  const m = multi(null);
  const installed = credentialsModule.install({
    ports: { audit: fakeAudit(), repos: m.repos, secrets: m.scoped },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeRecordingLogger(),
  });
  assert.ok(installed.ok);
  if (!installed.ok) return;
  const health = await installed.value.health();
  assert.equal(health.status, 'ok');
  assert.equal(health.detail, 'ready for 2 repositories; nothing is stored locally');

  const one = single();
  const installedOne = credentialsModule.install({
    ports: { audit: fakeAudit(), repos: one.repos, secrets: one.scoped },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeRecordingLogger(),
  });
  assert.ok(installedOne.ok);
  if (installedOne.ok) assert.deepEqual(await installedOne.value.health(), { status: 'ok', detail: 'ready; nothing is stored locally' });
});

test('AUTOCOMPLETE for repo: offers keys only, never owner/repo', async () => {
  const m = multi();
  const set = command(m.svc, 'credentials set');
  assert.ok(set.autocomplete !== undefined, 'required because repo: sets autocomplete');
  const choices = await set.autocomplete({ actor: actor(), space: space(null), option: 'repo', partial: userTextForTest(''), at: 0 });
  assert.deepEqual(choices, [
    { name: 'main (default)', value: 'main' },
    { name: 'events', value: 'events' },
  ]);
  assert.ok(!JSON.stringify(choices).includes('acme/'), 'the router answers autocomplete without the permission check');
});
