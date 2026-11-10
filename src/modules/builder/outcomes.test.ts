/**
 * THE THREE ENDINGS, THE ATTEMPT CEILING, AND THE LINKS.
 *
 * THE COMPOSED PROMPT GIVES THE AGENT THREE LEGITIMATE ENDINGS, and the poller could recognise
 * exactly one of them:
 *
 *   1. it finishes            -> a pull request
 *   2. it cannot finish       -> a DRAFT pull request describing what remains
 *   3. it refuses on purpose  -> NO pull request, and a comment on the issue saying why
 *
 * Ending 3 arrives as a successful run with no PR, which is indistinguishable from "the PR is a
 * second away" unless something bounds the wait. Nothing did, so a deliberate refusal was polled
 * for six hours and then reported as "Build failed" - the opposite of what happened, to the one
 * person who most needed to read the actual reason. Ending 2 was reported as ending 1, so an
 * unfinished draft looked like a finished feature.
 *
 * The rest of this file covers the two defects that made the other outcomes untrustworthy:
 * `dispatch_attempts` was compared and never incremented, so its ceiling could not be reached;
 * and a run that had already FAILED was reported as a retryable error, so the runner re-polled a
 * settled failure for hours while the card still said "Building".
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { readPrDraft } from '#modules/builder/module';
import { newCardNonce, newRequestId, toCardNonce, toChannelId, toGuildId, toUserId, type ChannelId, type GuildId, type UserId } from '#core/ids';
import type { ProgressHandle } from '#core/module';
import type { SurfaceRef } from '#core/view';
import { userTextForTest } from '#core/text';
import { Err, Ok } from '#core/result';
import { errors, isRetryable } from '#core/errors';
import type { JobOutcome, Outcome } from '#core/module';
import { agentBranchName } from '#core/text';
import type { PrRef } from '#core/ports';
import {
  CHANNEL,
  GUILD,
  ISSUE_URL,
  NOW,
  REQUESTER,
  PR_URL,
  RUN_URL,
  SURFACE,
  harness,
  headings,
  lastEdit,
  links,
  okStatus,
  payloadFor,
  prRef,
  runtime,
  seedAwaiting,
  seedDispatching,
  seedRunning,
  textOf,
  url,
  type Harness,
} from '#modules/builder/harness.test';

/** Branded id fixtures, built through the real parsers so nothing here is a shape the bot rejects. */
const ids = {
  user(raw: string): UserId {
    const r = toUserId(raw);
    assert.ok(r.ok);
    if (!r.ok) throw new Error('unreachable');
    return r.value;
  },
  guild(raw: string): GuildId {
    const r = toGuildId(raw);
    assert.ok(r.ok);
    if (!r.ok) throw new Error('unreachable');
    return r.value;
  },
  channel(raw: string): ChannelId {
    const r = toChannelId(raw);
    assert.ok(r.ok);
    if (!r.ok) throw new Error('unreachable');
    return r.value;
  },
};

/** See the note in `expiry.test.ts`: `ProgressHandle` is deliberately unbuildable from fields. */
function progress(): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => ({ guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' }),
  };
  return stub as unknown as ProgressHandle;
}

/** Poll once, with the run reporting success and `findPrForBranch` answering `pr`. */
function succeededWith(pr: PrRef | null, config: unknown = {}): Harness {
  return harness(config, {
    runStatus: () => okStatus('success', RUN_URL),
    findPrForBranch: async (branch) => {
      // The branch is part of the contract: the builder used to look on `bot/issue-<n>` while
      // dispatching `agent/req-<id>`, so the build succeeded, the PR existed, and the link never
      // arrived. Answering only for the right branch keeps that honest.
      return Promise.resolve(branch.startsWith('agent/req-') ? Ok(pr) : Ok(null));
    },
  });
}

function assertDone(outcome: JobOutcome): void {
  assert.equal(outcome.kind, 'done', `expected the job to finish, got "${outcome.kind}"`);
}

// ---------------------------------------------------------------------------------------
// Ending 1 - it worked
// ---------------------------------------------------------------------------------------

