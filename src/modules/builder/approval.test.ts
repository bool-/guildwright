/**
 * THE APPROVAL ID'S LIFE ON THE ROW: minted by the click, written in the same statement that
 * wins the race, re-sent on every dispatch attempt, replaced by a retry, refused when absent,
 * and used to find the earlier run when the repository reports a replay.
 *
 * WHY THESE ARE STATE-MACHINE TESTS OVER A REAL DATABASE: every property here is about WHICH
 * statement writes WHICH column, and `fakeDb` reports one row changed whatever it is asked.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Err, Ok } from '#core/result';
import { errors } from '#core/errors';
import type { ClickInvocation } from '#core/module';
import { newCardNonce, newRequestId, toCardNonce, type RequestId } from '#core/ids';
import type { BuildsPort, RunReport } from '#core/ports';
import { actionsToken, parseHttpsUrl, renderActionsToken } from '#core/text';
import {
  CHANNEL,
  GUILD,
  HOUR,
  NOW,
  REQUESTER,
  RUN_URL,
  SURFACE,
  channelId,
  commandOf,
  guildId,
  harness,
  invocation,
  payloadFor,
  progress,
  runtime,
  seedAwaiting,
  seedDispatching,
  seedRunning,
  userId,
  type Harness,
} from '#modules/builder/harness.test';

const APPROVER = '555555555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function approveClick(h: Harness, id: RequestId, actorId = APPROVER): ClickInvocation {
  const nonce = toCardNonce(h.repo.get(id)?.nonce ?? '');
  return {
    id: newRequestId(NOW),
    actor: { userId: userId(actorId), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action: 'approve', entityId: id, nonce: nonce.ok ? nonce.value : newCardNonce() },
    surface: SURFACE,
    progress: progress(),
    at: NOW,
  };
}

function approveAction(h: Harness) {
  const approve = h.installed.actions.find((a) => a.name === 'approve');
  assert.ok(approve !== undefined, 'the builder must declare an approve action');
  if (approve === undefined) throw new Error('unreachable');
  return approve;
}

test('Approve mints an approval id and writes it IN the compare-and-set, so only the winner holds one', async () => {
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    assert.equal(h.repo.get(id)?.approvalId, null, 'nothing is approved yet');

    const first = await approveAction(h).handle(approveClick(h, id));
    assert.equal(first.kind, 'handoff', 'the first approver wins and hands off to the build job');

    const row = h.repo.get(id);
    assert.equal(row?.state, 'dispatching');
    assert.match(row?.approvalId ?? '', UUID, 'the row now carries the approval id');
    assert.equal(row?.approvalIssuedAt, null, 'not signed yet: the dispatch pass stamps that');
    assert.equal(row?.firstDispatchAt, null);

    // THE RACE. A second click holding the same card nonce loses the CAS and must not touch the
    // id the winner wrote - the statement that writes it is the statement that wins.
    const held = row?.approvalId;
    const second = await approveAction(h).handle(approveClick(h, id, '666666666666666666'));
    assert.equal(second.kind, 'fail', 'the second approver loses');
    assert.equal(h.repo.get(id)?.approvalId, held, 'and the winner\'s id is untouched');

    // The audit row and the payload no longer disagree about which id is live.
    const audited = h.audit.entries.find((r) => r.action === 'builder.approve');
    assert.equal(audited?.detail?.['approvalId'], held, 'the audit names the id the row holds');
  } finally {
    h.close();
  }
});

test('the dispatch pass signs the row\'s approval id and issue time, sends both, and stamps the row', async () => {
  const h = harness();
  try {
    const id = seedDispatching(h.repo, 42);
    const approvalId = h.repo.get(id)?.approvalId;
    assert.ok(approvalId !== null && approvalId !== undefined);

    h.setNow(NOW + 5 * HOUR + 1234); // approved hours ago, dispatching now
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'retry', 'dispatched; now polling');

    assert.equal(h.dispatched.length, 1);
    const sent = h.dispatched[0] ?? {};
    // Compared against the same producer the module uses, never by opening the brand.
    assert.deepEqual(sent['approval_id'], actionsToken.uuid(approvalId), 'approval_id input is the row\'s id');
    const issuedAtSec = Math.floor((NOW + 5 * HOUR + 1234) / 1000);
    assert.equal(sent['approval_issued_at'], issuedAtSec, 'approval_issued_at is the dispatch instant in seconds, not the click');

    const signed = h.builds.signed[0] ?? {};
    assert.equal(signed['approvalId'], approvalId, 'the same id is signed');
    assert.equal(signed['issuedAtSec'], issuedAtSec, 'with the same instant');

    const row = h.repo.get(id);
    assert.equal(row?.approvalIssuedAt, NOW + 5 * HOUR + 1234, 'the row remembers when this attempt was signed');
    assert.equal(row?.firstDispatchAt, NOW + 5 * HOUR + 1234, 'and when the first attempt was made');
  } finally {
    h.close();
  }
});

test('first_dispatch_at is written once; approval_issued_at follows every attempt', async () => {
  // Attempt 1's POST fails; attempt 2 succeeds twenty minutes later. The search for an earlier
  // run of this approval has to start from attempt 1, not attempt 2.
  let calls = 0;
  const h = harness({}, {
    async dispatch() {
      calls += 1;
      // Ports return Results and never throw; a transient upstream failure is the retryable kind.
      if (calls === 1) return Err(errors.upstream('github', 0, 'Try again in a minute.', 'socket hang up'));
      const runUrl = parseHttpsUrl('https://github.com/o/r/actions/runs/1');
      if (!runUrl.ok) throw new Error('fixture');
      return Ok({ kind: 'adopted', run: { runId: 1, runUrl: runUrl.value } });
    },
  });
  try {
    const id = seedDispatching(h.repo, 42);
    const first = NOW + 1000;
    h.setNow(first);
    const a = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(a.kind, 'retry', 'attempt 1 failed at the network and is retried');
    assert.equal(h.repo.get(id)?.firstDispatchAt, first);
    assert.equal(h.repo.get(id)?.approvalIssuedAt, first);

    const second = first + 20 * 60_000;
    h.setNow(second);
    const b = await h.build.run(payloadFor(id, 42), runtime(2));
    assert.equal(b.kind, 'retry', 'attempt 2 dispatched');
    assert.equal(h.repo.get(id)?.firstDispatchAt, first, 'the first instant stands');
    assert.equal(h.repo.get(id)?.approvalIssuedAt, second, 'the signed instant moved with the attempt');
    assert.equal(h.repo.get(id)?.approvalId, h.repo.get(id)?.approvalId, 'same approval across attempts');
    assert.equal(h.builds.signed.length, 2);
    assert.equal(h.builds.signed[0]?.['approvalId'], h.builds.signed[1]?.['approvalId'], 'both attempts sign the SAME id - a retry of the POST is not a new approval');
  } finally {
    h.close();
  }
});

test('a dispatching row with NO approval id is refused and finished failed, so /request retry can re-arm it', async () => {
  // The legacy shape: approved before migration 0004 and still waiting at the restart. An id is
  // not minted for it silently; the honest path is one retry.
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    h.repo.compareAndSet(id, h.repo.get(id)?.version ?? 0, 'dispatching', NOW); // the old four-argument shape
    assert.equal(h.repo.get(id)?.approvalId, null);

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.error.code, 'conflict.no_approval_id');
    assert.equal(h.dispatched.length, 0, 'nothing was dispatched and nothing was spent');
    assert.equal(h.repo.get(id)?.state, 'failed', 'finished, so the slot is released and retry accepts it');

    // ...and retry mints a fresh id into the re-armed row.
    const retried = await commandOf(h, 'request retry').handle(invocation({ args: { id }, actorId: REQUESTER }));
    assert.equal(retried.kind, 'view', 'retry accepted the failed row');
    const row = h.repo.get(id);
    assert.equal(row?.state, 'dispatching');
    assert.match(row?.approvalId ?? '', UUID, 'retry wrote a fresh approval id');
    assert.equal(row?.firstDispatchAt, null, 'and cleared the attempt stamps for the new approval');
  } finally {
    h.close();
  }
});

test('a POLLING pass never needs the id, so a legacy running row keeps polling', async () => {
  const h = harness({}, {
    runStatus: async () => Ok({ kind: 'in-progress', runUrl: null }),
  });
  try {
    const id = seedAwaiting(h.repo, 42);
    h.repo.compareAndSet(id, h.repo.get(id)?.version ?? 0, 'dispatching', NOW);
    h.repo.recordRun(id, 9, RUN_URL, NOW);
    assert.equal(h.repo.get(id)?.approvalId, null);

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'retry', 'still building; the missing id is irrelevant to a poll');
  } finally {
    h.close();
  }
});

test('retry mints a FRESH approval id - the old one has been consumed by the repository', async () => {
  const h = harness();
  try {
    const id = seedDispatching(h.repo, 42);
    const original = h.repo.get(id)?.approvalId;
    h.repo.finish(id, 'failed', NOW);

    const retried = await commandOf(h, 'request retry').handle(invocation({ args: { id }, actorId: REQUESTER }));
    assert.equal(retried.kind, 'view');
    const fresh = h.repo.get(id)?.approvalId;
    assert.match(fresh ?? '', UUID);
    assert.notEqual(fresh, original, 'a retry is a new spend and a new approval');
  } finally {
    h.close();
  }
});

/** A run report saying the repository refused this run because the approval was already used. */
function replayedReport(): RunReport {
  return { failedStep: 'approval_replayed', stop: null, turns: null, agent: null };
}

