/**
 * `/request list`, `/request cancel`, `/request retry` - the three commands whose ABSENCE was
 * the product's worst edge.
 *
 * WHAT A REQUESTER COULD DO BEFORE THIS FILE EXISTED: submit, and then nothing. There was no
 * history (the card was the only record, and a card scrolls away), no way to withdraw a request
 * they regretted (it held a concurrency slot for 48 hours regardless), and no way to re-run a
 * failed build (the only move was to retype the whole idea and file a second issue). And an
 * APPROVER could not discover that anything was waiting for them at all - the pending queue was
 * invisible, which is why requests sat unclicked until the expiry sweep collected them.
 *
 * THE TWO SPEND RULES THESE TESTS EXIST TO PIN, because both are one careless edit from being
 * lost:
 *
 *   1. A retry is a FRESH REQUEST for spend purposes - credential gate, concurrency cap,
 *      `maxRetries` - or it is a door straight past "no free builds".
 *   2. An EXPIRED request has never been approved, so retrying it goes back to
 *      `awaiting_approval` and NOT to `dispatching`. Otherwise anybody buys a build by waiting
 *      two days.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { errors, userMessage } from '#core/errors';
import { Err, Ok } from '#core/result';
import { buildEnvironmentName } from '#core/text';
import { newCardNonce, newFenceNonce, newRequestId } from '#core/ids';
import type { CommandSpec, Outcome } from '#core/module';
import { buildDedupeKey } from '#modules/builder/module';
import {
  GUILD,
  ISSUE_URL,
  NOW,
  PR_URL,
  REQUESTER,
  RUN_URL,
  SEED_SLOTS,
  SURFACE,
  commandOf,
  fieldNames,
  harness,
  headings,
  invocation,
  lastEdit,
  lastPost,
  seedAwaiting,
  seedDispatching,
  seedRunning,
  textOf,
  type Harness,
} from '#modules/builder/harness.test';

const OTHER = '999999999999999999';
const APPROVER = '555555555555555555';

function failureText(outcome: Outcome): string {
  assert.equal(outcome.kind, 'fail', `expected a refusal, got "${outcome.kind}"`);
  return outcome.kind === 'fail' ? userMessage(outcome.error) : '';
}

function viewOf(outcome: Outcome) {
  assert.equal(outcome.kind, 'view', `expected a view, got "${outcome.kind}"`);
  if (outcome.kind !== 'view') throw new Error('unreachable');
  return outcome.view;
}

/** A row belonging to somebody else, so "only mine" can be proved rather than assumed. */
function seedForOther(h: Harness, issueNumber: number, requesterId = OTHER): string {
  const id = newRequestId(NOW);
  const claimed = h.repo.claimSlot(
    {
      id,
      state: 'draft',
      version: 1,
      guildId: GUILD,
      requesterId,
      nonce: newCardNonce(),
      fenceNonce: newFenceNonce(),
      title: `Somebody else's idea ${String(issueNumber)}`,
      issueNumber: null,
      issueUrl: null,
      runId: null,
      runUrl: null,
      dispatchAttempts: 0,
      succeededAt: null,
      surfaceJson: null,
    },
    NOW,
    SEED_SLOTS,
  );
  assert.ok(claimed, 'fixture: the seeded request must claim a slot');
  h.repo.recordIssue(id, issueNumber, ISSUE_URL, SURFACE, NOW);
  return id;
}

function toState(h: Harness, id: string, state: 'failed' | 'expired' | 'done' | 'pr_open'): void {
  const row = h.repo.get(id as never);
  assert.ok(row !== undefined, 'fixture: the row must exist');
  h.repo.finish(row.id, state, NOW);
}

// ---------------------------------------------------------------------------------------
// /request list
// ---------------------------------------------------------------------------------------