test('a finished build reports a pull request, and links to it and to the issue', async () => {
  const h = succeededWith(prRef(null));
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));

    const view = h.discord.drawn.at(-1);
    assert.ok(view !== undefined);
    if (view === undefined) return;

    assert.deepEqual(headings(view), ['Pull request ready']);
    assert.deepEqual(links(view), [
      { label: 'Pull request', url: PR_URL },
      { label: 'Issue', url: ISSUE_URL },
    ]);
    assert.match(textOf(view), /Operator action required/u, 'the nudge survives');
    assert.match(textOf(view), /github\.com\/o\/r\/pull\/7/u, 'and the address is TEXT too, so stripping components cannot lose it');

    assert.equal(h.repo.get(id)?.state, 'pr_open', 'and the slot is released');
    assert.deepEqual(h.prOpened, [{ requestId: id, prUrl: PR_URL }], 'subscribers hear about it');
  } finally {
    h.close();
  }
});

test('the branch searched is the branch dispatched', async () => {
  // A silent never-deliver, asserted directly: `agentBranchName` builds both sides.
  const h = succeededWith(prRef(null));
  try {
    const id = seedRunning(h.repo, 42, 77);
    assert.match(agentBranchName(id), /^agent\/req-/u);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));
    assert.deepEqual(headings(h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] }), ['Pull request ready']);
  } finally {
    h.close();
  }
});

test('ONE MESSAGE PER ENDING: the final card is posted, the stale card deleted, and the row follows it', async () => {
  // Every ending used to be an edit plus a second "notice" repeating it, because an edit pings
  // nobody. Now the ending IS the post, and the card it replaces goes away.
  const h = succeededWith(prRef(false));
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));

    assert.equal(h.discord.posted.length, 1, 'exactly one message is posted');
    assert.equal(h.discord.edited.length, 0, 'and nothing is edited alongside it');
    assert.deepEqual(h.discord.deleted, [SURFACE], 'the stale card is deleted');
    assert.notEqual(h.repo.get(id)?.surfaceJson, JSON.stringify(SURFACE), 'and the row now points at the new message');
  } finally {
    h.close();
  }
});

test('the agent summary from the run report rides on the ready card', async () => {
  const h = succeededWith(prRef(false));
  h.builds.report = { failedStep: null, stop: 'success', turns: 40, agent: { status: 'done', summary: 'Added /remind.', remaining: '' } };
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));
    assert.match(textOf(h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] }), /Added \/remind\./u);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// Ending 2 - it could not finish
// ---------------------------------------------------------------------------------------

test('a DRAFT pull request is reported as unfinished, not as a delivered feature', async () => {
  // "Here is your feature" and "here is a half-finished attempt" ask completely different things
  // of the reader, and reporting the second as the first is how an unfinished branch gets merged.
  const h = succeededWith(prRef(true));
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));

    const view = h.discord.drawn.at(-1);
    assert.ok(view !== undefined);
    if (view === undefined) return;

    assert.deepEqual(headings(view), ['Pull request opened - unfinished']);
    assert.match(textOf(view), /could not finish/u);
    assert.deepEqual(links(view), [
      { label: 'Pull request', url: PR_URL },
      { label: 'Issue', url: ISSUE_URL },
    ]);

    assert.equal(h.repo.get(id)?.state, 'pr_open', 'a draft PR is still a PR');
    assert.equal(h.prOpened.length, 1, 'and subscribers still hear about it');
  } finally {
    h.close();
  }
});

test('a pull request the port says is NOT a draft reads exactly as before', async () => {
  const h = succeededWith(prRef(false));
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));
    assert.deepEqual(headings(h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] }), ['Pull request ready']);
  } finally {
    h.close();
  }
});

test('a RED run that opened a PR before hitting the turn limit reports the PR, not "Build failed"', async () => {
  // THE #7 DEFECT: the agent opened its pull request, then used up its turns, and the action
  // marked the run failed - so the requester was told the build failed about a PR ready to merge.
  const h = harness(
    {},
    {
      runStatus: () => Promise.resolve(Ok({ kind: 'failure', runUrl: url(RUN_URL), detail: 'conclusion "failure"' })),
      findPrForBranch: () => Promise.resolve(Ok(prRef(false))),
    },
  );
  h.builds.report = { failedStep: 'agent', stop: 'error_max_turns', turns: 150, agent: null };
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));
    const view = h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] };
    assert.deepEqual(headings(view), ['Pull request opened - unfinished']);
    assert.match(textOf(view), /all 150 of its turns/u);
    assert.equal(h.repo.get(id)?.state, 'pr_open');
  } finally {
    h.close();
  }
});

