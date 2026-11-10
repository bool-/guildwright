/**
 * The builder over a REPOSITORY SET (RFC-001 PR 2.1): every later step of a request reaches the
 * request's own repository through `.at()` - the dispatch pass, the poll, the expiry sweep - and
 * never a neighbour's.
 *
 * In this version a row's repository is its guild's (`githubForRow`), which with no guild mapping
 * is the default repository; PR 2.2 persists `repo_key` and reads it back through `byKey`. The
 * front door's half of the routing is asserted in `gate.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeRepoSet } from '#testing/fakes';
import { HOUR, NOW, harness, payloadFor, runtime, seedAwaiting, seedDispatching } from '#modules/builder/harness.test';

function twoRepos() {
  return fakeRepoSet([
    { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: true },
    { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
  ]);
}

test('REPO SET: the dispatch pass gates, counts, signs and dispatches in the request\'s repository only', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    const id = seedDispatching(h.repo, 42);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'retry', 'dispatched; now polling');
    assert.equal(h.dispatched.length, 1, 'dispatched in the default repository');
    assert.equal(h.builds.gateChecks, 1, 'whose gate files were the ones checked');
    const events = h.neighbours['events'];
    assert.ok(events !== undefined);
    assert.equal(events?.builds.dispatched.length, 0, 'nothing dispatched in the neighbour');
    assert.equal(events?.builds.gateChecks, 0, 'and its gates were not consulted for this build');
  } finally {
    h.close();
  }
});

test('REPO SET: the expiry sweep closes the issue in the request\'s repository, not its neighbour\'s', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    seedAwaiting(h.repo, 77, NOW - 72 * HOUR);
    await h.expire.run({}, runtime());
    assert.deepEqual(h.issues.closed, [77]);
    assert.deepEqual(h.neighbours['events']?.issues.closed, []);
  } finally {
    h.close();
  }
});

test('REPO SET with NO default: a request already in flight fails its pass rather than guessing a repository', async () => {
  const h = harness(
    {},
    {},
    {},
    fakeRepoSet([
      { key: 'a', owner: 'acme', repo: 'a', isDefault: false },
      { key: 'b', owner: 'acme', repo: 'b', isDefault: false },
    ]),
  );
  try {
    const id = seedDispatching(h.repo, 42);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' ? outcome.error.code : '', 'config.repos.unmapped');
    for (const n of Object.values(h.neighbours)) assert.equal(n.builds.dispatched.length, 0, 'nothing dispatched anywhere');
  } finally {
    h.close();
  }
});

test('REPO SET with NO default: the failed row is FINISHED, so its slot comes back and /request retry accepts it later', async () => {
  const h = harness({}, {}, {}, fakeRepoSet([
    { key: 'a', owner: 'acme', repo: 'a', isDefault: false },
    { key: 'b', owner: 'acme', repo: 'b', isDefault: false },
  ]));
  try {
    const id = seedDispatching(h.repo, 42);
    await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(h.repo.get(id)?.state, 'failed');
  } finally {
    h.close();
  }
});
