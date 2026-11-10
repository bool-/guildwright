/**
 * Tests for the fakes themselves.
 *
 * WHY A FAKE NEEDS TESTS: a fake that cannot express a failure mode silently converts every test
 * that uses it into a test of the happy path only. `fakeDb.execute` used to return
 * `{ changes: 1 }` unconditionally, which meant the LOSING arm of a compare-and-set was
 * unreachable from any module test - and that arm is the thing standing between a
 * double-clicked Approve and two paid builds. The suite was green and the defence was untested.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeBuilds, fakeDb, fakeIssues } from '#testing/fakes';
import { sql } from '#core/sql';
import { actionsToken, buildIssueBody, fence, toPlainName, userTextForTest, type IssueBody } from '#core/text';
import { newFenceNonce, newRequestId } from '#core/ids';

/** A real issue body, built the only way the type system permits one to be built. */
function issueBody(): IssueBody {
  const nonce = newFenceNonce();
  const title = toPlainName(userTextForTest('Add a /ping command'), { maxLength: 120 });
  if (!title.ok) throw new Error('fixture title is not a PlainName');
  return buildIssueBody({
    nonce,
    title: title.value,
    fields: [fence('Idea', userTextForTest('do a thing'), nonce, { maxLength: 4000 })],
    meta: { requestId: actionsToken.ulid(newRequestId(1_700_000_000_000)) },
  });
}

test('fakeDb.execute reports a win by default', () => {
  const db = fakeDb('m_test_');
  const result = db.execute(sql`UPDATE ${db.table('rows')} SET state = ${'done'} WHERE id = ${'a'}`);
  assert.equal(result.changes, 1, 'the default arm should model a successful write');
});

test('fakeDb can model a LOST compare-and-set, which is the double-approval defence', () => {
  const db = fakeDb('m_test_');

  // Two approvers click at once. The first UPDATE matches the expected version and wins;
  // the second finds the version already moved and changes nothing.
  db.queueExecute({ changes: 1, lastInsertRowid: 0 }, { changes: 0, lastInsertRowid: 0 });

  const first = db.execute(sql`UPDATE ${db.table('requests')} SET state = ${'approved'} WHERE version = ${1}`);
  const second = db.execute(sql`UPDATE ${db.table('requests')} SET state = ${'approved'} WHERE version = ${1}`);

  assert.equal(first.changes, 1, 'the first approver must win');
  assert.equal(second.changes, 0, 'the second must lose, or both would dispatch a build');
});

test('the queue drains back to the winning default, so one test cannot poison the next', () => {
  const db = fakeDb('m_test_');
  db.queueExecute({ changes: 0, lastInsertRowid: 0 });

  assert.equal(db.execute(sql`UPDATE ${db.table('t')} SET a = ${1}`).changes, 0);
  assert.equal(db.execute(sql`UPDATE ${db.table('t')} SET a = ${1}`).changes, 1);
});

test('fakeDb records the statements it was given, so ownership can be asserted', () => {
  const db = fakeDb('m_builder_');
  db.execute(sql`UPDATE ${db.table('requests')} SET state = ${'rejected'}`);

  assert.equal(db.statements.length, 1);
  assert.match(
    db.statements[0] ?? '',
    /m_builder_requests/u,
    'the prefix must appear, or a module could reach another module’s table',
  );
});

// ---------------------------------------------------------------------------------------
// The three capabilities the modules were given this round. Each is a port method, an adapter
// and a fake - and a fake that can only produce the happy arm is how the unhappy one ships
// untested. These pin that both arms of each are reachable.
// ---------------------------------------------------------------------------------------

test('fakeIssues models the OPEN/CLOSED state, not just the calls that changed it', async () => {
  // `/request retry` has to leave the issue OPEN. A test asserting on the `closed` call log
  // alone cannot tell "closed and never reopened" from "closed, then reopened" - the log reads
  // `[1]` either way, which is the same evidence for the bug and for the fix.
  const issues = fakeIssues();
  const title = toPlainName(userTextForTest('Add a /ping command'), { maxLength: 120 });
  assert.equal(title.ok, true);
  if (!title.ok) return;

  const created = await issues.create({ title: title.value, body: issueBody(), labels: [] });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const n = created.value.number;
  assert.equal(issues.isOpen(n), true, 'a new issue is open');

  assert.equal((await issues.close(n, 'not_planned')).ok, true);
  assert.equal(issues.isOpen(n), false, 'expiry closed it as "we decided against this"');

  assert.equal((await issues.reopen(n)).ok, true);
  assert.equal(issues.isOpen(n), true, 'and a retry must put it back, or the approver is lied to');
  assert.deepEqual([...issues.reopened], [n]);
});

test('fakeBuilds can produce BOTH cancel outcomes, which is why finishedRuns exists', async () => {
  const builds = fakeBuilds();

  const live = await builds.cancelRun(1);
  assert.equal(live.ok, true);
  if (!live.ok) return;
  assert.equal(live.value.kind, 'requested', 'the ordinary cancel: the spend stops here');

  // The race: the run finished a second before the click. The money is already gone, so a card
  // saying "cancelled, nothing was spent" would be wrong - and unreachable in a test if the
  // fake could not model this.
  builds.finishedRuns.add(2);
  const late = await builds.cancelRun(2);
  assert.equal(late.ok, true);
  if (!late.ok) return;
  assert.equal(late.value.kind, 'already-finished');
  assert.deepEqual([...builds.cancelled], [1, 2]);
});

test('fakeBuilds reports all three variable states, and refuses a name GitHub would 404', async () => {
  const builds = fakeBuilds();

  // The default: nobody created the variable, so the workflow's own literal default applies.
  const unset = await builds.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(unset.ok, true);
  if (!unset.ok) return;
  assert.deepEqual(unset.value, { kind: 'unset', name: 'AGENT_DAILY_RUN_CAP' });

  builds.variables.set('AGENT_DAILY_RUN_CAP', '8');
  const drifted = await builds.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(drifted.ok, true);
  if (!drifted.ok) return;
  assert.deepEqual(drifted.value, { kind: 'number', name: 'AGENT_DAILY_RUN_CAP', value: 8 });

  // ` 4 ` looks right to a person and fails the workflow's own `*[!0-9]*` guard, so every build
  // dies in its first seconds. The fake stores the RAW string precisely so this arm exists.
  builds.variables.set('AGENT_DAILY_RUN_CAP', ' 4 ');
  const broken = await builds.repositoryVariable('AGENT_DAILY_RUN_CAP');
  assert.equal(broken.ok, true);
  if (!broken.ok) return;
  assert.deepEqual(broken.value, { kind: 'not-a-number', name: 'AGENT_DAILY_RUN_CAP' });

  // And the refusal the adapter makes, made here too: a name that works offline and 404s in
  // production is worse than no lookup at all.
  assert.equal((await builds.repositoryVariable('../../secrets')).ok, false);
});
