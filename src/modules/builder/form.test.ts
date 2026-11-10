/**
 * The `/request new` form and what it files: the intro line, the "Kind of request" dropdown,
 * the optional "How will we know it worked?" field, and how each reaches the approval card,
 * the issue body and the issue labels. Plus the building card that carries the run link.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderForm } from '#adapters/discord/render';
import { parseHttpsUrl, renderSafeMarkdown, type HttpsUrl } from '#core/text';
import type { View } from '#core/view';
import { buildingCard } from '#modules/builder/cards';
import { REQUEST_KINDS } from '#modules/builder/kinds';
import {
  ISSUE_URL,
  REQUESTER,
  RUN_URL,
  commandOf,
  fieldNames,
  harness,
  invocation,
  lastPost,
  links,
  requestForm,
  submission,
  textOf,
} from '#modules/builder/harness.test';

function url(raw: string): HttpsUrl {
  const u = parseHttpsUrl(raw);
  assert.ok(u.ok);
  if (!u.ok) throw new Error('unreachable');
  return u.value;
}

test('/request new opens a form that says what happens next and fits Discord exactly', async () => {
  const h = harness();
  try {
    const outcome = await commandOf(h, 'request new').handle(invocation());
    assert.equal(outcome.kind, 'form');
    if (outcome.kind !== 'form') return;
    const form = outcome.form;

    assert.match(form.intro ?? '', /approver reviews this before anything is built/u, 'the requester learns a human gates it');
    assert.match(form.intro ?? '', /nothing is charged/u, 'and that submitting costs nothing');
    assert.deepEqual(form.fields.map((f) => f.name), ['title', 'kind', 'detail', 'success']);

    const kind = form.fields.find((f) => f.name === 'kind');
    assert.ok(kind?.kind === 'select', 'the kind is a dropdown, not free text');
    assert.deepEqual(kind.options.map((o) => o.value), [...REQUEST_KINDS]);

    const success = form.fields.find((f) => f.name === 'success');
    assert.ok(success?.kind === 'text');
    assert.equal(success.required, false, 'success criteria are optional');
    assert.equal(success.label, 'How will we know it worked?');

    // The real renderer is the judge of "fits": intro + 4 fields is the whole 5-slot budget.
    const rendered = renderForm(form);
    assert.ok(rendered.ok, rendered.ok ? '' : (rendered.error.internal ?? 'renderForm refused the form'));
    assert.equal(rendered.value.components.length, 5);
  } finally {
    h.close();
  }
});

test('the kind and success criteria reach the issue body, the issue label and the approval card', async () => {
  const h = harness();
  try {
    const out = await requestForm(h).handle(
      submission({
        title: 'Show who joined this week',
        kind: 'new-command',
        detail: 'Mods need a list of recent joins.',
        success: 'Running /joined lists the last 7 days of joins, newest first.',
      }),
    );
    assert.equal(out.kind, 'view', 'the submission is accepted');

    const filed = h.issues.created[0];
    assert.ok(filed !== undefined, 'an issue was filed');
    assert.deepEqual([...filed.labels], ['bot:request', 'kind:new-command'], 'the kind is a label, so the issue list can be sorted');
    assert.match(filed.body, /### How we will know it worked\n===BEGIN USER_TEXT [0-9a-f]{16}===\nRunning \/joined lists/u, 'fenced like the idea');

    const card = lastPost(h);
    assert.ok(fieldNames(card).includes('Kind'));
    assert.match(textOf(card), /New command or feature/u, 'the approver sees the kind in words');
    assert.match(textOf(card), /last 7 days of joins/u, 'and what the build will be checked against');
  } finally {
    h.close();
  }
});

test('a blank success field files no empty section, and the card does not show one', async () => {
  const h = harness();
  try {
    const out = await requestForm(h).handle(submission({ title: 'Add a /ping command', kind: 'fix', detail: 'It should reply pong.', success: '   ' }));
    assert.equal(out.kind, 'view');
    const filed = h.issues.created[0];
    assert.ok(filed !== undefined);
    assert.doesNotMatch(filed.body, /How we will know it worked/u);
    assert.ok(!fieldNames(lastPost(h)).includes('How we will know it worked'));
  } finally {
    h.close();
  }
});

test('a forged kind is refused and nothing is filed', async () => {
  // The client echoes the dropdown value back, so a crafted submission can say anything.
  const h = harness();
  try {
    const out = await requestForm(h).handle(submission({ title: 'Add a /ping command', kind: 'drop-tables', detail: 'x' }));
    assert.equal(out.kind, 'fail');
    assert.equal(h.issues.created.length, 0, 'no issue for a request that failed validation');
  } finally {
    h.close();
  }
});

test('the building card keeps the title, names the approver and links the run once it exists', () => {
  const view: View = buildingCard({
    issueNumber: 21,
    issueUrl: url(ISSUE_URL),
    runUrl: url(RUN_URL),
    title: 'Show uptime in /ping',
    approverId: REQUESTER,
  });
  assert.match(textOf(view), /Show uptime in \/ping/u, 'what is being built stays on the card');
  assert.match(textOf(view), new RegExp(`Approved by <@${REQUESTER}>`, 'u'), 'who approved it, as a name');
  assert.deepEqual(links(view), [
    { label: 'Run log', url: RUN_URL },
    { label: 'Issue', url: ISSUE_URL },
  ]);
  const issueField = view.nodes.find((n) => n.kind === 'field' && n.name === 'Issue');
  assert.ok(issueField?.kind === 'field');
  assert.equal(renderSafeMarkdown(issueField.md), `[#21](${ISSUE_URL})`, 'the issue number itself is clickable');

  const before = buildingCard({ issueNumber: 21, issueUrl: null, runUrl: null, title: null, approverId: null });
  assert.deepEqual(links(before), [], 'no run yet, no link to it');
  assert.match(textOf(before), /^.*Approved\. This usually/mu, 'and no "by" when nobody was recorded');
});
