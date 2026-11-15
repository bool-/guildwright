/**
 * Live progress on the "Building" card: the step labels, the redraw rule, and the poller using
 * them without ever letting a cosmetic read touch the build.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Err, Ok } from '#core/result';
import { errors } from '#core/errors';
import type { RunProgress } from '#core/ports';
import { isAgentStep, mayHavePr, progressKey, stepLabel } from '#modules/builder/progress';
import {
  PR_URL,
  RUN_URL,
  harness,
  links,
  okStatus,
  payloadFor,
  prRef,
  runtime,
  seedRunning,
  textOf,
} from '#modules/builder/harness.test';

const WORKFLOW = readFileSync('.github/workflows/agent-implement-request.yml', 'utf8');
/** Every `- name:` of a step in the build job, in order. */
const STEP_NAMES = [...WORKFLOW.matchAll(/^ {6}- name: (.+)$/gmu)].map((m) => (m[1] ?? '').trim());

function at(stepNumber: number, stepName: string, totalSteps = 24): RunProgress {
  return { stepNumber, totalSteps, stepName, stepStartedAtMs: 1_700_000_000_000 };
}

test('every step of the real workflow has a human label - a renamed step fails here, not on a card', () => {
  assert.ok(STEP_NAMES.length >= 15, `fixture: the workflow's steps were found (${String(STEP_NAMES.length)})`);
  for (const name of STEP_NAMES) {
    assert.notEqual(stepLabel(name), 'Working', `step "${name}" has no label in progress.ts`);
  }
  // And the ones GitHub adds around every job.
  for (const name of ['Set up job', 'Post Checkout base branch', 'Complete job']) assert.notEqual(stepLabel(name), 'Working', name);
  assert.equal(stepLabel('Something new'), 'Working', 'an unknown step is shown, never echoed');
});

test('the agent step is recognised, and the PR is looked for only from it on', () => {
  assert.ok(isAgentStep('Implement with Claude Code'));
  assert.ok(!mayHavePr('Enforce daily agent-run cap'), 'no PR lookups before the agent has run');
  assert.ok(!mayHavePr('Install dependencies so npm run check can actually run'));
  assert.ok(mayHavePr('Implement with Claude Code'));
  assert.ok(mayHavePr('Post the run report'));
});

test('the redraw key changes with the step and with a found PR, and nothing else', () => {
  const a = progressKey(at(3, 'Verify the Discord approval'), null);
  assert.equal(progressKey({ ...at(3, 'Verify the Discord approval'), stepStartedAtMs: 9 }, null), a, 'elapsed time never redraws');
  assert.notEqual(progressKey(at(4, 'Consume the approval'), null), a);
  assert.notEqual(progressKey(at(3, 'Verify the Discord approval'), PR_URL), a);
});

// ---------------------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------------------

test('a running build draws its step on the card, once per step, with a live Discord timestamp', async () => {
  const h = harness({}, { runStatus: () => okStatus('in-progress', RUN_URL) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    h.builds.progress = Ok(at(5, 'Enforce daily agent-run cap'));
    const first = await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(first.kind, 'retry');
    const card = h.discord.drawn.at(-1);
    assert.ok(card !== undefined);
    if (card === undefined) return;
    assert.match(textOf(card), /Step 5 of 24: Checking today's build cap \(started <t:1700000000:R>\)/u);

    const edits = h.discord.drawn.length;
    await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(h.discord.drawn.length, edits, 'the same step twice draws nothing');

    h.builds.progress = Ok(at(14, 'Implement with Claude Code'));
    await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(h.discord.drawn.length, edits + 1, 'a new step draws once');
    assert.match(textOf(h.discord.drawn.at(-1) ?? { accent: 'ok', nodes: [] }), /Agent is writing code/u);
  } finally {
    h.close();
  }
});

test('the pull request is linked on the card the moment the agent opens it, before the run ends', async () => {
  const h = harness({}, { runStatus: () => okStatus('in-progress', RUN_URL), findPrForBranch: async () => Ok(prRef(false)) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    h.builds.progress = Ok(at(14, 'Implement with Claude Code'));
    await h.build.run(payloadFor(id, 42), runtime());
    const card = h.discord.drawn.at(-1);
    assert.ok(card !== undefined);
    if (card === undefined) return;
    assert.ok(links(card).some((l) => l.label === 'Pull request' && l.url === PR_URL));
    assert.equal(h.repo.get(id)?.state, 'running', 'seeing the PR early does not end the build');
  } finally {
    h.close();
  }
});

test('no PR lookup happens before the agent step, so early steps cost one read each', async () => {
  let lookups = 0;
  const h = harness({}, {
    runStatus: () => okStatus('in-progress', RUN_URL),
    findPrForBranch: async () => {
      lookups += 1;
      return Ok(null);
    },
  });
  try {
    const id = seedRunning(h.repo, 42, 77);
    h.builds.progress = Ok(at(3, 'Verify the Discord approval'));
    await h.build.run(payloadFor(id, 42), runtime());
    assert.equal(lookups, 0);
  } finally {
    h.close();
  }
});

test('a failed progress read changes nothing about the build: no edit, still polling', async () => {
  const h = harness({}, { runStatus: () => okStatus('in-progress', RUN_URL) });
  try {
    const id = seedRunning(h.repo, 42, 77);
    h.builds.progress = Err(errors.upstream('github', 502, 'Try again.', 'jobs: bad gateway'));
    const before = h.discord.drawn.length;
    const outcome = await h.build.run(payloadFor(id, 42), runtime());
    assert.deepEqual(outcome, { kind: 'retry', afterMs: 15_000, why: 'still building' });
    assert.equal(h.discord.drawn.length, before);
    assert.equal(h.repo.get(id)?.state, 'running');
  } finally {
    h.close();
  }
});

test('the progress line is plain text plus a timestamp: a hostile step name cannot inject markup', () => {
  // A step name is from a gate-verified file, but it is still a string off the network; the card
  // only ever shows a LABEL from the table, and an unknown name becomes "Working".
  assert.equal(stepLabel('<@&123> [click](https://evil.example) `x`'), 'Working');
});
