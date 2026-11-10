/**
 * THE CHECK-THEN-ACT RACE ON THE PER-GUILD CONCURRENCY CAP.
 *
 * `docs/KNOWN-ISSUES.md` carried this as the only remaining "Open - high" for several rounds:
 *
 *   > `src/modules/builder/module.ts` - the hook reads `countActive(guildId)`, then does async
 *   > work (issue creation) before `insertDraft` commits a row in a state `countActive` counts.
 *   > Several `/request` submissions arriving together all pass the check before any of them is
 *   > visible. **Impact:** a burst bypasses `maxConcurrentPerGuild`.
 *
 * WHY IT SURVIVED SO LONG, and it is worth writing down because the code LOOKED atomic: the
 * count and the insert were a few synchronous lines apart, with nothing awaited between them. The
 * gap was not in that stretch at all. `insertDraft` wrote `state = 'draft'`, and `activeCounts`
 * counted `awaiting_approval | dispatching | running` - so the row became countable only at
 * `recordIssue`, AFTER an issue creation and a message post. Every submission that arrived during
 * those two round trips read a count that could not see the ones already in flight.
 *
 * `/request retry` re-entered the same active set through a second door with the same shape, and
 * `/request cancel` - which the previous round added - made an over-subscribed guild RECOVERABLE
 * without making it impossible. The fix is neither of those: the count and the write are now one
 * statement, so the loser of a burst changes zero rows and is refused.
 *
 * THESE TESTS DRIVE THE REAL MODAL-SUBMIT HANDLER, CONCURRENTLY. That is the only way to state
 * the claim: a unit test of `claimSlot` proves the statement is atomic, and proves nothing about
 * whether the handler uses it. Two overlapping `handle()` calls are what the burst actually is.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Err } from '#core/result';
import { errors, userMessage } from '#core/errors';
import type { Outcome } from '#core/module';
import { newApprovalId, newRequestId } from '#core/ids';
import { DRAFT_STALE_MS, concurrencyError, slotsUsed } from '#modules/builder/module';
import { readFileSync, readdirSync } from 'node:fs';
import type { DbPort, SqlQuery } from '#core/ports/db';
import { openSqlite } from '#adapters/sqlite/db';
import { buildRepo, type NewBuildRow } from '#modules/builder/rows';

/** Where the builder's own migrations live, for the bare-database test at the end. */
const BUILDER_MIGRATIONS = 'src/modules/builder/migrations';
import {
  GUILD,
  NOW,
  REQUESTER,
  SEED_SLOTS,
  harness,
  requestForm,
  runtime,
  seedAwaiting,
  seedDraft,
  seedRunning,
  submission,
  type Harness,
} from '#modules/builder/harness.test';

/** A second and third funded requester, so a burst is a burst rather than one person typing. */
const SECOND = '777777777777777777';
const THIRD = '888888888888888888';
const FOURTH = '666666666666666666';
const FIFTH = '444444444444444444';

/** Bring-your-own-credentials, satisfied for everybody in the burst. */
function fundEveryone(h: Harness): void {
  for (const who of [REQUESTER, SECOND, THIRD, FOURTH, FIFTH]) {
    h.builds.environments.set(`user-${who}`, ['ANTHROPIC_API_KEY']);
  }
}

/** How many rows this guild is actually holding, by the module's own arithmetic. */
function held(h: Harness): number {
  return slotsUsed(h.repo.activeCounts(GUILD));
}

function refusals(outcomes: readonly Outcome[]): readonly string[] {
  return outcomes.filter((o) => o.kind === 'fail').map((o) => (o.kind === 'fail' ? userMessage(o.error) : ''));
}

// ---------------------------------------------------------------------------------------
// The race itself
// ---------------------------------------------------------------------------------------