test('/request list answers "what happened to mine?", which nothing could answer before', async () => {
  const h = harness();
  try {
    const mine = seedAwaiting(h.repo, 42);
    seedForOther(h, 43);

    const view = viewOf(await commandOf(h, 'request list').handle(invocation()));
    const said = textOf(view);

    assert.deepEqual(headings(view), ['Your build requests']);
    assert.match(said, /Add a \/ping command/u, 'the stored title is what makes a list readable');
    assert.ok(said.includes(mine), 'the id must be shown, because /request cancel and retry take it');
    assert.ok(
      fieldNames(view).some((n) => n.includes('Waiting for an approver')),
      `a state a human can read, not \`awaiting_approval\`; fields were ${fieldNames(view).join(' | ')}`,
    );
    assert.doesNotMatch(said, /Somebody else/u, 'and it is MY list');
    assert.equal(view.ephemeral, true, 'what I asked for is my business, not the channel’s');
  } finally {
    h.close();
  }
});

test('an empty list says how to start, instead of showing an empty table', async () => {
  const h = harness();
  try {
    const said = textOf(viewOf(await commandOf(h, 'request list').handle(invocation())));
    assert.match(said, /\/request new/u);
  } finally {
    h.close();
  }
});

test('/request list all shows an APPROVER the queue that was previously invisible', async () => {
  const h = harness();
  try {
    seedForOther(h, 43);
    h.setApprover(true);

    const view = viewOf(await commandOf(h, 'request list').handle(invocation({ actorId: APPROVER, args: { all: true } })));
    assert.deepEqual(headings(view), ['Waiting for an approver']);
    assert.match(textOf(view), /Somebody else/u, 'including requests the approver did not open');
    assert.match(textOf(view), /closest to expiring/u, 'oldest first, because that one has least time left');
  } finally {
    h.close();
  }
});

test('/request list all is refused to somebody who cannot approve, and says who can grant it', async () => {
  const h = harness();
  try {
    seedForOther(h, 43);
    h.setApprover(false);

    const said = failureText(await commandOf(h, 'request list').handle(invocation({ args: { all: true } })));
    assert.match(said, /access grant builder\.approve/u, 'a refusal with no next step is the dead end this round removes');

    // And the plain form still works for the same person: the gate is on the `all` branch, not
    // on the command, or a requester could not see their own work.
    assert.equal((await commandOf(h, 'request list').handle(invocation())).kind, 'view');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// /request cancel
// ---------------------------------------------------------------------------------------

test('a requester can withdraw their own request: slot back, issue closed, card resolved', async () => {
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    assert.deepEqual(h.repo.activeCounts(GUILD), { waiting: 1, running: 0, filing: 0 });

    const out = await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view');

    assert.equal(h.repo.get(id)?.state, 'cancelled');
    assert.deepEqual(h.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 }, 'the slot comes back at once');
    assert.deepEqual(h.issues.closed, [42], 'and the issue does not sit open forever');

    const card = lastEdit(h);
    assert.deepEqual(headings(card), ['Cancelled']);
    assert.match(textOf(card), /nothing was charged/u);
    assert.equal(card.mentionUserId, undefined, 'no ping: I am the person who just pressed it');
  } finally {
    h.close();
  }
});

test('somebody who is neither the requester nor an approver cannot cancel it', async () => {
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    h.setApprover(false);

    const said = failureText(await commandOf(h, 'request cancel').handle(invocation({ actorId: OTHER, args: { id } })));
    assert.match(said, /only act on requests you opened/u);
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval', 'and nothing moved');
  } finally {
    h.close();
  }
});

test('an APPROVER can cancel anybody’s — and the requester is pinged, because they did not do it', async () => {
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    h.setApprover(true);

    assert.equal((await commandOf(h, 'request cancel').handle(invocation({ actorId: APPROVER, args: { id } }))).kind, 'view');
    assert.equal(h.repo.get(id)?.state, 'cancelled');

    const card = lastEdit(h);
    assert.equal(card.mentionUserId, REQUESTER, 'somebody else ended my request; I have to be told');
    assert.match(textOf(card), /An approver cancelled this/u);
  } finally {
    h.close();
  }
});

