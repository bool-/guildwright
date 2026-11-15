/**
 * SPONSORING (2.2): somebody other than the requester pays, by their own click.
 *
 * THE RULES THESE TESTS PIN, each a door if it is lost:
 *
 *   1. Only the clicker's OWN credentials can be put on the bill; there is no way to name a sponsor.
 *   2. Sponsoring answers WHO PAYS, never WHETHER: an approver still approves, and the sponsor
 *      cannot be that approver (unless self-approval is on).
 *   3. Nobody's bill grows from an earlier click: every retry and revision is sponsored afresh.
 *   4. The dispatch pays from the sponsor's environment, and that is what the approval MAC signs.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { userMessage } from '#core/errors';
import { buildEnvironmentName, renderSafeMarkdown } from '#core/text';
import { newCardNonce, newRequestId, toCardNonce, type RequestId } from '#core/ids';
import type { ClickInvocation, JobOutcome, Outcome } from '#core/module';
import type { View } from '#core/view';
import {
  CHANNEL,
  GUILD,
  HOUR,
  NOW,
  REQUESTER,
  SURFACE,
  channelId,
  commandOf,
  guildId,
  harness,
  invocation,
  payloadFor,
  progress,
  requestForm,
  runtime,
  submission,
  userId,
  type Harness,
} from '#modules/builder/harness.test';

const SPONSOR = '777777777777777777';
const APPROVER = '555555555555555555';
const STRANGER = '888888888888888888';

/** A requester with no build credentials files a request; returns its id. */
async function fileUnfunded(h: Harness): Promise<RequestId> {
  h.builds.environments.delete(buildEnvironmentName(REQUESTER));
  const out = await requestForm(h).handle(submission());
  assert.equal(out.kind, 'view', 'filed');
  const row = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0];
  assert.ok(row !== undefined);
  if (row === undefined) throw new Error('unreachable');
  return row.id;
}

function fund(h: Harness, who: string): void {
  h.builds.environments.set(buildEnvironmentName(who), ['ANTHROPIC_API_KEY']);
}

function click(h: Harness, id: RequestId, action: 'sponsor' | 'approve' | 'reject', actorId: string, nonceOverride?: string): ClickInvocation {
  const nonce = toCardNonce(nonceOverride ?? h.repo.get(id)?.nonce ?? '');
  return {
    id: newRequestId(NOW),
    actor: { userId: userId(actorId), roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: guildId(GUILD), channelId: channelId(CHANNEL) },
    ref: { moduleId: 'builder', action, entityId: id, nonce: nonce.ok ? nonce.value : newCardNonce() },
    surface: SURFACE,
    progress: progress(),
    at: NOW,
  };
}

function press(h: Harness, id: RequestId, action: 'sponsor' | 'approve' | 'reject', actorId: string): Promise<Outcome> {
  const spec = h.installed.actions.find((a) => a.name === action);
  assert.ok(spec !== undefined, `the builder declares a ${action} action`);
  if (spec === undefined) throw new Error('unreachable');
  return spec.handle(click(h, id, action, actorId));
}

function said(view: View): string {
  return view.nodes
    .map((n) => (n.kind === 'field' ? `${n.name}: ${renderSafeMarkdown(n.md)}` : n.kind === 'text' ? renderSafeMarkdown(n.md) : n.kind === 'buttons' ? n.buttons.map((b) => b.label).join(' | ') : ''))
    .join('\n');
}

function viewOf(outcome: Outcome): View {
  assert.equal(outcome.kind, 'view', `expected a redrawn card, got "${outcome.kind}"`);
  if (outcome.kind !== 'view') throw new Error('unreachable');
  return outcome.view;
}

function refusal(outcome: Outcome): string {
  assert.equal(outcome.kind, 'fail', `expected a refusal, got "${outcome.kind}"`);
  return outcome.kind === 'fail' ? userMessage(outcome.error) : '';
}

/** Run the build job's first pass (the dispatch). */
function dispatchPass(h: Harness, id: RequestId): Promise<JobOutcome> {
  const row = h.repo.get(id);
  return h.build.run(payloadFor(id, row?.issueNumber ?? 1), runtime());
}

// ---------------------------------------------------------------------------------------
// The Sponsor button
// ---------------------------------------------------------------------------------------