test('TWO SUBMISSIONS AT ONCE CANNOT BOTH TAKE THE LAST SLOT', async () => {
  // THE MINIMAL REPRODUCTION. Both handlers start before either finishes: A claims, then awaits
  // GitHub; B runs its claim while A is suspended. Before the fix both passed, because A's row
  // was in a state the count ignored, and a guild capped at 1 ended up holding 2.
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    fundEveryone(h);
    const form = requestForm(h);

    const both = await Promise.all([
      form.handle(submission({ title: 'First idea', detail: 'Do the first thing.' }, REQUESTER)),
      form.handle(submission({ title: 'Second idea', detail: 'Do the second thing.' }, SECOND)),
    ]);

    assert.equal(both.filter((o) => o.kind === 'view').length, 1, 'exactly one submission may be admitted');
    assert.equal(both.filter((o) => o.kind === 'fail').length, 1, 'and the other must be REFUSED, not admitted');
    assert.equal(held(h), 1, 'THE CAP: one slot, one request. This is the number that used to be 2');
    assert.equal(h.issues.created.length, 1, 'and only one GitHub issue was filed, because only one was allowed');
  } finally {
    h.close();
  }
});

test('A BURST OF FIVE AGAINST A CAP OF TWO ADMITS EXACTLY TWO', async () => {
  // The shape the audit described: "a guild capped at 2 can run 5". Five overlapping handlers,
  // none of which can see the others' rows until the claim makes them visible.
  const h = harness({ maxConcurrentPerGuild: 2 });
  try {
    fundEveryone(h);
    const form = requestForm(h);

    const all = await Promise.all(
      [REQUESTER, SECOND, THIRD, FOURTH, FIFTH].map((who, i) =>
        form.handle(submission({ title: `Idea ${String(i)}`, detail: 'Something worth building.' }, who)),
      ),
    );

    assert.equal(all.filter((o) => o.kind === 'view').length, 2, 'the cap, exactly');
    assert.equal(all.filter((o) => o.kind === 'fail').length, 3);
    assert.equal(held(h), 2, 'and the ledger agrees with the cap rather than with the burst');
    assert.equal(h.issues.created.length, 2, 'three issues that would have been filed are not');

    // AND THE LOSERS ARE TOLD SOMETHING TRUE. A refusal that says "wait for a build to finish"
    // about a slot held by a request nobody has approved is the dead end this codebase already
    // rewrote once; the same rule applies to a slot held by a submission still being filed.
    for (const said of refusals(all)) {
      assert.match(said, /server|slot/u, `a refusal must explain the slot, not merely deny: ${said}`);
    }
  } finally {
    h.close();
  }
});

test('a submission still being FILED holds the slot, which is the whole mechanism', () => {
  // The claim is not "the insert is fast enough". It is that the row occupies a slot from the
  // moment it exists - including in `draft`, before there is an issue or a card - because a slot
  // that only becomes real two network calls later is a slot two other submissions can take.
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    const id = seedDraft(h.repo);
    assert.notEqual(id, null, 'the first claim succeeds');

    assert.deepEqual(h.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 1 });
    assert.equal(held(h), 1, 'a draft occupies a slot');
    assert.equal(seedDraft(h.repo, NOW, GUILD, 1), null, 'so the next claim against a cap of 1 is refused');
  } finally {
    h.close();
  }
});

test('the refusal for a slot held mid-submission says "try again in a moment", not "find an approver"', () => {
  // Each arm of this message has to be actionable, and the actions are opposite. "Ask an
  // approver" is useless advice about a row that has no approver and clears itself in a second.
  const said = userMessage(concurrencyError({ waiting: 0, running: 0, filing: 1 }, 48 * 3_600_000));
  assert.match(said, /being filed right now/u);
  assert.match(said, /Try again in a moment/u);
  assert.doesNotMatch(said, /waiting for an approver/u, 'there is nobody to find');

  // ...and when something REAL also holds a slot, that is the reader's actual problem.
  const mixed = userMessage(concurrencyError({ waiting: 1, running: 0, filing: 1 }, 48 * 3_600_000));
  assert.match(mixed, /waiting for an approver/u);
  assert.doesNotMatch(mixed, /being filed right now/u, 'naming a transient row alongside a real one is noise');

  // AND THE RACE'S OWN AFTERMATH. The counts are read after the claim was refused, so the row
  // that beat you may already have cleared - "0 requests are still waiting for an approver here"
  // is the arithmetically correct sentence and a nonsense one.
  const cleared = userMessage(concurrencyError({ waiting: 0, running: 0, filing: 0 }, 48 * 3_600_000));
  assert.match(cleared, /at its build limit a moment ago/u);
  assert.match(cleared, /Try again in a moment/u);
  assert.doesNotMatch(cleared, /0 requests/u, 'a count of zero must never be read back to somebody as an explanation');
});