test('on approval_replayed the bot ADOPTS its own earlier run instead of drawing a failure', async () => {
  // The honest case: attempt 1's POST created run 7 but the answer never arrived; attempt 2
  // created run 9 with the same approval id, and the repository refused run 9. Run 7 is the
  // build the requester paid for.
  const searches: { runName: string; sinceMs: number; excludeRunId: number | undefined }[] = [];
  const earlier = parseHttpsUrl('https://github.com/o/r/actions/runs/7');
  if (!earlier.ok) throw new Error('fixture');
  const findRunByName: BuildsPort['findRunByName'] = async (runName, sinceMs, excludeRunId) => {
    searches.push({ runName: renderActionsToken(runName), sinceMs, excludeRunId });
    return Ok({ runId: 7, runUrl: earlier.value });
  };
  const h = harness({}, {
    findRunByName,
    runStatus: async () => Ok({ kind: 'failure', runUrl: null, detail: 'failure' }),
  });
  try {
    const id = seedRunning(h.repo, 42, 9);
    const approvalId = h.repo.get(id)?.approvalId ?? '';
    // Stamp the attempts the way the dispatch pass would have: first attempt an hour ago.
    h.repo.countDispatchAttempt(id, NOW - HOUR);
    h.repo.countDispatchAttempt(id, NOW - 60_000);
    h.builds.report = replayedReport();

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'retry', 'the poller keeps going - on the adopted run');

    assert.equal(searches.length, 1);
    assert.equal(searches[0]?.runName, approvalId, 'searched by the approval id the run name carries');
    assert.equal(searches[0]?.excludeRunId, 9, 'excluding the refused run, whose name carries the same id');
    assert.equal(searches[0]?.sinceMs, NOW - HOUR - 300_000, 'from the FIRST attempt minus skew, not the latest attempt');

    const row = h.repo.get(id);
    assert.equal(row?.state, 'running');
    assert.equal(row?.runId, 7, 'the row now follows run 7');
    assert.equal(row?.runUrl, 'https://github.com/o/r/actions/runs/7');
    assert.ok(h.audit.entries.some((r) => r.action === 'builder.run_adopted'), 'and says so in the audit');
  } finally {
    h.close();
  }
});