test('a PR that touched a forbidden path is BLOCKED - never reported as ready', async () => {
  const h = succeededWith(prRef(false));
  h.builds.report = { failedStep: 'forbidden_path', stop: 'success', turns: 30, agent: { status: 'done', summary: 'Done.', remaining: '' } };
  try {
    const id = seedRunning(h.repo, 42, 77);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));
    assert.deepEqual(headings(h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] }), ['Blocked - do not merge']);
    assert.equal(h.repo.get(id)?.state, 'failed');
    assert.equal(h.prOpened.length, 0, 'nothing announces a PR nobody should merge');
  } finally {
    h.close();
  }
});

test('readPrDraft answers null when the port cannot say, and upgrades by itself when it can', () => {
  // `PrRef` is `{ number, url, branch }` and widening it is a core change this module may not
  // make. So draft detection is a TOLERANT read: it compiles either way, and the moment the port
  // carries `isDraft` this returns a real boolean and `draftPrCard` starts being reached with no
  // further edit here. Until then it returns null and a draft reads as an ordinary PR - today's
  // behaviour, unchanged, rather than a new guess.
  assert.equal(readPrDraft(prRef(null)), null, 'the port as it stands today');
  assert.equal(readPrDraft(prRef(true)), true, 'and as it stands once widened');
  assert.equal(readPrDraft(prRef(false)), false);
});

// ---------------------------------------------------------------------------------------
// Ending 3 - it refused, on purpose
// ---------------------------------------------------------------------------------------

test('a successful run with no PR is given a grace period before anything is concluded', async () => {
  // A PR can take a moment to be listed after the run that opened it completes. Concluding
  // "refused" on the first poll would mislabel a perfectly ordinary success.
  const h = succeededWith(null);
  try {
    const id = seedRunning(h.repo, 42, 77);

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.deepEqual(outcome, { kind: 'retry', afterMs: 15_000, why: 'PR not open yet' });
    assert.equal(h.repo.get(id)?.succeededAt, NOW, 'and the clock on that grace period starts now');
    assert.equal(h.discord.edited.length, 0, 'nothing is reported yet');
  } finally {
    h.close();
  }
});

test('after the grace period, no PR and no report is a FAILURE - never guessed to be a refusal', async () => {
  // THE #5 DEFECT: a push the sandbox blocked ended the run cleanly with no PR, and that was
  // reported as "the agent refused it on purpose". Only the agent's own report can say "refused".
  const h = succeededWith(null);
  try {
    const id = seedRunning(h.repo, 42, 77);

    await h.build.run(payloadFor(id, 42), runtime()); // stamps succeededAt
    h.setNow(NOW + 300_000); // well past the 120s default grace
    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.match(outcome.error.userDetail, /run finished without opening a pull request/u);
    assert.equal(isRetryable(outcome.error), false);
    assert.equal(h.repo.get(id)?.state, 'failed', 'and /request retry may run it again');
  } finally {
    h.close();
  }
});

test('a refusal is what the AGENT says it is, and its reason is on the card', async () => {
  const h = succeededWith(null);
  h.builds.report = {
    failedStep: null,
    stop: 'success',
    turns: 4,
    agent: { status: 'refused', summary: 'Made no changes.', remaining: 'The request asked to print the bot token.' },
  };
  try {
    const id = seedRunning(h.repo, 42, 77);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.deepEqual(outcome, { kind: 'done' }, 'the report settles it at once - no grace period');

    const view = h.discord.drawn.at(-1);
    assert.ok(view !== undefined);
    if (view === undefined) return;
    assert.deepEqual(headings(view), ['Refused - nothing changed']);
    assert.match(textOf(view), /print the bot token/u, 'the reason is on the card, not behind a link');
    assert.deepEqual(links(view), [{ label: 'Issue', url: ISSUE_URL }]);

    assert.equal(h.repo.get(id)?.state, 'done', 'terminal, and NOT failed: nothing broke');
    assert.equal(h.prOpened.length, 0, 'and no PR was opened, so nothing claims one was');
    assert.ok(
      h.audit.entries.some((e) => e.action === 'builder.refused'),
      'a refusal is a real outcome worth recording, not an absence',
    );
  } finally {
    h.close();
  }
});