// ---------------------------------------------------------------------------------------
// The slot has to come BACK, or the fix is a slower version of the bug
// ---------------------------------------------------------------------------------------

test('a submission whose ISSUE CANNOT BE FILED gives the slot straight back', async () => {
  // THE HAZARD THE FIX INTRODUCES. Claiming before the network call is what makes the cap real;
  // it also means every failure after the claim must release it, or a GitHub outage permanently
  // consumes a guild's slots one refused submission at a time.
  const h = harness({ maxConcurrentPerGuild: 1 }, {}, {
    create: async () => Err(errors.upstream('github', 500, 'Try again shortly.')),
  });
  try {
    fundEveryone(h);
    const failed = await requestForm(h).handle(submission({ title: 'Doomed', detail: 'GitHub is down.' }, REQUESTER));
    assert.equal(failed.kind, 'fail');

    assert.equal(held(h), 0, 'the claim was handed back');
    assert.equal(h.repo.recentForRequester(GUILD, REQUESTER, 5).length, 0, 'and no row of nothing was left behind');
  } finally {
    h.close();
  }
});

test('a submission whose CARD cannot be posted releases the slot AND closes the issue it filed', async () => {
  // Without a card there is no approver, no outcome and now no row - so an issue left open here
  // is a request that exists only on GitHub and can never be acted on from the product.
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    fundEveryone(h);
    h.failPosts(errors.unavailable('discord', 'Check the bot can post here.'));

    const failed = await requestForm(h).handle(submission({ title: 'No card', detail: 'The channel is gone.' }, REQUESTER));
    assert.equal(failed.kind, 'fail');

    assert.equal(held(h), 0, 'the slot comes back');
    assert.deepEqual(h.issues.closed, [1], 'and the orphaned issue is closed rather than left as litter');
  } finally {
    h.close();
  }
});

test('A CRASH MID-SUBMISSION does not cost a guild a slot forever', async () => {
  // `claimSlot` commits and the handler then awaits GitHub. A process that dies in that window
  // leaves a `draft` row nothing will ever release - the same crash window `reconcile()` already
  // exists for, one state earlier. Both sweeps reclaim it.
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    assert.notEqual(seedDraft(h.repo, NOW), null);
    assert.equal(held(h), 1);

    // Not yet: a submission that is merely slow must keep its slot, or releasing it early would
    // be a different way past the cap.
    h.setNow(NOW + DRAFT_STALE_MS - 1);
    await h.expire.run({}, runtime());
    assert.equal(held(h), 1, 'a live submission keeps its claim');

    h.setNow(NOW + DRAFT_STALE_MS + 1);
    await h.expire.run({}, runtime());
    assert.equal(held(h), 0, 'and an abandoned one gives it back');
  } finally {
    h.close();
  }
});

test('the BOOT reconciler reclaims abandoned claims too, because a crashed bot restarts', async () => {
  const h = harness();
  try {
    assert.notEqual(seedDraft(h.repo, NOW), null);
    h.setNow(NOW + DRAFT_STALE_MS + 1);

    const reconcile = h.installed.reconcile;
    assert.ok(reconcile !== null, 'the builder must reconcile at boot');
    await reconcile?.();

    assert.equal(held(h), 0, 'waiting an hour for the sweep after a restart is an hour of a missing slot');
  } finally {
    h.close();
  }
});