test('on approval_replayed with NO earlier run of ours, the refusal is reported as a failure', async () => {
  // Somebody re-dispatched a token they read out of a log, and the repository refused it. There
  // is no run of ours to adopt, so this is an ending, and the card names it.
  const h = harness({}, {
    findRunByName: async () => Ok(null),
    runStatus: async () => Ok({ kind: 'failure', runUrl: null, detail: 'failure' }),
  });
  try {
    const id = seedRunning(h.repo, 42, 9);
    h.builds.report = replayedReport();

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.error.code, 'conflict.run_approval_replayed');
    assert.equal(h.repo.get(id)?.state, 'failed');
  } finally {
    h.close();
  }
});

test('an approval the repository found too old is a failure that points at retry', async () => {
  const h = harness({}, { runStatus: async () => Ok({ kind: 'failure', runUrl: null, detail: 'failure' }) });
  try {
    const id = seedRunning(h.repo, 42, 9);
    h.builds.report = { failedStep: 'approval_expired', stop: null, turns: null, agent: null };

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.error.code, 'conflict.run_approval_expired');
    assert.match(outcome.error.nextStep, /\/request retry/u);
  } finally {
    h.close();
  }
});

test('the unique index: two live rows cannot share an approval id', () => {
  const h = harness();
  try {
    const a = seedDispatching(h.repo, 1);
    const b = seedAwaiting(h.repo, 2);
    const held = h.repo.get(a)?.approvalId ?? '';
    assert.throws(
      () => h.repo.approveForDispatch({ id: b, expectVersion: h.repo.get(b)?.version ?? 0, repoKey: 'default', at: NOW, maxConcurrentPerRepo: 9, approvalId: held }),
      /UNIQUE|constraint/iu,
      'the database refuses, so no code path can make two rows spend one approval',
    );
  } finally {
    h.close();
  }
});
