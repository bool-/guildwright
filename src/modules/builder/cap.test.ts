/**
 * THE DAILY RUN CAP, WHICH THE BOT DID NOT KNOW ABOUT.
 *
 * `.github/workflows/agent-implement-request.yml` counts how many agent runs have started since
 * UTC midnight and exits 1 over `AGENT_DAILY_RUN_CAP` (default 4). It is the operator's real
 * spend backstop, and it is enforced in a STEP - which means the run has already been created and
 * has already started charging Actions minutes by the time it fires.
 *
 * The bot knew none of that. So the fifth approved build of the day was dispatched exactly like
 * the first, consumed a run, failed at that step, and arrived in Discord as:
 *
 *     Build failed
 *     The build ran and failed. Open the run log linked on this card to see what broke.
 *
 * The requester had done nothing wrong. Nothing was broken. The true answer was "wait a few
 * hours", and no part of the product said so - the only way to find out was to open the run log
 * and read `::error::daily agent run cap reached`.
 *
 * These tests pin the three outcomes and the deliberate non-outcome (an unreadable count must not
 * stop every build in the product, because the workflow is still the authority).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Err, Ok } from '#core/result';
import { errors, isRetryable, userMessage } from '#core/errors';
import {
  AGENT_DAILY_RUN_CAP,
  WORKFLOW_DEFAULT_DAILY_RUN_CAP,
  compareDailyRunCap,
  msUntilUtcDayEnd,
  startOfUtcDay,
} from '#modules/builder/module';
import type { BuildsOverrides, Harness } from '#modules/builder/harness.test';
import {
  HOUR,
  NOW,
  harness,
  headings,
  lastEdit,
  payloadFor,
  runtime,
  seedDispatching,
  textOf,
} from '#modules/builder/harness.test';

const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------
// The calendar, which has to be the workflow's calendar
// ---------------------------------------------------------------------------------------

test('the window is UTC midnight, which is the boundary the workflow counts from', () => {
  // The workflow uses `date -u -d 'today 00:00'`. The epoch is itself a UTC midnight, so flooring
  // to whole days IS that boundary - and no `Date` is involved, which matters because a module
  // may not read the ambient clock at all (`conventions.test.ts` bans `new Date()` outright).
  assert.equal(startOfUtcDay(0), 0);
  assert.equal(startOfUtcDay(DAY - 1), 0);
  assert.equal(startOfUtcDay(DAY), DAY);
  assert.equal(startOfUtcDay(DAY + 1), DAY);

  assert.equal(msUntilUtcDayEnd(0), DAY, 'at midnight, a whole day of runs is available');
  assert.equal(msUntilUtcDayEnd(DAY - 1), 1);
  // Waiting `msUntilUtcDayEnd` from now lands exactly on the next window, which is what makes
  // the `retry` afterMs correct rather than approximately correct.
  assert.equal(NOW + msUntilUtcDayEnd(NOW), startOfUtcDay(NOW) + DAY);
  assert.equal(startOfUtcDay(NOW + msUntilUtcDayEnd(NOW)), startOfUtcDay(NOW) + DAY, 'a new day, so a fresh quota');
});

// ---------------------------------------------------------------------------------------
// Under cap: nothing changes
// ---------------------------------------------------------------------------------------

test('under the cap, the build dispatches exactly as it always did', async () => {
  const h = harness({ dailyRunCap: 4 });
  try {
    h.builds.runsToday = 3;
    const id = seedDispatching(h.repo, 42);

    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.deepEqual(outcome, { kind: 'retry', afterMs: 15_000, why: 'dispatched; polling' });
    assert.equal(h.dispatched.length, 1, 'the fourth run of the day is still allowed');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// At cap, with time to wait
// ---------------------------------------------------------------------------------------

test('AT THE CAP, nothing is dispatched, the card says why, and the build is queued for the reset', async () => {
  const h = harness({ dailyRunCap: 4, buildDeadlineMs: 6 * HOUR });
  try {
    h.builds.runsToday = 4;
    const id = seedDispatching(h.repo, 42);

    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.deepEqual(outcome, {
      kind: 'retry',
      afterMs: msUntilUtcDayEnd(NOW),
      why: 'the daily agent run cap is full; waiting for the UTC reset',
    });
    assert.equal(h.dispatched.length, 0, 'THE POINT: no paid run was burned to discover the cap');
    assert.equal(
      h.repo.get(id)?.dispatchAttempts,
      0,
      'and being over cap does not eat a dispatch attempt — that ceiling is for GitHub refusing us',
    );
    assert.equal(h.repo.get(id)?.state, 'dispatching', 'the request is still alive, just waiting');

    const card = lastEdit(h);
    assert.deepEqual(headings(card), ['Queued - the daily build cap is full']);
    const said = textOf(card);
    assert.match(said, /4 of 4/u, 'the numbers, so the reader can see it is a quota and not a fault');
    assert.match(said, /no Actions minutes and no Anthropic tokens were used/u);
    assert.match(said, /You do not need to do anything/u, 'the honest instruction, which used to be absent');
    assert.match(said, /\/request cancel/u, 'and the one thing they might want to do instead');

    // `retry` does not consume an attempt, so waiting out a cap is free.
    assert.notEqual(outcome.kind, 'failed');
  } finally {
    h.close();
  }
});

test('the cap is recorded in the audit, because "why did nothing happen for four hours" is asked later', async () => {
  const h = harness({ dailyRunCap: 1 });
  try {
    h.builds.runsToday = 9;
    const id = seedDispatching(h.repo, 42);
    await h.build.run(payloadFor(id, 42), runtime());

    const row = h.audit.entries.find((e) => e.action === 'builder.daily_cap');
    assert.ok(row !== undefined, 'the audit must carry the refusal');
    assert.deepEqual(row?.detail['used'], 9);
    assert.deepEqual(row?.detail['cap'], 1);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// At cap, with no time left
// ---------------------------------------------------------------------------------------

test('when the reset is beyond the job deadline it FAILS NOW, saying so, rather than timing out later', async () => {
  // A `retry` scheduled past the deadline is not a wait - the runner gives up at the deadline and
  // `onDead` draws "Build failed", which is the unexplained message this whole check exists to
  // abolish. Better to say it while the sentence can still name the number of hours.
  const h = harness({ dailyRunCap: 4 });
  try {
    h.builds.runsToday = 4;
    const id = seedDispatching(h.repo, 42);

    // A job that has to give up in a minute, while the cap resets hours from now.
    const outcome = await h.build.run(payloadFor(id, 42), runtime(1, NOW + 60_000));

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    const said = userMessage(outcome.error);
    assert.match(said, /4 agent runs per UTC day/u);
    assert.match(said, /no Actions minutes and no Anthropic tokens were spent/u);
    assert.match(said, /\/request retry after it resets/u, 'a next step, not a dead end');
    assert.match(said, /raise the daily build cap/u, 'and the lever an admin can actually pull');
    assert.doesNotMatch(said, /AGENT_DAILY_RUN_CAP/u, 'named in plain words, not as a variable');
    assert.equal(outcome.error.retryable, false, 'a full quota is a settled fact for today');

    assert.equal(h.dispatched.length, 0);
    assert.equal(h.repo.get(id)?.state, 'failed', 'and the concurrency slot is released');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The deliberate non-outcome
// ---------------------------------------------------------------------------------------

test('an UNREADABLE count degrades to dispatching, because the workflow is the real authority', async () => {
  // A token without `actions: read` cannot list runs. Failing closed here would mean one missing
  // OPTIONAL permission stops every build in the product - the same mistake `resolveBuildPayer`
  // already learned once, where a missing **Environments** permission broke builds for everyone
  // including people who never brought a credential.
  const h = harness(
    { dailyRunCap: 4 },
    { runsSince: async () => Err(errors.upstream('github', 403, 'Grant the token actions: read.')) },
  );
  try {
    const id = seedDispatching(h.repo, 42);
    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.deepEqual(outcome, { kind: 'retry', afterMs: 15_000, why: 'dispatched; polling' });
    assert.equal(h.dispatched.length, 1, 'the build still runs; the workflow will refuse it if it must');
  } finally {
    h.close();
  }
});

test('a RATE-LIMITED count honours the wait GitHub asked for, instead of hammering it', async () => {
  // The counterpart of the arm above: a 429 is not "I may never know", it is "ask again later",
  // and re-asking every fifteen seconds for hours is how the bot holds its own limit open.
  const h = harness(
    { dailyRunCap: 4 },
    { runsSince: async () => Err(errors.rateLimited('github', 900_000, 'It resumes on its own.')) },
  );
  try {
    const id = seedDispatching(h.repo, 42);
    assert.deepEqual(await h.build.run(payloadFor(id, 42), runtime()), {
      kind: 'retry',
      afterMs: 900_000,
      why: 'could not read the daily run count',
    });
    assert.equal(h.dispatched.length, 0, 'and it does not guess its way past the cap either');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The two halves of the cap have to agree
// ---------------------------------------------------------------------------------------

test('the count is scoped to the agent workflow, and asked for the same day the runner asks about', async () => {
  const asked: { file: string; since: number }[] = [];
  const h = harness(
    { dailyRunCap: 4, workflowFile: 'agent-implement-request.yml' },
    {
      runsSince: async (file, since) => {
        asked.push({ file, since });
        return Ok(0);
      },
    },
  );
  try {
    await h.build.run(payloadFor(seedDispatching(h.repo, 42), 42), runtime());
    assert.deepEqual(asked, [{ file: 'agent-implement-request.yml', since: startOfUtcDay(NOW) }]);
  } finally {
    h.close();
  }
});

test('/status reports the cap, because it is the third setting that silently decides whether a build starts', async () => {
  const h = harness({ dailyRunCap: 7 });
  try {
    const health = await h.installed.health();
    assert.equal(health.status, 'ok');
    assert.match(health.detail, /7 agent runs per UTC day/u);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// THE TWO CAPS, AND THE FACT THAT NOTHING USED TO RECONCILE THEM
// ---------------------------------------------------------------------------------------

/**
 * `docs/KNOWN-ISSUES.md`, "Open - low":
 *
 *   > The daily cap is now two numbers with nothing reconciling them.
 *   > `modules.builder.dailyRunCap` lives in the bot's config and `AGENT_DAILY_RUN_CAP` in a
 *   > GitHub repository variable; both default to 4 and nothing checks they agree. Setting the
 *   > bot's higher is the bad direction - the bot dispatches, the workflow refuses, and the
 *   > requester is back to the confusing failure this round set out to remove.
 *
 * BOTH NUMBERS STILL EXIST, and that is deliberate: the workflow's copy is the one that does not
 * trust the bot, and it is the only bound on a replayed approval. What was missing was anything
 * that NOTICED they had drifted - so an operator who raised one and forgot the other found out
 * when a requester's approved build dispatched, ran for ten seconds, and exited 1 at a cap step
 * whose log they usually cannot open.
 *
 * IT IS NEVER FATAL. The variable may legitimately be unset (the workflow default applies), and
 * the token may not be allowed to read it. Refusing to run over either would mean the bot is
 * stopped by an optional permission - the mistake `resolveBuildPayer` and `checkDailyCap` have
 * each already learned once.
 */