test('releasing a claim can never delete a REAL request', () => {
  // The guard is `state = 'draft'`. Without it, `releaseDraft` is a deletion primitive pointed at
  // a table whose rows are the only record that a build was ever asked for.
  const h = harness();
  try {
    const live = seedAwaiting(h.repo, 42);
    assert.equal(h.repo.releaseDraft(live), false);
    assert.equal(h.repo.get(live)?.state, 'awaiting_approval', 'still there');

    const running = seedRunning(h.repo, 43, 77);
    assert.equal(h.repo.releaseDraft(running), false);
    assert.notEqual(h.repo.get(running), undefined);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The third entrance: /request retry
// ---------------------------------------------------------------------------------------

test('RE-ARMING A REQUEST CLAIMS ITS SLOT IN THE SAME STATEMENT, and says which refusal it is', () => {
  // A retry moves a terminal row back into the active set, so it faces the cap - and it used to
  // face it as a separate read several awaits before the write. The two refusals are also kept
  // apart: "the guild is full" and "somebody else re-armed this first" send a reader off to do
  // completely different things, and a boolean could only ever say one of them.
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    const failed = seedRunning(h.repo, 42, 77);
    h.repo.finish(failed, 'failed', NOW);
    const row = h.repo.get(failed);
    assert.ok(row !== undefined);
    if (row === undefined) throw new Error('unreachable');

    // The guild's single slot, held by something else.
    seedAwaiting(h.repo, 43);
    assert.equal(
      h.repo.reopenForDispatch({ id: row.id, expectVersion: row.version, guildId: GUILD, at: NOW, maxConcurrent: 1, approvalId: newApprovalId() }),
      'full',
      'the cap is enforced by the statement that re-arms the row, not by a read before it',
    );
    assert.equal(h.repo.get(failed)?.state, 'failed', 'and nothing moved');

    // With room, a STALE version is a different answer entirely.
    assert.equal(
      h.repo.reopenForDispatch({ id: row.id, expectVersion: row.version + 99, guildId: GUILD, at: NOW, maxConcurrent: 9, approvalId: newApprovalId() }),
      'lost',
    );
    assert.equal(
      h.repo.reopenForDispatch({ id: row.id, expectVersion: row.version, guildId: GUILD, at: NOW, maxConcurrent: 9, approvalId: newApprovalId() }),
      'claimed',
    );
    assert.equal(h.repo.get(failed)?.state, 'dispatching');
  } finally {
    h.close();
  }
});

test('an EXPIRED request being put back in front of an approver faces the cap the same way', () => {
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    const expired = seedAwaiting(h.repo, 42);
    h.repo.finish(expired, 'expired', NOW);
    const row = h.repo.get(expired);
    assert.ok(row !== undefined);
    if (row === undefined) throw new Error('unreachable');

    seedAwaiting(h.repo, 43);
    assert.equal(
      h.repo.reopenForApproval({
        id: row.id,
        expectVersion: row.version,
        guildId: GUILD,
        at: NOW,
        maxConcurrent: 1,
        nonce: 'x'.repeat(8),
      }),
      'full',
      'waiting two days and retrying must not be a way past the cap either',
    );
    assert.equal(h.repo.get(expired)?.state, 'expired');
  } finally {
    h.close();
  }
});

test('a claim is scoped to ONE GUILD, or one busy server would refuse every other one', () => {
  const h = harness({ maxConcurrentPerGuild: 1 });
  try {
    assert.notEqual(seedDraft(h.repo, NOW, GUILD, 1), null);
    assert.equal(seedDraft(h.repo, NOW, GUILD, 1), null, 'this guild is full');
    assert.notEqual(seedDraft(h.repo, NOW, '999999999999999999', 1), null, 'and that one is not');

    assert.deepEqual(h.repo.activeCounts('999999999999999999'), { waiting: 0, running: 0, filing: 1 });
  } finally {
    h.close();
  }
});

test('a TERMINAL row never occupies a slot, whatever ended it', () => {
  // The counting predicate and `TERMINAL_STATES` have to agree; if a finished build kept its
  // slot, the cap would tighten by one per completed build until a guild could do nothing.
  const h = harness();
  try {
    for (const [issue, end] of [[42, 'pr_open'], [43, 'done'], [44, 'failed'], [45, 'cancelled']] as const) {
      const id = seedRunning(h.repo, issue, issue);
      h.repo.finish(id, end, NOW);
    }
    assert.deepEqual(h.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 });
  } finally {
    h.close();
  }
});