test('CANCELLING A BUILD THE BOT CANNOT NAME A RUN FOR says what it knows, not that a run "keeps going"', async () => {
  // THE HONEST FALLBACK, and the one state that still reaches it now that `BuildsPort.cancelRun`
  // is required. A row in `dispatching` has no `run_id`: the workflow dispatch may or may not
  // have created a run, and there is nothing for a cancel call to name. So the bot frees the
  // slot and stops watching, and something may still be spending the requester's own credentials
  // - which is exactly what the card has to say.
  //
  // THIS TEST USED TO PIN A DIFFERENT CAUSE. It asserted the same wording for "this build has no
  // `cancelRun` port method at all", which was real while `#core/ports` was still being written
  // and stopped being reachable the moment the port landed and the optional companion became
  // required. The WORDING was worth keeping; the reason it was reached was not.
  const h = harness();
  try {
    const id = seedDispatching(h.repo, 42);

    await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));
    assert.equal(h.repo.get(id)?.state, 'cancelled');

    assert.deepEqual(h.builds.cancelled, [], 'there is no run id, so no cancel call could be made');

    const card = lastEdit(h);
    assert.match(
      textOf(card),
      /hadn't found a GitHub run for it/u,
      'the three cancels that reached this state were dispatches GitHub refused - there was no run to keep going',
    );
    assert.doesNotMatch(textOf(card), /keeps going/u);
    assert.match(textOf(card), /cancel it there/u, 'and it still names the one place that could stop one');
  } finally {
    h.close();
  }
});

test('CANCELLING A RUNNING BUILD ASKS GITHUB TO STOP THE RUN — the money the old cancel kept spending', async () => {
  // THE DEFECT THIS CLOSES. `/request cancel` freed the slot, stopped the poller, closed the
  // issue and drew a card - and left the Actions run going, spending the REQUESTER'S OWN
  // Anthropic credentials on a result nobody would ever look at. The card was honest about it,
  // which made it an honest description of the wrong behaviour.
  const asked: number[] = [];
  const h = harness({}, {
    cancelRun: async (runId) => {
      asked.push(runId);
      return Ok({ kind: 'requested' });
    },
  });
  try {
    const id = seedRunning(h.repo, 42, 77);

    const out = await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view');
    assert.deepEqual(asked, [77], 'the RUN ID off the row, or the cancel reaches nothing');
    assert.equal(h.repo.get(id)?.state, 'cancelled');

    const card = lastEdit(h);
    assert.match(textOf(card), /GitHub is stopping the run/u, 'a 202 is a request GitHub took');
    assert.doesNotMatch(
      textOf(card),
      /could not stop the run/u,
      'the sentence that was true before this round must not survive it',
    );
    // AND IT STILL DOES NOT OVERPROMISE. 202 is a request, not a stopped run, and the branch it
    // pushed stays pushed.
    assert.match(textOf(card), /a branch may be left behind/u, 'a cancel is a request to GitHub, not a guarantee');
  } finally {
    h.close();
  }
});

test('A RUN THAT FINISHED FIRST is reported as 409, not as "we stopped it"', async () => {
  // 202 AND 409 MEAN DIFFERENT THINGS TO THE PERSON READING THE CARD. A run that completed a
  // second before the click cannot be recalled, and it may well have opened a pull request -
  // telling that requester "it is stopping" would send them away from the one thing they now
  // need to look at.
  const h = harness({}, { cancelRun: async () => Ok({ kind: 'already-finished' }) });
  try {
    const id = seedRunning(h.repo, 42, 77);

    const out = await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));
    assert.match(textOf(viewOf(out)), /had already finished/u, 'the private receipt says which of the two happened');

    const card = lastEdit(h);
    assert.match(textOf(card), /already \*\*finished\*\*/u);
    assert.match(textOf(card), /may have opened a pull request/u, 'because it may have, and nobody would look');
    assert.doesNotMatch(textOf(card), /GitHub is stopping the run/u, 'nothing was cancelled - it was over');
  } finally {
    h.close();
  }
});