test('a sponsor with credentials pays by their own click; the card says so and offers Withdraw', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    const before = h.repo.get(id);

    const card = viewOf(await press(h, id, 'sponsor', SPONSOR));

    const row = h.repo.get(id);
    assert.equal(row?.sponsorId, SPONSOR);
    assert.notEqual(row?.nonce, before?.nonce, 'a new card nonce: the card drawn before the change is inert');
    assert.match(said(card), new RegExp(`Paid by: <@${SPONSOR}> \\(sponsor\\)`, 'u'));
    assert.match(said(card), /Withdraw sponsorship/u);
    assert.match(said(card), /It should reply pong\./u, 'the redrawn card keeps what was asked for');
    assert.ok(h.audit.entries.some((e) => e.action === 'builder.sponsor'));
  } finally {
    h.close();
  }
});

test('somebody with NO credentials cannot sponsor - nothing can be put on a bill that does not exist', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    assert.match(refusal(await press(h, id, 'sponsor', STRANGER)), /\/credentials set/u);
    assert.equal(h.repo.get(id)?.sponsorId, null);
  } finally {
    h.close();
  }
});

test('the sponsor can withdraw; nobody else can replace or remove them', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    fund(h, STRANGER);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.match(refusal(await press(h, id, 'sponsor', STRANGER)), /already sponsoring/u, 'a second sponsor is refused, not swapped in');
    assert.equal(h.repo.get(id)?.sponsorId, SPONSOR);

    const card = viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.equal(h.repo.get(id)?.sponsorId, null, 'withdrawn');
    assert.match(said(card), /needs a sponsor/u);
  } finally {
    h.close();
  }
});

test('a request whose requester pays for themselves offers no sponsoring', async () => {
  const h = harness();
  try {
    const out = await requestForm(h).handle(submission());
    assert.equal(out.kind, 'view');
    const id = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0]?.id;
    assert.ok(id !== undefined);
    if (id === undefined) return;
    const card = h.discord.posted.at(-1)?.view;
    assert.ok(card !== undefined && !said(card).includes('Sponsor'), 'no Sponsor button on a self-funded card');
    fund(h, SPONSOR);
    assert.match(refusal(await press(h, id, 'sponsor', SPONSOR)), /pays for it with their own credentials/u);
  } finally {
    h.close();
  }
});

test('a click from a superseded card cannot sponsor', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    const spec = h.installed.actions.find((a) => a.name === 'sponsor');
    assert.ok(spec !== undefined);
    if (spec === undefined) return;
    const out = await spec.handle(click(h, id, 'sponsor', SPONSOR, newCardNonce()));
    assert.match(refusal(out), /superseded/u);
    assert.equal(h.repo.get(id)?.sponsorId, null);
  } finally {
    h.close();
  }
});

test('the requester who stores credentials after filing can sponsor their own request', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, REQUESTER);
    viewOf(await press(h, id, 'sponsor', REQUESTER));
    assert.equal(h.repo.get(id)?.sponsorId, REQUESTER);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------------------

test('Approve is refused while nobody can pay, and the request keeps waiting', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    assert.match(refusal(await press(h, id, 'approve', APPROVER)), /Sponsor/u);
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval');
    assert.equal(h.repo.get(id)?.approvalId, null, 'no approval was minted');
  } finally {
    h.close();
  }
});

test('the sponsor cannot approve the build they are paying for', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.match(refusal(await press(h, id, 'approve', SPONSOR)), /somebody else has to approve/u);
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval');
  } finally {
    h.close();
  }
});

test('a sponsored, approved build dispatches into the SPONSOR\'s environment, and the MAC signs exactly that', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');

    await dispatchPass(h, id);
    assert.equal(h.dispatched.length, 1);
    const env = buildEnvironmentName(SPONSOR);
    assert.equal(String(h.dispatched[0]?.['environment_name'] ? renderEnv(h.dispatched[0]['environment_name']) : ''), env);
    assert.equal(h.builds.signed.at(-1)?.['environmentName'], env, 'the approval MAC binds the sponsor as payer');
    const audit = h.audit.entries.find((e) => e.action === 'builder.dispatch.environment');
    assert.equal(audit?.detail['sponsorId'], SPONSOR, 'billing attribution names the sponsor');
  } finally {
    h.close();
  }
});