test('claimSlot is the ONLY door into the table, so no caller can skip the cap', () => {
  // A repo that still exposed an unguarded insert would be a repo somebody inserts through. The
  // assertion is structural rather than behavioural on purpose: it is about what can be written
  // next, not about what is written today.
  const h = harness();
  try {
    const doors = Object.keys(h.repo).filter((k) => /insert|add|create/iu.test(k));
    assert.deepEqual(doors, [], `an unguarded insert reappeared: ${doors.join(', ')}`);

    // And the guarded one really does refuse rather than throwing or silently succeeding.
    const id = newRequestId(NOW);
    assert.equal(
      h.repo.claimSlot(
        {
          id,
          state: 'draft',
          version: 1,
          guildId: GUILD,
          requesterId: REQUESTER,
          nonce: 'n'.repeat(8),
          fenceNonce: 'f'.repeat(8),
          title: null,
          issueNumber: null,
          issueUrl: null,
          runId: null,
          runUrl: null,
          dispatchAttempts: 0,
          succeededAt: null,
          surfaceJson: null,
        },
        NOW,
        0,
      ),
      false,
      'a cap of zero admits nothing',
    );
    assert.equal(h.repo.get(id), undefined, 'and writes nothing');
  } finally {
    h.close();
  }
});

test('SEED_SLOTS exists so a fixture never accidentally tests the cap it is not about', () => {
  assert.ok(SEED_SLOTS > 100, 'seeding must not be refused by the very cap other tests set deliberately');
});

// ---------------------------------------------------------------------------------------
// IS THE CLAIM REALLY ATOMIC, or merely fast?
//
// EVERY TEST ABOVE PASSES ON A NON-ATOMIC IMPLEMENTATION, and that is not a slur on them - it
// is a property of the runtime. `ctx.ports.db` is synchronous `node:sqlite`, and the bot is one
// process, so "count and write in one statement" and "count and write in two statements with
// nothing awaited between them" are INDISTINGUISHABLE from inside an async test: no other
// JavaScript can run between two synchronous calls. Reverting `claimSlot` to a synchronous
// check-then-insert leaves all of them green.
//
// So they pin the half that was historically broken - that a `draft` row is visible to the next
// reader's count at all - and they cannot pin the other half. This section pins the other half.
//
// HOW, WITHOUT A SECOND PROCESS: the claim is that there is NO OBSERVABLE MOMENT between
// counting and writing at which another writer could act. A moment like that, if it exists, is
// a separate read - so wrap the database and have every read fire a hook that lets a competitor
// in. If the implementation reads separately, the hook finds its moment and the cap is breached.
// If the count lives inside the writing statement, there is no read to hook and the competitor
// never gets a turn.
//
// THE CONTROL BELOW IS NOT OPTIONAL. A hook that silently never fires would make this pass
// vacuously, which is the exact failure mode this whole section exists to catch - so the first
// assertion proves the injector works before the second concludes anything from its silence.
// ---------------------------------------------------------------------------------------

/**
 * A `DbPort` that lets a competing writer in immediately AFTER every read returns.
 *
 * AFTER, NOT BEFORE, and the order is the whole point. Firing before the read would let the
 * reader see the competitor and refuse correctly - which detects a separate read, but only
 * structurally. Firing after means the value the reader just received is STALE by the time it
 * acts on it, which is exactly what a real second writer does in the gap. An implementation
 * with a gap then oversubscribes the guild for real, and the test fails with the number the
 * product would have got wrong rather than with a fact about statement counts.
 */