/**
 * A harness whose `AGENT_DAILY_RUN_CAP` repository variable already holds `raw`.
 *
 * WHY THE RAW STRING AND NOT A NUMBER: the port answers a three-arm `RepositoryVariable`, and
 * the arm that matters most - `not-a-number` - is only reachable by storing what an operator
 * actually typed. `fakeBuilds().variables` therefore holds the string GitHub would return, and
 * `toRepositoryVariable` (shared by the fake and the real adapter) does the reading, so these
 * tests exercise the same parse the production path does.
 *
 * `undefined` leaves the variable UNSET, which is the ordinary install and means the workflow's
 * own literal default applies.
 */
function capHarness(botCap: number, raw?: string, overrides: BuildsOverrides = {}): Harness {
  const h = harness({ dailyRunCap: botCap }, overrides);
  if (raw !== undefined) h.builds.variables.set(AGENT_DAILY_RUN_CAP, raw);
  return h;
}

test('the caps AGREEING is the quiet case: no warning, and /status says so', async () => {
  const h = capHarness(9, '9');
  try {
    await h.installed.reconcile?.();
    const health = await h.installed.health();
    assert.match(health.detail, /AGENT_DAILY_RUN_CAP agrees/u);
    assert.equal(health.status, 'ok');
    assert.deepEqual(
      h.audit.entries.filter((e) => e.action === 'builder.daily_cap_drift'),
      [],
      'nothing is wrong, so nothing is reported',
    );
  } finally {
    h.close();
  }
});

