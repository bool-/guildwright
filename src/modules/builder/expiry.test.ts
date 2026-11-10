/**
 * THE GUILD-BRICKING BUG, AND ITS RELEASE VALVE.
 *
 * `expired` was declared in three places - the `BuildState` union, the SQL CHECK constraint, and
 * the terminal list `finish` guards on - and written by NOTHING. Since the concurrency count
 * includes `awaiting_approval`, and `maxConcurrentPerGuild` defaults to 2, two requests that
 * nobody clicked exhausted a guild PERMANENTLY: every later `/request` was refused with "Too many
 * builds are already in flight here. Wait for one to finish." - about builds that did not exist
 * and would never finish. The only way out was Reject, which is gated on `builder.approve`, whose
 * fallback is `nobody` and which no command could grant.
 *
 * So the first test here is the whole product failure, end to end: fill the guild with unclicked
 * requests, watch `/request` refuse, run the sweep, watch `/request` work again. Everything after
 * it pins one of the three things the sweep must do - release the slot, close the issue, resolve
 * the card - because doing only some of them leaves the request half-abandoned rather than
 * finished.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Ok } from '#core/result';

import { concurrencyError, ttlHours } from '#modules/builder/module';
import type { ClickInvocation, FormHandlerSpec, FormSubmission, Outcome, ProgressHandle } from '#core/module';
import type { FormValues } from '#core/args';
import { userMessage } from '#core/errors';
import { toEnum, userTextForTest } from '#core/text';
import { newCardNonce, newRequestId, toChannelId, toGuildId, toUserId, type ChannelId, type GuildId, type RequestId, type UserId } from '#core/ids';
import type { ButtonSpec, SurfaceRef, View, ViewNode } from '#core/view';
import {
  CHANNEL,
  GUILD,
  HOUR,
  ISSUE_URL,
  NOW,
  REQUESTER,
  harness,
  headings,
  links,
  runtime,
  seedAwaiting,
  seedRunning,
  textOf,
  type Harness,
} from '#modules/builder/harness.test';

function userId(raw: string): UserId {
  const r = toUserId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a user id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function guildId(raw: string): GuildId {
  const r = toGuildId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a guild id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function channelId(raw: string): ChannelId {
  const r = toChannelId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a channel id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

/**
 * The one cast in this file, and it is structural rather than lazy: `ProgressHandle` carries a
 * module-private symbol so that a live interaction token cannot be smuggled into a durable job
 * payload. A test therefore cannot build one by writing the fields, and the router does exactly
 * this same cast for exactly this reason. Nothing on the paths below reads it.
 */
function progress(): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => ({ guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' }),
  };
  return stub as unknown as ProgressHandle;
}

function values(fields: Readonly<Record<string, string>>): FormValues {
  return {
    names: Object.keys(fields),
    text(name) {
      const raw = fields[name];
      return raw === undefined ? undefined : userTextForTest(raw);
    },
    textRequired(name) {
      const raw = fields[name];
      if (raw === undefined) throw new Error(`no field "${name}" was submitted`);
      return userTextForTest(raw);
    },
    choice(name, allowed) {
      const raw = fields[name];
      return raw === undefined ? Ok(undefined) : toEnum(userTextForTest(raw), allowed);
    },
  };
}

function submission(): FormSubmission {
  return {
    id: newRequestId(NOW),
    actor: { userId: userId(REQUESTER), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action: 'request', entityId: newRequestId(NOW), nonce: newCardNonce() },
    fields: values({ title: 'Add a /ping command', detail: 'It should reply pong, and nothing else.' }),
    progress: progress(),
    at: NOW,
  };
}

function click(entityId: RequestId): ClickInvocation {
  return {
    id: newRequestId(NOW),
    actor: { userId: userId('555555555555555555'), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action: 'approve', entityId, nonce: newCardNonce() },
    surface: { guildId: GUILD, channelId: CHANNEL, messageId: '444444444444444444' },
    progress: progress(),
    at: NOW,
  };
}

function requestForm(h: Harness): FormHandlerSpec {
  const form = h.installed.forms.find((f) => f.name === 'request');
  assert.ok(form !== undefined, 'the builder must expose a "request" form handler');
  if (form === undefined) throw new Error('unreachable');
  return form;
}

function buttonsOf(view: View): readonly ButtonSpec[] {
  return view.nodes
    .filter((n): n is Extract<ViewNode, { kind: 'buttons' }> => n.kind === 'buttons')
    .flatMap((n) => n.buttons);
}

function failureText(outcome: Outcome): string {
  assert.equal(outcome.kind, 'fail', `expected a refusal, got "${outcome.kind}"`);
  return outcome.kind === 'fail' ? userMessage(outcome.error) : '';
}

// ---------------------------------------------------------------------------------------
// THE BUG
// ---------------------------------------------------------------------------------------

