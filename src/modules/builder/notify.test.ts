/**
 * THE TWO THINGS THAT MADE THIS PRODUCT UNPLEASANT TO USE, both invisible to every other test.
 *
 * ONE. **The approval card did not say what was being approved.** It rendered an issue number and
 * a sentence, so an approver was asked to authorise an Anthropic bill and a write to the
 * repository on the strength of `#42`. The title was already a PARAMETER of `approvalCard` and
 * was never rendered; the request body was never even passed in.
 *
 * TWO. **Nobody was ever told anything.** Every ending - PR opened, refused, failed, expired,
 * rejected - was delivered by EDITING a card that had long since scrolled away, and Discord does
 * not notify anybody about an edit. The audit's sentence for it was exact: *"Twenty minutes of
 * silence, and the outcome is delivered by an edit that notifies nobody."*
 *
 * The fix for two is `View.mentionUserId`, and the dangerous way to build it would be to let a
 * card mention whatever it is handed. So the last test in this file is structural: it asserts
 * that the ONLY expression in this module that ever produces a `mentionUserId` is the one that
 * has just proved the value is a snowflake, so there is no path from user text to a ping.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Ok } from '#core/result';
import { errors } from '#core/errors';
import type { ClickInvocation, ActionSpec } from '#core/module';
import type { View, ViewNode } from '#core/view';
import { newCardNonce, newFenceNonce, newRequestId } from '#core/ids';
import {
  GUILD,
  ISSUE_URL,
  NOW,
  PR_URL,
  REQUESTER,
  RUN_URL,
  SEED_SLOTS,
  SURFACE,
  channelId,
  guildId,
  harness,
  headings,
  lastEdit,
  lastPost,
  okStatus,
  payloadFor,
  prRef,
  progress,
  requestForm,
  runtime,
  seedAwaiting,
  seedRunning,
  submission,
  textOf,
  userId,
  type Harness,
} from '#modules/builder/harness.test';

const APPROVER = '555555555555555555';

/** Field NAMES, which is where "shortened" is announced. */
function fieldNames(view: View): readonly string[] {
  return view.nodes
    .filter((n): n is Extract<ViewNode, { kind: 'field' }> => n.kind === 'field')
    .map((n) => n.name);
}

function actionOf(h: Harness, name: string): ActionSpec {
  const found = h.installed.actions.find((a) => a.name === name);
  assert.ok(found !== undefined, `the builder must expose a "${name}" action`);
  if (found === undefined) throw new Error('unreachable');
  return found;
}

function click(entityId: string, action: string, actorId = APPROVER): ClickInvocation {
  return {
    id: newRequestId(NOW),
    actor: { userId: userId(actorId), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId('333333333333333333') },
    ref: { moduleId: 'builder', action, entityId, nonce: newCardNonce() },
    surface: SURFACE,
    progress: progress(),
    at: NOW,
  };
}

// ---------------------------------------------------------------------------------------
// ONE: what is being approved
// ---------------------------------------------------------------------------------------