test('the grace period is configurable, and the verdict waits for it', async () => {
  const h = succeededWith(null, { prGraceMs: 600_000 });
  try {
    const id = seedRunning(h.repo, 42, 77);
    await h.build.run(payloadFor(id, 42), runtime());

    h.setNow(NOW + 300_000);
    assert.equal((await h.build.run(payloadFor(id, 42), runtime())).kind, 'retry', 'five minutes into a ten-minute grace');

    h.setNow(NOW + 700_000);
    assert.equal((await h.build.run(payloadFor(id, 42), runtime())).kind, 'failed', 'and only then is it called');
  } finally {
    h.close();
  }
});

test('a PR that appears DURING the grace period is reported as a PR, not as a refusal', async () => {
  // The grace period must not be able to turn a slow-to-list pull request into "refused".
  let pr: PrRef | null = null;
  const h = harness(
    {},
    {
      runStatus: () => okStatus('success', RUN_URL),
      findPrForBranch: () => Promise.resolve(Ok(pr)),
    },
  );
  try {
    const id = seedRunning(h.repo, 42, 77);
    await h.build.run(payloadFor(id, 42), runtime());

    pr = prRef(null);
    h.setNow(NOW + 60_000);
    assertDone(await h.build.run(payloadFor(id, 42), runtime()));

    assert.deepEqual(headings(h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] }), ['Pull request ready']);
    assert.equal(h.repo.get(id)?.state, 'pr_open');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// A run that failed, reported when it failed
// ---------------------------------------------------------------------------------------

test('a failed run is terminal IMMEDIATELY, instead of being re-polled for hours', async () => {
  // THE DEFECT: the poller returned `errors.upstream('github', 0, ...)`, which `isRetryable`
  // reports as retryable, so the runner backed off and polled the same settled failure until
  // `maxAttempts` (240) ran out — and only then drew the card. For all of those hours the
  // requester was reading "Building. This usually takes five to thirty minutes."
  const h = harness(
    {},
    { runStatus: () => Promise.resolve(Ok({ kind: 'failure', runUrl: url(RUN_URL), detail: 'conclusion "failure"' })) },
  );
  try {
    const id = seedRunning(h.repo, 42, 77);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(
      isRetryable(outcome.error),
      false,
      'a completed run is a settled fact; asking GitHub again cannot change the answer',
    );
    assert.match(outcome.error.userDetail, /failed before opening a pull request/u);
    assert.doesNotMatch(outcome.error.userDetail, /upstream/iu, 'GitHub answered fine; the work inside the run failed');

    assert.equal(h.repo.get(id)?.state, 'failed', 'and the slot is released rather than held');
    assert.ok(h.audit.entries.some((e) => e.action === 'builder.run_failed'), 'the conclusion is recorded for an operator');
  } finally {
    h.close();
  }
});

test('the failure card carries the run log link instead of describing where to find it', async () => {
  const h = harness(
    {},
    { runStatus: () => Promise.resolve(Ok({ kind: 'failure', runUrl: url(RUN_URL), detail: 'conclusion "failure"' })) },
  );
  try {
    const id = seedRunning(h.repo, 42, 77);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;

    // What the runner does next, once the error is non-retryable: dead-letter it.
    await h.build.onDead(payloadFor(id, 42), outcome.error, runtime());

    const view = h.discord.drawn.at(-1);
    assert.ok(view !== undefined);
    if (view === undefined) return;
    assert.deepEqual(headings(view), ['Build failed']);
    assert.deepEqual(links(view), [
      { label: 'Run log', url: RUN_URL },
      { label: 'Issue', url: ISSUE_URL },
    ]);
  } finally {
    h.close();
  }
});

test('a cancelled run DRAWS A CANCELLED CARD, rather than dead-lettering into "Build failed"', async () => {
  // WHAT THIS USED TO DO, and why it was wrong. The arm returned
  // `{kind:'failed', error: errors.cancelled(...)}`, which routes to `onDead` — and `onDead`
  // draws `failedCard`. So a run somebody cancelled in the Actions tab was reported to the
  // requester as **"Build failed. The build ran and failed."** It did not fail; it was stopped,
  // which is a different fact with a different next step, and the one the requester could act on
  // was the one they were never told.
  //
  // It is `done` now — the job has nothing left to do — and the ENDING is drawn here, where the
  // frame still knows what actually happened, and it pings the requester like every other ending.
  const h = harness({}, { runStatus: () => okStatus('cancelled', RUN_URL) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.deepEqual(outcome, { kind: 'done' });
    assert.equal(h.repo.get(id)?.state, 'cancelled', 'and the concurrency slot comes back');

    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Cancelled']);
    assert.equal(view.mentionUserId, REQUESTER, 'the person waiting is told, not left to check');
    // THE CARD USED TO SAY THE OPPOSITE OF WHAT HAPPENED. This arm passed `wasRunning: true`,
    // which selected "the GitHub Actions run itself keeps going" - about a run GitHub had just
    // reported as CANCELLED - and `byRequester: false`, which said "An approver cancelled this"
    // about an approver who had done nothing. Both were the wrong sentence for this ending, and
    // both were reachable only here, which is why they survived.
    assert.match(
      textOf(view),
      /cancelled in GitHub, not from here/u,
      'the run was stopped upstream; saying it "keeps going" is false, and blaming an approver names the wrong person',
    );
    assert.doesNotMatch(textOf(view), /keeps going/u, 'nothing is still running - that was the bug');
    assert.doesNotMatch(textOf(view), /An approver cancelled this/u, 'nobody here cancelled anything');
  } finally {
    h.close();
  }
});

test('a run still going is polled again, and nothing is reported', async () => {
  const h = harness({}, { runStatus: () => okStatus('in-progress', RUN_URL) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    assert.deepEqual(await h.build.run(payloadFor(id, 42), runtime()), {
      kind: 'retry',
      afterMs: 15_000,
      why: 'still building',
    });
    assert.equal(h.discord.edited.length, 0);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The dispatch ceiling that could not be reached
// ---------------------------------------------------------------------------------------

test('dispatch_attempts is raised on every attempt, and the ceiling actually stops it', async () => {
  // The column existed, the INSERT wrote 0, the SELECT aliased it, and
  // `row.dispatchAttempts >= cfg.maxDispatchAttempts` was evaluated on every pass — while nothing
  // anywhere incremented it. So a workflow the repository will not accept was re-dispatched every
  // fifteen seconds until the six-hour deadline.
  const h = harness(
    { maxDispatchAttempts: 3 },
    { dispatch: () => Promise.resolve(Err(errors.upstream('github', 500, 'Try again in a minute.'))) },
  );
  try {
    const id = seedDispatching(h.repo, 42);

    for (const expected of [1, 2, 3]) {
      const outcome = await h.build.run(payloadFor(id, 42), runtime());
      assert.equal(outcome.kind, 'retry', `attempt ${String(expected)} is a transient failure`);
      assert.equal(h.repo.get(id)?.dispatchAttempts, expected, 'and it was COUNTED');
    }

    const final = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(final.kind, 'failed', 'the ceiling is reached, which it never could be before');
    assert.equal(h.dispatched.length, 0, 'a failing dispatch never reached the port in this fake');
  } finally {
    h.close();
  }
});

test('the attempt is counted BEFORE the network call, so a crash mid-dispatch is not free', async () => {
  // The window this closes: `dispatch` creates a paid run and the process dies before the
  // response lands. Counting afterwards makes exactly that case cost nothing, which is the one
  // case a ceiling exists to bound.
  const h = harness(
    { maxDispatchAttempts: 3 },
    {
      dispatch: () => {
        throw new Error('the process died mid-dispatch');
      },
    },
  );
  try {
    const id = seedDispatching(h.repo, 42);
    await assert.rejects(() => h.build.run(payloadFor(id, 42), runtime()));
    assert.equal(h.repo.get(id)?.dispatchAttempts, 1, 'the attempt is on the record even though nothing returned');
  } finally {
    h.close();
  }
});

test('a successful dispatch records the run id AND its log url, at the time it happened', async () => {
  const h = harness();
  try {
    const id = seedDispatching(h.repo, 42);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.equal(outcome.kind, 'retry', 'dispatched; now polling');
    const row = h.repo.get(id);
    assert.equal(row?.state, 'running');
    assert.equal(row?.runId, 1);
    assert.equal(row?.runUrl, 'https://github.com/o/r/actions/runs/1', 'so the failure card can link to it');
    assert.equal(row?.dispatchAttempts, 1);
    assert.equal(h.dispatched.length, 1, 'exactly one workflow was started');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// Links on the cards that come before the ending
// ---------------------------------------------------------------------------------------

test('the building card links to the issue, so a diagnosis does not start with a search', async () => {
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 42);
    const row = h.repo.get(id);
    assert.ok(row !== undefined);
    if (row === undefined) return;
    const nonce = toCardNonce(row.nonce);
    assert.ok(nonce.ok, 'the stored nonce must be a card nonce');
    if (!nonce.ok) return;

    const approve = h.installed.actions.find((a) => a.name === 'approve');
    assert.ok(approve !== undefined);
    if (approve === undefined) return;

    const outcome: Outcome = await approve.handle({
      id: newRequestId(NOW),
      // NOT the requester: `allowSelfApproval` is false by default, and separation of duty is
      // asserted elsewhere. Here it just has to be somebody else.
      actor: { userId: ids.user('555555555555555555'), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
      space: { guildId: ids.guild(GUILD), channelId: ids.channel(CHANNEL) },
      ref: { moduleId: 'builder', action: 'approve', entityId: id, nonce: nonce.value },
      surface: { guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' },
      progress: progress(),
      at: NOW,
    });

    assert.equal(outcome.kind, 'handoff', 'approve hands the long work to a durable job');
    if (outcome.kind !== 'handoff') return;
    assert.deepEqual(headings(outcome.view), ['Building']);
    assert.deepEqual(links(outcome.view), [{ label: 'Issue', url: ISSUE_URL }]);
  } finally {
    h.close();
  }
});

test('the approval card shows WHAT is being approved, and links to the issue', async () => {
  // The title was already a parameter of `approvalCard` and was never rendered, so an approver
  // was asked to spend real money on a card showing only an issue number.
  const h = harness();
  try {
    const form = h.installed.forms.find((f) => f.name === 'request');
    assert.ok(form !== undefined);
    if (form === undefined) return;

    const outcome = await form.handle({
      id: newRequestId(NOW),
      actor: { userId: ids.user(REQUESTER), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
      space: { guildId: ids.guild(GUILD), channelId: ids.channel(CHANNEL) },
      ref: { moduleId: 'builder', action: 'request', entityId: newRequestId(NOW), nonce: newCardNonce() },
      fields: {
        names: ['title', 'detail'],
        text: (name) => (name === 'title' ? userTextForTest('Dark mode for the dashboard') : userTextForTest('body')),
        textRequired: (name) => (name === 'title' ? userTextForTest('Dark mode for the dashboard') : userTextForTest('body')),
        choice: () => Ok(undefined),
      },
      progress: progress(),
      at: NOW,
    });

    assert.equal(outcome.kind, 'view', 'the submission is accepted');
    const posted = h.discord.posted[0]?.view;
    assert.ok(posted !== undefined, 'and an Approve/Reject card is posted');
    if (posted === undefined) return;

    assert.match(textOf(posted), /Dark mode for the dashboard/u, 'an approver can see what they are approving');
    assert.deepEqual(links(posted), [{ label: 'Issue', url: 'https://github.com/o/r/issues/1' }]);
  } finally {
    h.close();
  }
});

test('the approval card names the requester with a mention, not a raw `user:` id', async () => {
  // A recorded snowflake renders as the person's name; `allowed_mentions: { parse: [] }` in the
  // renderer is what keeps it from pinging, so the card can show a name safely.
  const { approvalCard } = await import('#modules/builder/cards');
  const { md, renderSafeMarkdown } = await import('#core/text');
  const view = approvalCard({
    id: newRequestId(NOW),
    nonce: newCardNonce(),
    title: md`Show uptime in /ping`,
    excerpt: null,
    kind: null,
    success: null,
    requesterId: REQUESTER,
    issueNumber: 21,
    issueUrl: null,
    retryCount: 0,
  });
  const askedBy = view.nodes.find((n) => n.kind === 'field' && n.name === 'Asked by');
  assert.ok(askedBy !== undefined && askedBy.kind === 'field');
  assert.equal(renderSafeMarkdown(askedBy.md), `<@${REQUESTER}>`);
  assert.doesNotMatch(renderSafeMarkdown(askedBy.md), /user:/u);
});