test('A CANCEL GITHUB REFUSES falls back to the honest wording instead of claiming success', async () => {
  const h = harness({}, {
    cancelRun: async () => Err(errors.upstream('github', 403, 'Grant the token actions: write.')),
  });
  try {
    const id = seedRunning(h.repo, 42, 77);

    await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));
    assert.equal(h.repo.get(id)?.state, 'cancelled', 'the withdrawal itself still succeeds - the row governs spend');
    assert.match(textOf(lastEdit(h)), /could not stop the run/u);

    // THE DIFFERENCE IS RECORDED EVEN THOUGH THE USER SEES THE SAME SENTENCE: "we asked and were
    // refused" is an operator problem (a token without `actions: write`) and "we never asked" is
    // not, and `/admin audit` is where that is established.
    const row = h.audit.entries.find((e) => e.action === 'builder.cancel');
    assert.equal(row?.detail['runCancel'], 'refused');
  } finally {
    h.close();
  }
});

test('NOTHING WAS RUNNING, so nothing is asked of GitHub — a cancel must not invent a run to stop', async () => {
  const asked: number[] = [];
  const h = harness({}, {
    cancelRun: async (runId) => {
      asked.push(runId);
      return Ok({ kind: 'requested' });
    },
  });
  try {
    const id = seedAwaiting(h.repo, 42);

    await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));
    assert.deepEqual(asked, [], 'an unapproved request has no run, and calling cancel on nothing is a 404 nobody needs');
    assert.match(textOf(lastEdit(h)), /Nothing had been built and nothing was charged/u);
  } finally {
    h.close();
  }
});

test('THE SPEND GUARD: a cancelled request that had not dispatched yet never dispatches', async () => {
  // `jobs.cancel` cannot reach an attempt the runner has already leased, so the row's own state
  // has to be the fence. Without the terminal guard at the top of the build job, a request
  // cancelled one second before its first attempt walked into the dispatch branch and SPENT.
  const h = harness();
  try {
    const id = seedDispatching(h.repo, 42);
    await commandOf(h, 'request cancel').handle(invocation({ args: { id } }));

    const outcome = await h.build.run({ requestId: id, issueNumber: 42, surface: SURFACE }, {
      attempt: 1,
      deadlineAtMs: NOW + 3_600_000,
      signal: new AbortController().signal,
      heartbeat: (): void => undefined,
      sleep: async (): Promise<void> => undefined,
    });

    assert.deepEqual(outcome, { kind: 'done' }, 'the poller stops, and it is not a failure');
    assert.equal(h.dispatched.length, 0, 'and NOTHING was dispatched — this is the money test');
  } finally {
    h.close();
  }
});

test('a request that has already finished cannot be cancelled, and the refusal names its state', async () => {
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'pr_open');

    const said = failureText(await commandOf(h, 'request cancel').handle(invocation({ args: { id } })));
    assert.match(said, /Pull request opened/u);
    assert.match(said, /\/request list/u);
  } finally {
    h.close();
  }
});

test('an id from another server reads as NOT FOUND, not as a permission error', async () => {
  // A request id is a ULID and therefore enumerable. "Forbidden" would confirm the id exists;
  // "not found" tells somebody guessing exactly as much as guessing deserves.
  const h = harness();
  try {
    const elsewhere = seedAwaiting(h.repo, 42, NOW, '888888888888888888');
    const said = failureText(await commandOf(h, 'request cancel').handle(invocation({ args: { id: elsewhere } })));
    assert.match(said, /does not exist/u, 'not "you may not touch that one", which would confirm the id');
    assert.equal(h.repo.get(elsewhere)?.state, 'awaiting_approval');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// /request retry
// ---------------------------------------------------------------------------------------

test('a FAILED build is re-dispatched against the same issue, with nothing retyped', async () => {
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'failed');

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view');

    const row = h.repo.get(id);
    assert.equal(row?.state, 'dispatching', 'approved once already, so this really does re-run');
    assert.equal(row?.retryCount, 1);
    assert.equal(row?.runId, null, 'the old run identity is cleared, or a second run cannot be recorded');
    assert.equal(h.issues.created.length, 0, 'and NO second issue was filed — that was the old workaround');

    const enqueued = h.jobs.enqueued.at(-1);
    assert.ok(enqueued !== undefined, 'a poller must exist, or the row sits in `dispatching` forever');
    assert.equal(enqueued?.type, 'build');
    assert.equal(
      enqueued?.dedupeKey,
      buildDedupeKey(id, 1),
      'a retry must not reuse the dead job’s key, or the enqueue is dropped as a duplicate',
    );

    assert.deepEqual(headings(lastEdit(h)), ['Building again'], 'and the card stops saying "Build failed"');
  } finally {
    h.close();
  }
});

test('AN EXPIRED REQUEST GOES BACK TO AN APPROVER — it may not dispatch, because nobody approved it', async () => {
  // THE RULE THIS PINS. An expired request is one NOBODY EVER CLICKED. If `/request retry` sent
  // it to `dispatching`, the spend gate could be walked around by anybody willing to wait out
  // `approvalTtlMs` and then type four words.
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    const before = h.repo.get(id);
    h.repo.compareAndSet(id, before?.version ?? 0, 'expired', NOW);
    const oldNonce = h.repo.get(id)?.nonce;

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view');

    const row = h.repo.get(id);
    assert.equal(row?.state, 'awaiting_approval', 'a human still has to press Approve');
    assert.equal(h.jobs.enqueued.length, 0, 'and nothing was queued to spend');
    assert.equal(h.dispatched.length, 0);
    assert.notEqual(row?.nonce, oldNonce, 'a new nonce, so the dead card’s buttons stay inert');

    const card = lastPost(h);
    assert.deepEqual(headings(card), ['Build request'], 'a fresh card, so an approver sees it arrive');
    assert.match(textOf(card), /Add a \/ping command/u, 'still carrying what is being approved');
  } finally {
    h.close();
  }
});