test('THE BAD DIRECTION - the bot allows more than the repository - is surfaced to the OPERATOR', async () => {
  // This is the drift that costs a requester a build. Past the repository's number the bot
  // dispatches happily and the workflow refuses, which arrives in Discord as the unexplained
  // "Build failed" the whole cap feature exists to abolish.
  const h = capHarness(10, '4');
  try {
    await h.installed.reconcile?.();

    const health = await h.installed.health();
    assert.match(health.detail, /WARNING/u);
    assert.match(health.detail, /this bot allows 10 but the workflow allows 4/u, 'both numbers, or it is not actionable');
    assert.match(health.detail, /Raise AGENT_DAILY_RUN_CAP or lower modules\.builder\.dailyRunCap/u, 'and the two levers');

    const drift = h.audit.entries.find((e) => e.action === 'builder.daily_cap_drift');
    assert.ok(drift !== undefined, 'audited, because /admin audit is where a failed build gets diagnosed');
    assert.equal(drift?.detail['bot'], 10);
    assert.equal(drift?.detail['repository'], 4);
  } finally {
    h.close();
  }
});

test('the HARMLESS direction is reported without crying wolf', async () => {
  // Bot lower than the repository cannot overspend - it only costs throughput. Reporting it as a
  // warning would train an operator to ignore the warning that matters.
  const h = capHarness(2, '8');
  try {
    await h.installed.reconcile?.();
    const health = await h.installed.health();
    assert.match(health.detail, /this bot allows 2 but the workflow allows 8/u);
    assert.match(health.detail, /only costs throughput/u);
    assert.doesNotMatch(health.detail, /WARNING/u);
    assert.deepEqual(h.audit.entries.filter((e) => e.action === 'builder.daily_cap_drift'), []);
  } finally {
    h.close();
  }
});