test('a sponsor whose credential disappears before the dispatch: nothing is dispatched, and the reason names the sponsor', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');
    h.builds.environments.delete(buildEnvironmentName(SPONSOR));

    const out = await dispatchPass(h, id);
    assert.equal(out.kind, 'failed');
    if (out.kind === 'failed') assert.equal(out.error.code, 'conflict.sponsor_credentials_gone');
    assert.equal(h.dispatched.length, 0);
  } finally {
    h.close();
  }
});

test('a requester who clears their credential after filing: Approve redraws the card offering Sponsor', async () => {
  const h = harness();
  try {
    const out = await requestForm(h).handle(submission());
    assert.equal(out.kind, 'view');
    const id = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0]?.id;
    assert.ok(id !== undefined);
    if (id === undefined) return;
    h.builds.environments.delete(buildEnvironmentName(REQUESTER));

    const card = viewOf(await press(h, id, 'approve', APPROVER));
    assert.match(said(card), /needs a sponsor/u);
    assert.equal(h.repo.get(id)?.needsSponsor, 1);
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval', 'not approved');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------------------
// Nobody's bill grows from an earlier click
// ---------------------------------------------------------------------------------------

test('a retried SPONSORED build is never re-dispatched onto anyone: it goes back for approval and a new sponsor', async () => {
  // Even when the requester has since stored a credential: they never agreed to pay for this
  // build, and the old sponsor's click was for the build that failed.
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');
    h.repo.finish(id, 'failed', NOW);
    fund(h, REQUESTER);

    assert.equal((await commandOf(h, 'request retry').handle(invocation({ args: { id }, actorId: APPROVER }))).kind, 'view');
    const row = h.repo.get(id);
    assert.equal(row?.state, 'awaiting_approval', 'not dispatched');
    assert.equal(row?.sponsorId, null, 'the sponsor of the failed build is not reused');
    assert.equal(row?.needsSponsor, 1);
    assert.equal(h.dispatched.length, 0);
  } finally {
    h.close();
  }
});

test('a retried build the REQUESTER paid for re-dispatches on their credentials, as before', async () => {
  const h = harness();
  try {
    const out = await requestForm(h).handle(submission());
    assert.equal(out.kind, 'view');
    const id = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0]?.id;
    assert.ok(id !== undefined);
    if (id === undefined) return;
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');
    h.repo.finish(id, 'failed', NOW);
    assert.equal((await commandOf(h, 'request retry').handle(invocation({ args: { id } }))).kind, 'view');
    assert.equal(h.repo.get(id)?.state, 'dispatching');
    await dispatchPass(h, id);
    assert.equal(h.builds.signed.at(-1)?.['environmentName'], buildEnvironmentName(REQUESTER));
  } finally {
    h.close();
  }
});

test('a requester who stores a credential AFTER filing is not charged by an approval - only by their own Sponsor click', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, REQUESTER);
    assert.match(refusal(await press(h, id, 'approve', APPROVER)), /Nobody has sponsored this build/u);
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval');
    const card = viewOf(await press(h, id, 'sponsor', REQUESTER));
    assert.match(said(card), /\(the person who asked\)/u);
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff', 'now somebody has agreed to pay');
  } finally {
    h.close();
  }
});

test('a sponsor whose credential vanished is released at Approve, so somebody else can sponsor', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    h.builds.environments.delete(buildEnvironmentName(SPONSOR));

    const card = viewOf(await press(h, id, 'approve', APPROVER));
    assert.match(said(card), /needs a sponsor/u);
    assert.equal(h.repo.get(id)?.sponsorId, null);
    assert.equal(h.repo.get(id)?.state, 'awaiting_approval');
    fund(h, STRANGER);
    viewOf(await press(h, id, 'sponsor', STRANGER));
    assert.equal(h.repo.get(id)?.sponsorId, STRANGER);
  } finally {
    h.close();
  }
});

test('Sponsor and Withdraw do not reset the expiry clock: an unapproved request still expires on time', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    h.setNow(NOW + 47 * HOUR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    h.setNow(NOW + 49 * HOUR);
    await h.expire.run({}, runtime(1, NOW + 50 * HOUR));
    assert.equal(h.repo.get(id)?.state, 'expired', 'clicking does not keep a request - and its slot - alive');
  } finally {
    h.close();
  }
});