test('RETRYING AN EXPIRED REQUEST REOPENS ITS ISSUE — an approver must not be sent to a closed one', async () => {
  // THE DEFECT THIS CLOSES. The expiry sweep closes the issue `not_planned`, which is right: an
  // abandoned request should not sit open forever. Re-arming then drew a brand-new Approve/Reject
  // card pointing at that closed issue, and asked somebody to authorise SPEND against it - so the
  // product said "waiting for a decision" while GitHub said "not planned", and the approver's one
  // way to check what they were funding contradicted the card asking them to fund it. Approving
  // would then have handed the agent the same closed issue.
  const reopened: number[] = [];
  const h = harness({}, {}, {
    reopen: async (issueNumber) => {
      reopened.push(issueNumber);
      return Ok(undefined);
    },
  });
  try {
    const id = seedAwaiting(h.repo, 42);
    const before = h.repo.get(id);
    h.repo.compareAndSet(id, before?.version ?? 0, 'expired', NOW);

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view');
    assert.deepEqual(reopened, [42], 'the issue the row actually points at');
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval', 'and it still needs a human to approve it');

    assert.match(textOf(viewOf(out)), /issue was reopened/u, 'and the person retrying is told the state is now consistent');
  } finally {
    h.close();
  }
});

test('a reopen that FAILS does not lose the retry — it says the issue still reads as closed', async () => {
  // The row is already `awaiting_approval` and that is the state governing spend, so failing the
  // whole retry over a GitHub blip would throw away the useful half. But the approver is about to
  // be asked for money against an issue marked "not planned", so silence is not an option either.
  const h = harness({}, {}, {
    reopen: async () => Err(errors.upstream('github', 403, 'Grant the token issues: write.')),
  });
  try {
    const id = seedAwaiting(h.repo, 42);
    h.repo.compareAndSet(id, h.repo.get(id)?.version ?? 0, 'expired', NOW);

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view', 'the retry still lands');
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval');
    assert.match(textOf(viewOf(out)), /could not be reopened/u);
    assert.match(textOf(viewOf(out)), /reopen it by hand/u, 'with the one action that fixes it');

    assert.ok(
      h.audit.entries.some((e) => e.action === 'builder.retry.reopen_failed'),
      'and an operator can find out it happened without reading a card',
    );
  } finally {
    h.close();
  }
});