function interleavingDb(base: DbPort, afterRead: () => void): DbPort {
  return {
    // Spread first so any member this wrapper does not care about (`tablePrefix`, `docs`) is
    // carried through unchanged, and adding one to `DbPort` does not silently drop it here.
    ...base,
    table: (name) => base.table(name),
    column: (name) => base.column(name),
    query: <T,>(q: SqlQuery): readonly T[] => {
      const rows = base.query<T>(q);
      afterRead();
      return rows;
    },
    queryOne: <T,>(q: SqlQuery): T | undefined => {
      const row = base.queryOne<T>(q);
      afterRead();
      return row;
    },
    execute: (q) => base.execute(q),
    transaction: <T,>(fn: () => T): T => base.transaction(fn),
  };
}

/** The columns `claimSlot` needs, with only the guild varying. */
function claimant(guildId: string): NewBuildRow {
  return {
    id: newRequestId(NOW),
    state: 'draft',
    version: 1,
    guildId,
    requesterId: REQUESTER,
    nonce: 'n'.repeat(8),
    fenceNonce: 'f'.repeat(8),
    title: null,
    issueNumber: null,
    issueUrl: null,
    runId: null,
    runUrl: null,
    dispatchAttempts: 0,
    succeededAt: null,
    surfaceJson: null,
  };
}

test('THE CLAIM HAS NO OBSERVABLE MOMENT BETWEEN COUNTING AND WRITING for a competitor to use', () => {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok);
  if (!opened.ok) throw new Error('unreachable');
  const handle = opened.value;
  try {
    for (const file of readdirSync(BUILDER_MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b))) {
      handle.connection.exec(readFileSync(`${BUILDER_MIGRATIONS}/${file}`, 'utf8'));
    }
    const plain = handle.moduleDb('builder');

    // The competitor writes through an UNWRAPPED repo, so it cannot re-enter the hook.
    const competitor = buildRepo(plain);
    let turns = 0;
    const letAnotherWriterIn = (): void => {
      // Once only: this stands in for one other submission arriving, not an infinite supply.
      if (turns > 0) return;
      turns += 1;
      competitor.claimSlot(claimant(GUILD), NOW, 1);
    };

    const raced = buildRepo(interleavingDb(plain, letAnotherWriterIn));

    // THE CONTROL. A read the implementation really does perform must fire the hook — otherwise
    // the silence during `claimSlot` proves nothing at all.
    raced.activeCounts(GUILD);
    assert.equal(turns, 1, 'the injector must actually work, or this whole test is vacuous');
    assert.equal(slotsUsed(competitor.activeCounts(GUILD)), 1, 'and the competitor really took the slot');

    // Reset to an empty guild and let the hook fire again.
    assert.equal(competitor.releaseStaleDrafts(NOW + 1, 10), 1);
    turns = 0;
    assert.equal(slotsUsed(competitor.activeCounts(GUILD)), 0);

    // THE CLAIM ITSELF, against a cap of one. If it counts in a statement of its own, the hook
    // fires there, the competitor takes the only slot, and the unguarded insert that follows
    // makes two. If the count is part of the write, there is no such statement to hook.
    const claimed = raced.claimSlot(claimant(GUILD), NOW, 1);

    assert.equal(
      slotsUsed(competitor.activeCounts(GUILD)),
      1,
      'THE CAP. One slot, one row - however the two writers were interleaved. Two here is the ' +
        'oversubscribed guild the whole fix exists to prevent, and it is what a check-then-act ' +
        'claim produces the moment anything at all can run between the check and the act',
    );
    assert.equal(turns, 0, 'and there was no separate read for a competitor to be let in at');
    assert.equal(claimed, true, 'with nobody actually competing, the claim still succeeds');
  } finally {
    handle.close();
  }
});