test('two requests nobody clicked used to brick a guild FOREVER; the sweep gives it back', async () => {
  const h = harness();
  try {
    // Two requests, filed three days ago, that no approver ever touched. This is not an exotic
    // state: `builder.approve` falls back to `nobody`, so until an admin grants that permission
    // it is the ONLY state a guild can reach.
    // Issue numbers well clear of the ones `fakeIssues` will mint: `m_builder_requests` carries a
    // UNIQUE index on issue_number, which is itself a guard worth keeping - one request per issue.
    seedAwaiting(h.repo, 901, NOW - 72 * HOUR);
    seedAwaiting(h.repo, 902, NOW - 72 * HOUR);
    assert.deepEqual(h.repo.activeCounts(GUILD), { waiting: 2, running: 0, filing: 0 });

    const form = requestForm(h);
    const blocked = await form.handle(submission());
    assert.equal(blocked.kind, 'fail', 'the default cap of 2 is exhausted, so the flagship command is dead');
    assert.equal(h.issues.created.length, 0, 'and nothing was filed');

    // ONE HOURLY SWEEP.
    assert.deepEqual(await h.expire.run({}, runtime()), { kind: 'done' });
    assert.deepEqual(h.repo.activeCounts(GUILD), { waiting: 0, running: 0, filing: 0 }, 'both slots come back');

    const allowed = await form.handle(submission());
    assert.equal(allowed.kind, 'view', 'and /request works again, which it never would have before');
    assert.equal(h.issues.created.length, 1, 'the request really was filed this time');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// What the sweep sweeps, and what it must never touch
// ---------------------------------------------------------------------------------------

test('the sweep expires only requests older than approvalTtlMs', async () => {
  const h = harness({ approvalTtlMs: 48 * HOUR });
  try {
    const old = seedAwaiting(h.repo, 1, NOW - 72 * HOUR);
    const young = seedAwaiting(h.repo, 2, NOW - 2 * HOUR);

    await h.expire.run({}, runtime());

    assert.equal(h.repo.get(old)?.state, 'expired');
    assert.equal(h.repo.get(young)?.state, 'awaiting_approval', 'a request filed this morning is not stale');
  } finally {
    h.close();
  }
});

test('the sweep never touches a build that is actually running, however old', async () => {
  // A poll job can legitimately run for six hours, and a short TTL must not expire a row out from
  // underneath a paid run - which would abandon the build and resolve its card as "nobody
  // approved this", about a build somebody demonstrably approved.
  const h = harness({ approvalTtlMs: HOUR });
  try {
    const running = seedRunning(h.repo, 1, 99, NOW - 72 * HOUR);
    await h.expire.run({}, runtime());
    assert.equal(h.repo.get(running)?.state, 'running');
  } finally {
    h.close();
  }
});

test('an expiry closes the GitHub issue not_planned, exactly as a rejection does', async () => {
  // Otherwise the repository accumulates open issues describing work nobody will ever do, and a
  // reader cannot tell "not built yet" from "abandoned".
  const h = harness();
  try {
    seedAwaiting(h.repo, 77, NOW - 72 * HOUR);
    await h.expire.run({}, runtime());
    assert.deepEqual(h.issues.closed, [77]);
  } finally {
    h.close();
  }
});

test('the card VISIBLY resolves: expired heading, no dead buttons, and a link to the issue', async () => {
  const h = harness();
  try {
    seedAwaiting(h.repo, 42, NOW - 72 * HOUR);
    await h.expire.run({}, runtime());

    const view = h.discord.drawn.at(-1);
    assert.ok(view !== undefined, 'the sweep must update the card, or the request merely goes quiet');
    if (view === undefined) return;

    assert.deepEqual(headings(view), ['Expired - nobody approved this']);
    assert.match(textOf(view), /48 hours/u, 'and it says how long it waited');
    assert.deepEqual(links(view), [{ label: 'Issue', url: ISSUE_URL }]);
    // Ending cards carry links only. The posted card replaces the one with Approve/Reject, so
    // there is no dead pair of buttons left in the channel.
    assert.equal(buttonsOf(view).length, 0);
    assert.equal(h.discord.deleted.length, 1, 'and the card that had the buttons is gone');
  } finally {
    h.close();
  }
});

test('a request that expired cannot then be approved', async () => {
  const h = harness();
  try {
    const id = seedAwaiting(h.repo, 1, NOW - 72 * HOUR);
    await h.expire.run({}, runtime());

    const approve = h.installed.actions.find((a) => a.name === 'approve');
    assert.ok(approve !== undefined);
    if (approve === undefined) return;

    // The disabled buttons are the visible half; this is the enforcing half. A click on a card
    // that has scrolled far up someone's history must not start a build hours after it expired.
    const outcome = await approve.handle(click(id));
    assert.equal(outcome.kind, 'fail', 'an expired request is not waiting for approval any more');
    assert.equal(h.repo.get(id)?.state, 'expired');
  } finally {
    h.close();
  }
});

test('the audit records that NOBODY did this, rather than blaming the requester', async () => {
  const h = harness();
  try {
    seedAwaiting(h.repo, 5, NOW - 72 * HOUR);
    await h.expire.run({}, runtime());

    const entry = h.audit.entries.find((e) => e.action === 'builder.expire');
    assert.ok(entry !== undefined, 'an expiry is a state change worth recording');
    if (entry === undefined) return;
    assert.notEqual(entry.actorId, REQUESTER, 'attributing it to the requester reads as "they withdrew it"');
    assert.equal(entry.guildId, GUILD);
  } finally {
    h.close();
  }
});

test('one pass frees every guild, not just the first one it finds', async () => {
  const h = harness();
  try {
    const a = seedAwaiting(h.repo, 1, NOW - 72 * HOUR, GUILD);
    const b = seedAwaiting(h.repo, 2, NOW - 72 * HOUR, '888888888888888888');

    assert.deepEqual(await h.expire.run({}, runtime()), { kind: 'done' });

    assert.equal(h.repo.get(a)?.state, 'expired');
    assert.equal(h.repo.get(b)?.state, 'expired');
  } finally {
    h.close();
  }
});

test('the sweep is safe to run when there is nothing to do', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.expire.run({}, runtime()), { kind: 'done' });
    assert.equal(h.discord.edited.length, 0);
    assert.equal(h.issues.closed.length, 0);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The refusal that used to lie
// ---------------------------------------------------------------------------------------

test('a guild blocked by UNAPPROVED requests is told to find an approver, not to wait', async () => {
  const h = harness();
  try {
    seedAwaiting(h.repo, 901, NOW - HOUR);
    seedAwaiting(h.repo, 902, NOW - HOUR);

    const message = failureText(await requestForm(h).handle(submission()));

    assert.match(message, /waiting for an approver/u, 'name the actual blocker');
    assert.match(message, /nothing is actually building/u, 'and correct the old message, which said the opposite');
    assert.match(message, /approve or reject/u, 'the action that clears it');
    assert.match(message, /48 hours/u, 'and how long it takes to clear itself if nobody acts');
    assert.doesNotMatch(message, /Wait for one to finish/u, 'the one instruction that could never work');
  } finally {
    h.close();
  }
});

test('a guild blocked by RUNNING builds is told to wait, because waiting works', async () => {
  const h = harness();
  try {
    seedRunning(h.repo, 1, 11);
    seedRunning(h.repo, 2, 12);

    const message = failureText(await requestForm(h).handle(submission()));

    assert.match(message, /2 builds are already building/u);
    assert.match(message, /Wait for one to finish/u);
    assert.doesNotMatch(message, /approver/u, 'there is nobody to chase; these are approved and running');
  } finally {
    h.close();
  }
});

test('the mixed case names both, because only one half can be hurried', () => {
  // Asserted on the pure function as well as through the handler: the wording IS the fix, and it
  // has three arms, only two of which a two-slot default can reach through a handler.
  const message = userMessage(concurrencyError({ waiting: 2, running: 1, filing: 0 }, 48 * HOUR));
  assert.match(message, /1 build is building here/u);
  assert.match(message, /2 requests are still waiting for an approver/u);
  assert.match(message, /Wait for the build to finish, or ask an approver/u);
});

test('singular and plural are both grammatical, because this sentence is read under stress', () => {
  const one = userMessage(concurrencyError({ waiting: 1, running: 0, filing: 0 }, 48 * HOUR));
  assert.match(one, /1 request is still waiting/u);
  assert.match(one, /approve or reject it/u);

  const many = userMessage(concurrencyError({ waiting: 3, running: 0, filing: 0 }, 48 * HOUR));
  assert.match(many, /3 requests are still waiting/u);
  assert.match(many, /approve or reject them/u);
});

test('the TTL in the message is derived from config, not from a hard-coded 48', () => {
  assert.equal(ttlHours(48 * HOUR), 48);
  assert.equal(ttlHours(2 * HOUR), 2);
  assert.equal(ttlHours(60_000), 1, 'a sub-hour TTL still reads as "1 hour" rather than "0 hours"');
  assert.match(userMessage(concurrencyError({ waiting: 1, running: 0, filing: 0 }, 6 * HOUR)), /6 hours/u);
});

test('/status reports the TTL, because it is the other number that decides whether /request works', async () => {
  const h = harness();
  try {
    const health = await h.installed.health();
    assert.match(health.detail, /expire after 48h/u);
    assert.match(health.detail, /own build/u, 'without dropping the funding model it already reported');
  } finally {
    h.close();
  }
});