test('after retrying an expired request the ISSUE IS ACTUALLY OPEN, not merely asked to be', async () => {
  // THE STATE, NOT THE CALL LOG - which is a strictly stronger claim than the test above it, and
  // the reason `fakeIssues` models issue state at all. A `reopened: [42]` assertion reads
  // identically for "closed and then reopened" and for "closed, reopened, and closed again by
  // something else on the way through"; only `isOpen` can tell those apart. What an approver
  // opens is the state, so the state is what has to be asserted.
  //
  // THIS TEST REPLACES ONE THAT PINNED THE DEGRADED PATH - "this build has no `reopen` at all" -
  // which stopped being a reachable state when `IssuesPort.reopen` became required. Both of its
  // real arms (reopened, and refused) are covered by the two tests above; what was missing was
  // anybody checking the outcome rather than the attempt.
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    h.repo.compareAndSet(id, h.repo.get(id)?.version ?? 0, 'expired', NOW);

    // Expiry is what closes it, so close it here the same way, and prove it really is closed
    // before the retry - otherwise "open afterwards" would pass on an issue nothing ever shut.
    await h.issues.close(42, 'not_planned');
    assert.equal(h.issues.isOpen(42), false, 'the expiry left it closed and "not planned"');

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view');
    assert.equal(h.issues.isOpen(42), true, 'an approver is not being asked to fund a declined issue');
    assert.match(textOf(viewOf(out)), /was reopened/u);
  } finally {
    h.close();
  }
});

test('a FAILED build is retried WITHOUT reopening anything — its issue was never closed', async () => {
  // Only expiry (and rejection, and cancellation) closes an issue. Reopening on the redispatch
  // path would be a pointless write, and on a repository where the token cannot do it, a
  // pointless failure to report.
  const reopened: number[] = [];
  const h = harness({}, {}, {
    reopen: async (issueNumber) => {
      reopened.push(issueNumber);
      return Ok(undefined);
    },
  });
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'failed');

    assert.equal((await commandOf(h, 'request retry').handle(invocation({ args: { id } }))).kind, 'view');
    assert.deepEqual(reopened, [], 'a failed build left its issue open');
  } finally {
    h.close();
  }
});

test('a DELIBERATE REFUSAL is not retryable, and the refusal explains why rather than just saying no', async () => {
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'done');

    const said = failureText(await commandOf(h, 'request retry').handle(invocation({ args: { id } })));
    assert.match(said, /deliberately made no changes/u);
    assert.match(said, /ends the same way/u, 'retrying a policy answer is the one wrong move');
    assert.match(said, /GitHub issue/u, 'and the explanation is where the agent left it');
  } finally {
    h.close();
  }
});

test('a request still in flight cannot be retried; it points at cancel instead', async () => {
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    const said = failureText(await commandOf(h, 'request retry').handle(invocation({ args: { id } })));
    assert.match(said, /Building/u);
    assert.match(said, /\/request cancel/u);
  } finally {
    h.close();
  }
});

test('retries are bounded, so a permanently broken request stops costing money', async () => {
  const h = harness({ maxRetries: 1 });
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'failed');

    assert.equal((await commandOf(h, 'request retry').handle(invocation({ args: { id } }))).kind, 'view');
    h.repo.finish(h.repo.get(id)?.id ?? (id as never), 'failed', NOW);

    const said = failureText(await commandOf(h, 'request retry').handle(invocation({ args: { id } })));
    assert.match(said, /already been retried/u);
    assert.match(said, /run log/u, 'and it points at the thing that would actually explain the failure');
  } finally {
    h.close();
  }
});

test('NO FREE BUILDS ON THE RETRY PATH: a requester whose credential is gone is refused', async () => {
  // This is the check that makes a retry a fresh request rather than a way around the gate.
  // Without it, one approved-and-failed build is re-runnable forever by somebody who has since
  // run `/credentials clear`.
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'failed');
    h.builds.environments.delete(buildEnvironmentName(REQUESTER));

    const said = failureText(await commandOf(h, 'request retry').handle(invocation({ args: { id } })));
    assert.match(said, /\/credentials set/u);
    assert.equal(h.repo.get(id)?.state, 'failed', 'and the row did not move');
    assert.equal(h.jobs.enqueued.length, 0);
  } finally {
    h.close();
  }
});

