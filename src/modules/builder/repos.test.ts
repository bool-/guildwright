/**
 * The builder over a REPOSITORY SET with GUILD ROUTING (RFC-001 PR 2.1 and 2.2, section 7.3).
 *
 * WHAT IS ASSERTED, and the rule behind each:
 *  - The front door files a request in `ReposPort.resolve(guild)`: the guild's `/repo use` link,
 *    else the default repository, else a refusal with the RFC's exact sentence - nothing filed.
 *  - The resolved key is PERSISTED on the row (`repo_key`, migration 0005), and every later step
 *    reads it back through `byKey`: re-linking a guild mid-build does not move the poll, and
 *    `/request retry` re-resolves the ROW's key against the set as it is now - refusing when the
 *    operator has removed it, and never following the guild's new link.
 *  - Each step reaches the request's own repository through `.at()`: the dispatch pass and the
 *    expiry sweep never touch a neighbour.
 *  - `/status` (the module's health) reports per repository; `repoActivity` counts in flight.
 *
 * The migration and the boot adoption of rows on an unconfigured key are `repo-key.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fakeRepoSet } from '#testing/fakes';
import { Err } from '#core/result';
import { errors } from '#core/errors';
import { newApprovalId, toGuildId, type GuildId } from '#core/ids';
import {
  GUILD,
  HOUR,
  NOW,
  REQUESTER,
  commandOf,
  harness,
  invocation,
  payloadFor,
  requestForm,
  runtime,
  seedAwaiting,
  seedDispatching,
  submission,
} from '#modules/builder/harness.test';

/** A second server. */
const OTHER_GUILD = '222222222222222299';