test('the approval card carries the TITLE and an excerpt of the request, not just an issue number', async () => {
  const h = harness();
  try {
    const out = await requestForm(h).handle(
      submission({
        title: 'Dark mode for the dashboard',
        detail: 'Everyone on the night shift is squinting. Respect the OS setting and add a manual toggle.',
      }),
    );
    assert.equal(out.kind, 'view', 'the submission must be accepted');

    const card = lastPost(h);
    const said = textOf(card);
    assert.match(said, /Dark mode for the dashboard/u, 'the title was a parameter and was never rendered');
    assert.match(said, /night shift is squinting/u, 'the body was never even passed in');
    assert.match(said, /<@111111111111111111>/u, 'and an approver could not see who was asking');
    assert.match(said, /#1/u, 'the issue number stays - it was the only thing that used to be there');
  } finally {
    h.close();
  }
});

test('the excerpt goes through the sanitiser, so an approval card cannot be used as a weapon', async () => {
  const h = harness();
  try {
    await requestForm(h).handle(
      submission({
        title: 'Ship it',
        detail: 'Hey @everyone and @here look at this ```\ncode fence\n``` <!-- hidden --> and ​ invisible text',
      }),
    );

    const said = textOf(lastPost(h));
    assert.doesNotMatch(said, /@everyone/u, 'a mass ping must be defanged before it reaches a card');
    assert.doesNotMatch(said, /@here/u);
    assert.doesNotMatch(said, /```/u, 'an unclosed fence would swallow the rest of the card');
    assert.doesNotMatch(said, /<!--/u, 'an HTML comment is the other construct that escapes a container');
    assert.doesNotMatch(said, /​/u, 'zero-width characters hide instructions from a human reviewer');
    assert.match(said, /@ everyone/u, 'defanged, not deleted: the approver still sees what was asked');
  } finally {
    h.close();
  }
});

test('a request too long to quote SAYS it was shortened, rather than presenting half a sentence', async () => {
  const h = harness({ requestExcerptLength: 40 });
  try {
    await requestForm(h).handle(
      submission({ title: 'Long one', detail: 'A'.repeat(200) + ' and then the important caveat' }),
    );
    const card = lastPost(h);
    assert.ok(
      fieldNames(card).some((n) => n.includes('shortened')),
      `the card must admit the excerpt was cut; fields were ${fieldNames(card).join(', ')}`,
    );
    assert.doesNotMatch(textOf(card), /important caveat/u, 'and the cut really happened');
  } finally {
    h.close();
  }
});

test('the approval card does NOT ping - nobody is waiting on it yet, and the approver is reading it', async () => {
  const h = harness();
  try {
    await requestForm(h).handle(submission());
    assert.equal(lastPost(h).mentionUserId, undefined);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// TWO: somebody is told
// ---------------------------------------------------------------------------------------

test('THE PAYOFF: a pull request pings the requester instead of silently editing a dead card', async () => {
  const h = harness({}, { runStatus: () => okStatus('success', RUN_URL), findPrForBranch: async () => Ok(prRef(false)) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    assert.deepEqual(await h.build.run(payloadFor(id, 42), runtime()), { kind: 'done' });

    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Pull request ready']);
    assert.equal(
      view.mentionUserId,
      REQUESTER,
      'twenty minutes of silence must not end in an edit Discord notifies nobody about',
    );
    assert.equal(h.discord.posted.length, 1, 'the ending is POSTED, because Discord notifies on create');
    assert.equal(h.discord.edited.length, 0, 'and not echoed by a second message - one request, one card');
    assert.equal(h.repo.get(id)?.prUrl, PR_URL, 'and the PR URL is kept, so /request list can link it later');
  } finally {
    h.close();
  }
});

test('a DRAFT pull request pings too - "I could not finish" is the ending most worth reading', async () => {
  const h = harness({}, { runStatus: () => okStatus('success', RUN_URL), findPrForBranch: async () => Ok(prRef(true)) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    await h.build.run(payloadFor(id, 42), runtime());
    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Pull request opened - unfinished']);
    assert.equal(view.mentionUserId, REQUESTER);
  } finally {
    h.close();
  }
});

test('a deliberate refusal pings, because "nothing was built and here is why" is an answer', async () => {
  const h = harness({}, { runStatus: () => okStatus('success', RUN_URL), findPrForBranch: async () => Ok(null) });
  h.builds.report = { failedStep: null, stop: 'success', turns: 3, agent: { status: 'refused', summary: '', remaining: 'It asked for the token.' } };
  try {
    const id = seedRunning(h.repo, 42, 77);
    await h.build.run(payloadFor(id, 42), runtime());
    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Refused - nothing changed']);
    assert.equal(view.mentionUserId, REQUESTER);
  } finally {
    h.close();
  }
});

test('a failure pings - it is the ending a requester is least likely to go back and look for', async () => {
  const h = harness();
  try {
    const id = seedRunning(h.repo, 42, 77);
    await h.build.onDead(
      payloadFor(id, 42),
      errors.upstream('github', 500, 'Try again in a minute.'),
      runtime(),
    );
    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Build failed']);
    assert.equal(view.mentionUserId, REQUESTER);
    assert.match(textOf(view), /\/request retry/u, 'and a failure is no longer a dead end');
  } finally {
    h.close();
  }
});

test('EXPIRY pings, and it is the ending nobody chose - so nobody would ever have gone to look', async () => {
  const h = harness({ approvalTtlMs: 48 * 3_600_000 });
  try {
    seedAwaiting(h.repo, 901, NOW - 72 * 3_600_000);
    assert.deepEqual(await h.expire.run({}, runtime()), { kind: 'done' });

    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Expired - nobody approved this']);
    assert.equal(view.mentionUserId, REQUESTER);
    assert.match(textOf(view), /\/request retry/u, 'and it points at the way back, not at retyping it');
  } finally {
    h.close();
  }
});

test('a rejection pings the requester - but not when the requester is the one who pressed it', async () => {
  const h = harness();
  try {
    const byApprover = seedAwaiting(h.repo, 42);
    const out = await actionOf(h, 'reject').handle(click(byApprover, 'reject', APPROVER));
    // Somebody else rejected it, so the ending is POSTED with the ping and the card replaced -
    // the click has nothing left to edit.
    assert.equal(out.kind, 'silent');
    const posted = lastPost(h);
    assert.deepEqual(headings(posted), ['Rejected']);
    assert.equal(posted.mentionUserId, REQUESTER);
    assert.deepEqual(h.discord.deleted, [SURFACE], 'and the stale card is gone, so there is one message');
    assert.deepEqual(h.issues.closed, [42], 'and the issue is closed, exactly as before');

    const bySelf = seedAwaiting(h.repo, 43);
    const own = await actionOf(h, 'reject').handle(click(bySelf, 'reject', REQUESTER));
    assert.equal(own.kind, 'view');
    if (own.kind !== 'view') return;
    assert.equal(
      own.view.mentionUserId,
      undefined,
      'pinging somebody about the button they just pressed is noise, and noise is how pings get muted',
    );
  } finally {
    h.close();
  }
});

test('a requester id that is not a snowflake costs the ping and nothing else', async () => {
  const h = harness({}, { runStatus: () => okStatus('success', RUN_URL), findPrForBranch: async () => Ok(prRef(false)) });
  try {
    // A corrupt row - not something a user can produce, but the column is a plain string and the
    // consequence of trusting it would be mentioning an arbitrary id.
    const id = newRequestId(NOW);
    const claimed = h.repo.claimSlot(
      {
        id,
        state: 'draft',
        version: 1,
        guildId: GUILD,
        repoKey: 'default',
        requesterId: 'not-a-snowflake',
        nonce: newCardNonce(),
        fenceNonce: newFenceNonce(),
        title: 'Corrupt row',
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
    h.repo.recordIssue(id, 99, ISSUE_URL, SURFACE, NOW);
    h.repo.compareAndSet(id, h.repo.get(id)?.version ?? 0, 'dispatching', NOW);
    h.repo.recordRun(id, 78, RUN_URL, NOW);

    assert.deepEqual(await h.build.run(payloadFor(id, 99), runtime()), { kind: 'done' });
    const view = lastEdit(h);
    assert.deepEqual(headings(view), ['Pull request ready'], 'the card is still drawn');
    assert.equal(h.discord.posted.length, 0, 'with nobody to ping it is edited in place, not reposted');
    assert.equal(view.mentionUserId, undefined, 'and nobody arbitrary is mentioned');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// The structural guarantee, which no behavioural test can give
// ---------------------------------------------------------------------------------------

test('the ONLY thing that can produce a mentionUserId is a value that has proved it is a snowflake', () => {
  // WHY THIS IS WORTH A TEST. `allowed_mentions.parse` stays `[]`, so `@everyone` and role pings
  // remain structurally impossible - but `users: [id]` is an ALLOW-LIST, and an id that reached it
  // from user text would be a real ping the bot chose to send on a stranger's behalf.
  //
  // The wall is that exactly one expression in this module writes the field, and it is inside
  // `pingRequester`, which has just narrowed a `Result` from `toUserId`. Every card takes a
  // `Mention` and spreads it. Asserted textually, in the same spirit as `conventions.test.ts`,
  // because a type cannot express "this string was proved rather than passed through".
  const files = ['cards.ts', 'module.ts', 'history.ts', 'rows.ts', 'payer.ts'];
  const written: string[] = [];

  for (const file of files) {
    const code = readFileSync(`src/modules/builder/${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ');
    for (const m of code.matchAll(/mentionUserId:\s*([^,\n}]+)/gu)) written.push(`${file}:${(m[1] ?? '?').trim()}`);
  }

  assert.deepEqual(
    written,
    ['cards.ts:id.value'],
    'something else now writes mentionUserId. It must come from pingRequester, which proves the value with toUserId first — never from user text, and never from a raw column read.',
  );

  const cards = readFileSync('src/modules/builder/cards.ts', 'utf8');
  assert.match(
    cards,
    /const id = toUserId\(requesterId\);\s*\n\s*return id\.ok \? \{ mentionUserId: id\.value \} : NO_PING;/u,
    'pingRequester must still prove the snowflake before mentioning it',
  );
});

test('the renderer keeps parse:[] — a mention allow-list is not permission to mass-ping', () => {
  // The shared contract widens `allowed_mentions` with a `users` list and leaves `parse` empty.
  // If that ever became `parse: ['users']` or `['everyone']`, every card in this module would
  // become a mass-ping vector via text it faithfully re-renders from a GitHub API response.
  const render = readFileSync('src/adapters/discord/render.ts', 'utf8');
  assert.match(render, /parse:\s*\[\]/u, 'allowed_mentions.parse must stay empty');
  assert.doesNotMatch(render, /parse:\s*\[\s*'everyone'/u);
});