test('AN UNSET VARIABLE IS COMPARED AGAINST THE WORKFLOW DEFAULT, not treated as "no opinion"', async () => {
  // `vars.AGENT_DAILY_RUN_CAP || '4'`. An unset variable is not the absence of a cap; it IS a cap
  // of 4. Skipping the comparison here would miss the drift that is likeliest on a fresh install,
  // where nobody has ever set the variable and somebody has raised the bot's number in config.
  const h = capHarness(12);
  try {
    await h.installed.reconcile?.();
    const health = await h.installed.health();
    assert.match(health.detail, /WARNING/u);
    assert.match(health.detail, /this bot allows 12 but the workflow allows 4/u);
    assert.match(health.detail, /AGENT_DAILY_RUN_CAP is unset, so the workflow default applies/u);
  } finally {
    h.close();
  }
});

test('an unset variable that AGREES with the bot is not a problem at all', async () => {
  const h = capHarness(WORKFLOW_DEFAULT_DAILY_RUN_CAP);
  try {
    await h.installed.reconcile?.();
    assert.match((await h.installed.health()).detail, /unset and the workflow default agrees/u);
  } finally {
    h.close();
  }
});

test('a cap the bot CANNOT READ is reported as unknown, and stops nothing', async () => {
  // In practice: a token without `Variables: read`. The workflow enforces its own cap and is the
  // authority, so failing closed here would stop every build in the product over an optional
  // permission that nothing else needs.
  const h = capHarness(4, undefined, {
    repositoryVariable: async () => Err(errors.upstream('github', 403, 'Grant the token Variables: read.')),
  });
  try {
    await h.installed.reconcile?.();
    const health = await h.installed.health();
    assert.equal(health.status, 'ok', 'NOT fatal, and not even degraded');
    assert.match(health.detail, /could not be read/u);
    assert.match(health.detail, /upstream\.github\.403/u, 'naming the code, so an operator can act on it');
  } finally {
    h.close();
  }
});

test('A REPOSITORY CAP THE WORKFLOW CANNOT PARSE is the loudest arm, because every build dies', async () => {
  // THE ARM THE INTEGRATION ADDED, and it could not exist before it. This module first shipped a
  // bridge asking the port for `number | null`, which has no way to say "the operator typed
  // 4.0". The port that landed answers a three-arm union, and this is the third arm.
  //
  // It is not a disagreement about a number. `.github/workflows/agent-implement-request.yml`
  // guards with `case "$DAILY_CAP" in ''|*[!0-9]*) ... exit 1`, so this value means every build
  // dispatched from now on dies in its first seconds - and the reason lives only in an Actions
  // log the requester cannot open.
  const h = capHarness(4, '4.0');
  try {
    await h.installed.reconcile?.();
    const health = await h.installed.health();
    assert.match(health.detail, /WARNING/u);
    assert.match(health.detail, /not a whole number/u);
    assert.match(health.detail, /EVERY build will fail/u, 'the consequence, not just the fact');
    assert.match(health.detail, /Set AGENT_DAILY_RUN_CAP to a plain number/u, 'and the lever');

    const drift = h.audit.entries.find((e) => e.action === 'builder.daily_cap_drift');
    assert.ok(drift !== undefined, 'audited like the other bad arm, for the same diagnosis');
  } finally {
    h.close();
  }
});