function twoRepos(defaultKey: 'main' | null = 'main') {
  return fakeRepoSet([
    { key: 'main', owner: 'acme', repo: 'bot-modules', isDefault: defaultKey === 'main' },
    { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
  ]);
}

/** A mutable `/repo use` table, read on every call the way `repoTargetReader` reads settings. */
function links(initial: Readonly<Record<string, string>> = {}) {
  const table = new Map<string, string>(Object.entries(initial));
  return {
    table,
    mapping: (guildId: GuildId): string | null => table.get(guildId) ?? null,
  };
}

function gid(raw: string): GuildId {
  const g = toGuildId(raw);
  if (!g.ok) throw new Error('fixture');
  return g.value;
}

// ---------------------------------------------------------------------------------------
// The front door
// ---------------------------------------------------------------------------------------

test('ROUTING: guild A linked to events files there; guild B, unlinked, uses the default (main)', async () => {
  const l = links({ [GUILD]: 'events' });
  const h = harness({}, {}, {}, twoRepos(), l.mapping);
  try {
    const events = h.neighbours['events'];
    assert.ok(events !== undefined);

    const a = await requestForm(h).handle(submission(undefined, REQUESTER, GUILD));
    assert.equal(a.kind, 'view', 'filed');
    assert.equal(events.issues.created.length, 1, 'guild A lands in its linked repository');
    assert.equal(events.builds.gateChecks, 1, 'gated there');
    assert.equal(h.issues.created.length, 0, 'and not in the default');

    const b = await requestForm(h).handle(submission(undefined, REQUESTER, OTHER_GUILD));
    assert.equal(b.kind, 'view');
    assert.equal(h.issues.created.length, 1, 'guild B, with no link, lands in the default repository');
    assert.equal(events.issues.created.length, 1);

    const keys = [...h.repo.inFlightByRepo().entries()].sort();
    assert.deepEqual(keys, [['events', 1], ['main', 1]], 'each row persisted the repository it was filed in');
  } finally {
    h.close();
  }
});

test('ROUTING: guild B unlinked with NO default is refused at the front door with the exact sentence, filing nothing', async () => {
  const l = links({ [GUILD]: 'events' });
  const h = harness({}, {}, {}, twoRepos(null), l.mapping);
  try {
    const out = await requestForm(h).handle(submission(undefined, REQUESTER, OTHER_GUILD));
    assert.equal(out.kind, 'fail');
    if (out.kind !== 'fail') return;
    assert.equal(out.error.code, 'config.repos.unmapped');
    assert.equal(out.error.internal, 'This server is not linked to a repository yet, so nothing can be built from it.');
    assert.equal(out.error.nextStep, 'Ask the bot operator to run /repo use in this server.', 'the next step is /repo use now');
    const filed = h.issues.created.length + Object.values(h.neighbours).reduce((n, x) => n + x.issues.created.length, 0);
    assert.equal(filed, 0, 'nothing filed anywhere');
    assert.equal(h.repo.inFlightForGuild(OTHER_GUILD), 0, 'and no slot claimed');

    // ...and guild A, which IS linked, still builds: no default is not "nothing works".
    assert.equal((await requestForm(h).handle(submission(undefined, REQUESTER, GUILD))).kind, 'view');
    assert.equal(h.neighbours['events']?.issues.created.length, 1);
  } finally {
    h.close();
  }
});

test('ROUTING: a guild linked to a repository the operator REMOVED is refused - never handed to the default', async () => {
  const l = links({ [GUILD]: 'gone' });
  const h = harness({}, {}, {}, twoRepos(), l.mapping);
  try {
    const out = await requestForm(h).handle(submission());
    assert.equal(out.kind, 'fail');
    assert.equal(out.kind === 'fail' ? out.error.code : '', 'config.repos.stale_link');
    assert.match(out.kind === 'fail' ? (out.error.internal ?? '') : '', /linked to the repository gone, which this bot is no longer configured for/u);
    assert.equal(h.issues.created.length, 0, 'the default repository is another trust domain; nothing lands there');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// Later steps follow the ROW's key
// ---------------------------------------------------------------------------------------

test('ROW KEY WINS: re-linking the guild mid-build does not move the poll', async () => {
  const l = links({ [GUILD]: 'events' });
  const h = harness({}, {}, {}, twoRepos(), l.mapping);
  try {
    const events = h.neighbours['events'];
    assert.ok(events !== undefined);
    const filed = await requestForm(h).handle(submission());
    assert.equal(filed.kind, 'view');
    const row = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0];
    assert.ok(row !== undefined && row.issueNumber !== null);
    assert.equal(row.repoKey, 'events');
    assert.ok(h.repo.compareAndSet(row.id, row.version, 'dispatching', NOW, { approvalId: newApprovalId() }));

    // The operator re-links the guild while the request is being built.
    l.table.set(GUILD, 'main');

    const outcome = await h.build.run(payloadFor(row.id, row.issueNumber), runtime());
    assert.equal(outcome.kind, 'retry', 'dispatched; now polling');
    assert.equal(events.builds.dispatched.length, 1, 'in the repository the request was FILED in');
    assert.equal(h.dispatched.length, 0, 'not in the one the guild is linked to now');
    assert.equal(h.repo.get(row.id)?.repoKey, 'events', 'and the row still says so');

    // A NEW request from the guild follows the new link.
    assert.equal((await requestForm(h).handle(submission())).kind, 'view');
    assert.equal(h.issues.created.length, 1);
  } finally {
    h.close();
  }
});

test('RETRY RE-RESOLVES THE ROW\'S KEY: a failed build in events retries in events, whatever the guild is linked to now', async () => {
  const l = links({ [GUILD]: 'main' });
  const h = harness({}, {}, {}, twoRepos(), l.mapping);
  try {
    const events = h.neighbours['events'];
    assert.ok(events !== undefined);
    const id = seedDispatching(h.repo, 42, 'events');
    assert.ok(h.repo.finish(id, 'failed', NOW));

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'view', 're-armed');
    assert.equal(events.builds.gateChecks, 1, 'the retry gated in the row\'s repository');
    assert.equal(h.builds.gateChecks, 0, 'not in the guild\'s current one');

    const job = h.jobs.enqueued.at(-1);
    assert.ok(job !== undefined);
    await h.build.run(job.payload, runtime());
    assert.equal(events.builds.dispatched.length, 1, 'and dispatched there');
    assert.equal(h.dispatched.length, 0);
  } finally {
    h.close();
  }
});

test('RETRY REFUSES a request whose persisted repository is no longer configured, and changes nothing', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    const id = seedDispatching(h.repo, 42, 'gone');
    assert.ok(h.repo.finish(id, 'failed', NOW));
    const before = h.repo.get(id);

    const out = await commandOf(h, 'request retry').handle(invocation({ args: { id } }));
    assert.equal(out.kind, 'fail');
    if (out.kind !== 'fail') return;
    assert.equal(out.error.code, 'config.repos.request_repo_gone');
    assert.equal(out.error.internal, 'This request was filed in the repository gone, which this bot is no longer configured for.');
    assert.deepEqual(h.repo.get(id), before, 'still failed, same version, same retry count');
    assert.equal(h.jobs.enqueued.length, 0, 'nothing queued');
    for (const n of [h.builds, ...Object.values(h.neighbours).map((x) => x.builds)]) {
      assert.equal(n.gateChecks + n.dispatched.length, 0, 'and no repository was asked anything');
    }
  } finally {
    h.close();
  }
});

test('A ROW ON AN UNCONFIGURED KEY fails its dispatch pass instead of guessing, and its slot comes back', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    const id = seedDispatching(h.repo, 42, 'gone');
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' ? outcome.error.code : '', 'config.repos.request_repo_gone');
    assert.equal(h.repo.get(id)?.state, 'failed', 'finished, so the guild gets its slot back');
    for (const n of [h.builds, ...Object.values(h.neighbours).map((x) => x.builds)]) assert.equal(n.dispatched.length, 0);
  } finally {
    h.close();
  }
});