test('a REVISION of a sponsored pull request drops the old sponsor', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');
    assert.equal(h.repo.get(id)?.sponsorId, SPONSOR);
    h.repo.recordPrUrl(id, 'https://github.com/o/r/pull/7', NOW);
    h.repo.finish(id, 'pr_open', NOW);
    h.builds.pr = { number: 7, url: (await import('#modules/builder/harness.test')).url('https://github.com/o/r/pull/7'), branch: 'x', isDraft: false, isOpen: true };
    fund(h, REQUESTER);

    const out = await commandOf(h, 'request revise').handle(invocation({ args: { id, feedback: 'Rename it.' } }));
    assert.equal(out.kind, 'view');
    assert.equal(h.repo.get(id)?.sponsorId, null, 'the revision is a new build: the old sponsor does not pay for it');
  } finally {
    h.close();
  }
});

test('a dispatch pass whose row changed during its awaits does not spend', async () => {
  let move: (() => void) | null = null;
  const h = harness({}, {
    verifyGates: async () => {
      move?.();
      return { ok: true, value: undefined };
    },
  });
  try {
    const out = await requestForm(h).handle(submission());
    assert.equal(out.kind, 'view');
    const id = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0]?.id;
    assert.ok(id !== undefined);
    if (id === undefined) return;
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');
    // Cancelled while the pass is mid-flight (between its terminal check and the dispatch).
    move = () => void h.repo.finish(id, 'cancelled', NOW);
    const pass = await dispatchPass(h, id);
    assert.equal(pass.kind, 'done');
    assert.equal(h.dispatched.length, 0, 'nothing was dispatched for a row that left `dispatching`');
    assert.equal(h.builds.signed.length, 0, 'and nothing was signed');
  } finally {
    h.close();
  }
});

test('a retried sponsored build the requester cannot pay for goes back for a NEW sponsor', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    assert.equal((await press(h, id, 'approve', APPROVER)).kind, 'handoff');
    h.repo.finish(id, 'failed', NOW);

    assert.equal((await commandOf(h, 'request retry').handle(invocation({ args: { id } }))).kind, 'view');
    const row = h.repo.get(id);
    assert.equal(row?.state, 'awaiting_approval');
    assert.equal(row?.sponsorId, null);
    assert.equal(row?.needsSponsor, 1);
    assert.match(said(h.discord.posted.at(-1)?.view ?? { accent: 'ok', nodes: [] }), /somebody can pay for another one/u);
  } finally {
    h.close();
  }
});

test('an expired sponsored request loses its sponsor when it is put back', async () => {
  const h = harness();
  try {
    const id = await fileUnfunded(h);
    fund(h, SPONSOR);
    viewOf(await press(h, id, 'sponsor', SPONSOR));
    h.setNow(NOW + 49 * HOUR);
    await h.expire.run({}, runtime(1, NOW + 50 * HOUR));
    assert.equal(h.repo.get(id)?.state, 'expired');

    assert.equal((await commandOf(h, 'request retry').handle(invocation({ args: { id }, at: NOW + 49 * HOUR }))).kind, 'view');
    assert.equal(h.repo.get(id)?.sponsorId, null);
    assert.equal(h.repo.get(id)?.needsSponsor, 1);
  } finally {
    h.close();
  }
});

test('with requireOwnCredentials off, the server pays and there is nothing to sponsor', async () => {
  const h = harness({ requireOwnCredentials: false });
  try {
    h.builds.environments.delete(buildEnvironmentName(REQUESTER));
    await requestForm(h).handle(submission());
    const id = h.repo.recentForRequester(GUILD, REQUESTER, 1)[0]?.id;
    assert.ok(id !== undefined);
    if (id === undefined) return;
    assert.equal(h.repo.get(id)?.needsSponsor, 0, 'no sponsor is asked for');
    fund(h, SPONSOR);
    assert.match(refusal(await press(h, id, 'sponsor', SPONSOR)), /paid for by the server/u);
  } finally {
    h.close();
  }
});

/** Dispatch inputs are recorded as the fake received them; an ActionsToken renders via its own field. */
function renderEnv(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    for (const sym of Object.getOwnPropertySymbols(value)) {
      const v: unknown = Reflect.get(value, sym);
      if (typeof v === 'string') return v;
    }
  }
  return '';
}