test('every shape an operator can actually type in that box is judged as the workflow judges it', async () => {
  // The workflow rejects each of these outright, so reporting agreement about any of them would
  // be reporting agreement about a repository where nothing can build.
  for (const raw of [' 4 ', '4.0', '+4', '-1', 'four', '']) {
    const h = capHarness(4, raw);
    try {
      await h.installed.reconcile?.();
      assert.match((await h.installed.health()).detail, /not a whole number/u, `"${raw}" must be refused`);
    } finally {
      h.close();
    }
  }
});

test('/status before the boot check has run says the cap has not been read, and never guesses', async () => {
  // `unchecked` survives as an arm even though the port can always be asked now: `reconcile()`
  // has not run at this point, and claiming agreement here would be an invented fact about
  // somebody's spend.
  const h = capHarness(4, '4');
  try {
    const health = await h.installed.health();
    assert.match(health.detail, /has not been read/u);
    assert.doesNotMatch(health.detail, /agrees/u);
  } finally {
    h.close();
  }
});

test('/status before the boot check has run does not claim to know anything', async () => {
  const h = capHarness(4, '4');
  try {
    assert.match((await h.installed.health()).detail, /has not been read/u, 'reconcile() has not run yet');
    await h.installed.reconcile?.();
    assert.match((await h.installed.health()).detail, /agrees/u, 'and afterwards it has');
  } finally {
    h.close();
  }
});

test('the comparison itself is pure, so every arm is reachable without GitHub', () => {
  // The interesting arms are configuration states nobody can produce on demand in a live
  // repository, which is exactly why the decision is a function rather than an inline branch.
  assert.deepEqual(compareDailyRunCap({ kind: 'not-a-number' }, 4), { kind: 'repository-cap-unusable' });
  assert.deepEqual(compareDailyRunCap({ kind: 'set', cap: 4 }, 4), { kind: 'agrees', cap: 4, source: 'variable' });
  assert.deepEqual(compareDailyRunCap({ kind: 'unset' }, WORKFLOW_DEFAULT_DAILY_RUN_CAP), {
    kind: 'agrees',
    cap: WORKFLOW_DEFAULT_DAILY_RUN_CAP,
    source: 'workflow-default',
  });
  assert.deepEqual(compareDailyRunCap({ kind: 'set', cap: 2 }, 6), {
    kind: 'bot-higher',
    bot: 6,
    repository: 2,
    source: 'variable',
  });
  assert.deepEqual(compareDailyRunCap({ kind: 'set', cap: 9 }, 6), {
    kind: 'bot-lower',
    bot: 6,
    repository: 9,
    source: 'variable',
  });

  // The bot's own default must agree with the workflow's, or every fresh install starts drifted.
  assert.equal(WORKFLOW_DEFAULT_DAILY_RUN_CAP, 4, 'the workflow reads vars.AGENT_DAILY_RUN_CAP with a fallback of 4');
});

// ---------------------------------------------------------------------------------------
// Out of dispatch attempts
// ---------------------------------------------------------------------------------------

test('OUT OF DISPATCH ATTEMPTS is terminal: the row fails and the job does not retry', async () => {
  // It used to return a retryable `upstream` error, so the runner retried "out of attempts" until
  // the build deadline while the row sat in `dispatching` and `/request retry` refused it.
  const h = harness({ dailyRunCap: 4 });
  try {
    const id = seedDispatching(h.repo, 42);
    for (let i = 0; i < 3; i += 1) h.repo.countDispatchAttempt(id, NOW);

    const outcome = await h.build.run(payloadFor(id, 42), runtime());

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(isRetryable(outcome.error), false, 'the runner must dead-letter it now, not back off');
    assert.equal(h.dispatched.length, 0, 'no fourth dispatch');
    assert.equal(h.repo.get(id)?.state, 'failed', 'so /request retry accepts it and the slot is released');
  } finally {
    h.close();
  }
});