test('REPO SET: the dispatch pass gates, counts, signs and dispatches in the request\'s repository only', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    const id = seedDispatching(h.repo, 42, 'main');
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(outcome.kind, 'retry', 'dispatched; now polling');
    assert.equal(h.dispatched.length, 1, 'dispatched in the request\'s repository');
    assert.equal(h.builds.gateChecks, 1, 'whose gate files were the ones checked');
    const events = h.neighbours['events'];
    assert.ok(events !== undefined);
    assert.equal(events.builds.dispatched.length, 0, 'nothing dispatched in the neighbour');
    assert.equal(events.builds.gateChecks, 0, 'and its gates were not consulted for this build');
  } finally {
    h.close();
  }
});

test('REPO SET: the expiry sweep closes the issue in the request\'s repository, not its neighbour\'s', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    seedAwaiting(h.repo, 77, NOW - 72 * HOUR, GUILD, 'events');
    await h.expire.run({}, runtime());
    assert.deepEqual(h.neighbours['events']?.issues.closed, [77], 'closed where it was filed');
    assert.deepEqual(h.issues.closed, []);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// What the module reports: /status per repository, and repoActivity for /repo
// ---------------------------------------------------------------------------------------

test('/STATUS PER REPOSITORY: each repository\'s readiness and in-flight count; degraded when one is down', async () => {
  const h = harness({}, {}, {}, twoRepos());
  try {
    seedAwaiting(h.repo, 1, NOW, GUILD, 'events');
    seedAwaiting(h.repo, 2, NOW, GUILD, 'events');
    seedAwaiting(h.repo, 3, NOW, GUILD, 'main');
    const ok = await h.installed.health();
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /repositories: main \(acme\/bot-modules, default\): ready, 1 in flight; events \(acme\/events-modules\): ready, 2 in flight/u);

    const events = h.neighbours['events'];
    assert.ok(events !== undefined);
    events.builds.gateAnswer = Err(errors.config('github.gates', 'Builds are disabled: drift in acme/events-modules.', 'Run template apply.'));
    await events.builds.verifyGates();
    const degraded = await h.installed.health();
    assert.equal(degraded.status, 'degraded', 'a guild linked to events cannot build');
    assert.match(degraded.detail, /events \(acme\/events-modules\): down - .*, 2 in flight/u);

    h.builds.gateAnswer = Err(errors.config('github.gates', 'Builds are disabled: drift in acme/bot-modules.', 'Run template apply.'));
    await h.builds.verifyGates();
    assert.equal((await h.installed.health()).status, 'down', 'nothing can build anywhere');
  } finally {
    h.close();
  }
});

test('/STATUS with no default: not down - a linked guild can still build - and it says how a server gets a repository', async () => {
  const h = harness({}, {}, {}, twoRepos(null));
  try {
    const health = await h.installed.health();
    assert.equal(health.status, 'ok');
    assert.match(health.detail, /no repository is the default, so a server builds only once an operator runs \/repo use in it/u);
  } finally {
    h.close();
  }
});

test('/STATUS of a one-repository install is unchanged: no per-repository section', async () => {
  const h = harness();
  try {
    seedAwaiting(h.repo, 1);
    assert.doesNotMatch((await h.installed.health()).detail, /repositories:/u);
  } finally {
    h.close();
  }
});

test('repoActivity: what /repo clear and /repo show read - in flight per guild and per repository, terminal rows excluded', async () => {
  const set = twoRepos();
  const h = harness({}, {}, {}, set);
  try {
    const activity = h.installed.repoActivity;
    assert.ok(activity !== null, 'the builder reports its work per repository');
    seedAwaiting(h.repo, 1, NOW, GUILD, 'events');
    const done = seedAwaiting(h.repo, 2, NOW, GUILD, 'events');
    assert.ok(h.repo.finish(done, 'rejected', NOW));
    seedAwaiting(h.repo, 3, NOW, OTHER_GUILD, 'main');

    assert.equal(activity.inFlightForGuild(gid(GUILD)), 1, 'the rejected row is terminal');
    assert.equal(activity.inFlightForGuild(gid(OTHER_GUILD)), 1);
    const events = set.byKey('events');
    assert.ok(events !== null);
    const seen = activity.inRepo(events);
    assert.equal(seen.inFlight, 1);
    assert.match(seen.detail, /^builds ready; up to 4 agent runs per UTC day$/u, 'readiness and the cap, for /repo show');
  } finally {
    h.close();
  }
});