test('a retry faces the same concurrency cap a fresh request does', async () => {
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    const id = seedRunning(h.repo, 42, 77);
    toState(h, id, 'failed');
    seedAwaiting(h.repo, 43); // the guild's single slot, held by something else

    const said = failureText(await commandOf(h, 'request retry').handle(invocation({ args: { id } })));
    assert.match(said, /waiting for an approver/u);
    assert.equal(h.repo.get(id)?.state, 'failed');
  } finally {
    h.close();
  }
});

test('autocomplete offers only what the command can actually act on', async () => {
  const h = harness();
  try {
    const failed = seedRunning(h.repo, 42, 77);
    toState(h, failed, 'failed');
    const live = seedAwaiting(h.repo, 43);

    const retry = commandOf(h, 'request retry');
    assert.ok(retry.autocomplete !== undefined, 'an id option declaring autocomplete MUST answer it');
    const retryChoices = await retry.autocomplete({
      actor: invocation().actor,
      space: invocation().space,
      option: 'id',
      partial: invocation({ args: { id: '' } }).args.textRequired('id'),
      at: NOW,
    });
    assert.deepEqual(
      retryChoices.map((c) => c.value),
      [failed],
      'only a failed or expired request can be retried, so only those are offered',
    );
    assert.match(retryChoices[0]?.name ?? '', /#42/u, 'and the label names the issue and the title, not a raw ULID');

    const cancel = commandOf(h, 'request cancel');
    assert.ok(cancel.autocomplete !== undefined);
    const cancelChoices = await cancel.autocomplete({
      actor: invocation().actor,
      space: invocation().space,
      option: 'id',
      partial: invocation({ args: { id: '' } }).args.textRequired('id'),
      at: NOW,
    });
    assert.deepEqual(cancelChoices.map((c) => c.value), [live], 'and only a LIVE request can be cancelled');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The shape of the command tree, which Discord itself constrains
// ---------------------------------------------------------------------------------------

test('`request` is a container with four subcommands, because Discord forbids the mixed shape', () => {
  // `buildCommandPayloads` refuses a name that is declared both as a leaf and as a subcommand
  // group, so `/request` (the modal) could not survive alongside `/request list`. This is not a
  // preference; it is the only expressible arrangement, and it is why the flagship verb moved.
  const h = harness();
  try {
    const names = h.installed.commands.map((c: CommandSpec) => c.name).sort();
    assert.deepEqual(names, ['request cancel', 'request list', 'request new', 'request retry']);
    assert.ok(!names.includes('request'), 'a leaf `request` here would fail the command deploy outright');
  } finally {
    h.close();
  }
});

test('every management command declares its permission, its limits and its bot permissions', () => {
  // AGENTS.md rule 2: every field is required and there are no defaults, so the interesting
  // assertion is that the SPEND-SHAPED one is limited like the thing it spends on.
  const h = harness();
  try {
    const retry = commandOf(h, 'request retry');
    assert.deepEqual(
      retry.limit,
      [
        { scope: 'user', count: 3, perMs: 3_600_000 },
        { scope: 'guild', count: 20, perMs: 86_400_000 },
      ],
      'a retry dispatches a paid run, so it carries the same two buckets SC-9 puts on the submission',
    );
    for (const name of ['request list', 'request cancel', 'request retry']) {
      const spec = commandOf(h, name);
      assert.ok(spec.limit.length > 0, `${name} must declare a rate limit`);
      assert.deepEqual(spec.needs, ['SendMessages'], `${name} must preflight its bot permissions`);
      assert.equal(spec.surface, 'guild');
    }
  } finally {
    h.close();
  }
});

test('the list and the PR link meet: a finished build shows something to open', async () => {
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    h.repo.recordPrUrl(id, PR_URL, NOW);
    h.repo.finish(id, 'pr_open', NOW);

    const said = textOf(viewOf(await commandOf(h, 'request list').handle(invocation())));
    assert.ok(said.includes(PR_URL), 'the PR URL was learned once and thrown away; now it is kept');
    assert.ok(said.includes(ISSUE_URL));
    assert.doesNotMatch(said, new RegExp(RUN_URL.replace(/\//gu, '\\/'), 'u'), 'the run log is diagnosis, not an outcome');
  } finally {
    h.close();
  }
});
