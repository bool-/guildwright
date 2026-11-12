/**
 * THE AGENT'S GATE MUST BE RUNNABLE.
 *
 * `.github/workflows/agent-implement-request.yml` composes a prompt whose step 3 tells the
 * agent to run `npm run check` - the thing AGENTS.md calls "the gate", and the only automated
 * judgement of whether the change the agent wrote is any good.
 *
 * For a long time it could not run. The job checked out the repository and went straight to the
 * agent: no `actions/setup-node`, so Node was whatever the runner image happened to ship, and
 * no dependency install, so `node_modules` did not exist. The agent holds `Bash(npm:*)`, so it
 * usually recovered - by spending turns against `--max-turns 150` and minutes against
 * `timeout-minutes: 30` working out that it had to install, nondeterministically, on the
 * operator's Actions budget. And when it did not recover, it opened a pull request whose only
 * quality gate had never executed. That is worse than a failed run, because it looks finished.
 *
 * The instruction and the toolchain are in two different files that nothing links, so this
 * reads both as TEXT and asserts they still agree. `src/modules/builder/contract.test.ts` does
 * the same thing for the dispatch inputs and for the no-`${{ }}`-in-`run:` rule; this file
 * covers the part of the workflow that belongs to the build toolchain rather than to the bot
 * contract.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const AGENT_WORKFLOW_PATH = '.github/workflows/agent-implement-request.yml';
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

const agent = readFileSync(AGENT_WORKFLOW_PATH, 'utf8');
const ci = readFileSync(CI_WORKFLOW_PATH, 'utf8');

/** Where a `- name:` step begins, or -1. Ordering assertions are all offsets in the text. */
function stepAt(yaml: string, name: string): number {
  return yaml.indexOf(`- name: ${name}`);
}

/** Every `uses:` value in a workflow, in order. */
function usesOf(yaml: string): readonly string[] {
  return [...yaml.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gmu)].map((m) => m[1] ?? '');
}

// ---------------------------------------------------------------------------------------
// The toolchain exists
// ---------------------------------------------------------------------------------------

test('the agent job installs Node and the dependencies before the agent runs', () => {
  const setup = agent.indexOf('uses: actions/setup-node@');
  const install = agent.indexOf('npm ci --ignore-scripts');
  const claude = stepAt(agent, 'Implement with Claude Code');

  assert.notEqual(setup, -1, 'the agent job must set up Node, or `npm run check` runs on whatever the image ships');
  assert.notEqual(install, -1, 'the agent job must install dependencies, or a fresh checkout has no node_modules');
  assert.notEqual(claude, -1, 'sanity: the agent step must still exist');

  assert.ok(setup < install, 'Node has to exist before npm ci can use it');
  assert.ok(install < claude, 'and the gate the prompt names must be runnable BEFORE the agent is asked to run it');
});

test('every install in the agent job is --ignore-scripts', () => {
  // A dependency's postinstall must not execute in the same job as an agent holding
  // `contents: write` and an Anthropic credential. Nothing in the dependency list needs a build
  // step, so nothing is lost by refusing them.
  //
  // `printf` lines are skipped: the composed prompt TELLS the agent not to run npm install, and
  // a rule that fires on the sentence forbidding the thing is a rule that gets suppressed.
  const installs = agent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('printf ') && !line.startsWith('#') && /\bnpm (?:ci|install)\b/u.test(line));

  assert.ok(installs.length > 0, 'the agent job must install dependencies at all');
  for (const line of installs) {
    assert.ok(line.includes('--ignore-scripts'), `"${line}" lets a dependency postinstall run`);
  }
});

test('the toolchain is set up AFTER the refusals, so an unapproved dispatch installs nothing', () => {
  // Everything above it is a refusal: the approval MAC, the credential check, the daily cap.
  // An install placed before them spends a cache download and runner time proving out a
  // dispatch nobody approved.
  const setup = agent.indexOf('uses: actions/setup-node@');
  assert.ok(setup > stepAt(agent, 'Verify the Discord approval'), 'the approval gate comes first');
  assert.ok(setup > stepAt(agent, 'Check the build credentials exist'), 'so does the credential check');
  assert.ok(setup > stepAt(agent, 'Enforce daily agent-run cap'), 'and so does the spend backstop');
});

// ---------------------------------------------------------------------------------------
// The gate the agent turns green must be the gate CI runs
// ---------------------------------------------------------------------------------------

test('the agent builds on the same Node major as ci.yml', () => {
  // If the agent's `npm run check` ran on a different runtime than the one CI uses, a green
  // result inside the run would say nothing about the pull request it produces - and the agent
  // would have been told it passed.
  const versions = (yaml: string): readonly string[] =>
    [...yaml.matchAll(/^\s*node-version:\s*"?([^"\s]+)"?\s*$/gmu)].map((m) => m[1] ?? '');

  const ciVersions = versions(ci);
  const agentVersions = versions(agent);
  assert.ok(ciVersions.length > 0, 'sanity: ci.yml must pin a node-version');
  assert.deepEqual(
    [...new Set(agentVersions)],
    [...new Set(ciVersions)],
    'the agent job and ci.yml must ask for the same Node, or the gate and the check disagree',
  );
});

test('setup-node is pinned to the same SHA in both workflows, so there is one version to bump', () => {
  const pin = (yaml: string): readonly string[] =>
    usesOf(yaml).filter((u) => u.startsWith('actions/setup-node@'));

  const agentPins = [...new Set(pin(agent))];
  const ciPins = [...new Set(pin(ci))];
  assert.equal(agentPins.length, 1, 'exactly one setup-node pin in the agent workflow');
  assert.deepEqual(agentPins, ciPins, 'and it must be the one ci.yml already carries');
});

// ---------------------------------------------------------------------------------------
// Supply chain
// ---------------------------------------------------------------------------------------

test('every action in both workflows is pinned to a full commit SHA', () => {
  // A tag is mutable. This job holds `contents: write`, `pull-requests: write` and
  // `id-token: write` and runs an agent over untrusted text; a moved tag is a supply-chain
  // change nobody reviews.
  for (const [path, yaml] of [
    [AGENT_WORKFLOW_PATH, agent],
    [CI_WORKFLOW_PATH, ci],
  ] as const) {
    const uses = usesOf(yaml);
    assert.ok(uses.length > 0, `sanity: ${path} must use some actions`);
    for (const ref of uses) {
      assert.match(
        ref,
        /^[^@\s]+@[0-9a-f]{40}$/u,
        `${path} uses "${ref}", which is not pinned to a 40-character commit SHA`,
      );
    }
  }
});

// ---------------------------------------------------------------------------------------
// The prompt and the toolchain must agree
// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// The prompt boundary is the issue's own nonce, not a tag anyone who read this file could close
// ---------------------------------------------------------------------------------------

test('the static <untrusted_user_request> tag is gone; the boundary is named by the per-issue nonce', () => {
  assert.ok(!agent.includes('<untrusted_user_request'), 'a fixed tag name can be closed by a requester who has read the workflow');
  const compose = agent.slice(stepAt(agent, 'Compose the delimited prompt file'), stepAt(agent, 'Install bubblewrap and socat'));
  assert.match(compose, /^\s+id: compose$/mu, 'the step has an id so the prompt can read its output');
  assert.match(compose, /printf '<untrusted_%s issue="%s">\\n' "\$NONCE" "\$ISSUE_NUMBER"/u, 'the opening tag is named by the nonce');
  assert.match(compose, /printf '\\n<\/untrusted_%s>\\n' "\$NONCE"/u, 'and so is the closing tag');
});

test('the nonce is read from the MAC-bound body, shape-checked, and only then written to GITHUB_OUTPUT', () => {
  const compose = agent.slice(stepAt(agent, 'Compose the delimited prompt file'), stepAt(agent, 'Install bubblewrap and socat'));
  assert.ok(compose.includes("grep -oE '<!-- build-request v1 nonce=[0-9a-f]{16}'"), 'the nonce comes from the trailing marker the bot writes');
  const check = compose.indexOf('case "$NONCE" in');
  const output = compose.indexOf('echo "nonce=$NONCE" >> "$GITHUB_OUTPUT"');
  assert.ok(check > 0 && output > check, 'the 16-hex shape check runs before the value becomes a step output');
  // The three refusals, each with the exact text the operator will read in the run log.
  assert.ok(compose.includes('carries no bot fence nonce, so it was not filed by the bot and will not be built'));
  assert.ok(compose.includes('the fence nonce appears outside its delimiters; refusing to build a tampered issue'));
  assert.ok(compose.includes('the fence nonce appears in the issue title; refusing to build a tampered issue'));
  assert.ok(output < compose.indexOf('} > .agent/request.md'), 'and every refusal happens before the prompt file is written');
});

test('the action prompt names the nonce tag through the step output, not a literal', () => {
  const claude = agent.slice(stepAt(agent, 'Implement with Claude Code'), stepAt(agent, "Show the agent's final message"));
  assert.match(claude, /<untrusted_\$\{\{ steps\.compose\.outputs\.nonce \}\}> tags in that file/u, 'the prompt must name the exact tag the file uses');
  // It lives under `with:`, where an expression is data, not shell. contract.test.ts polices run: blocks.
  const promptAt = claude.indexOf('prompt: |');
  const withAt = claude.indexOf('with:');
  assert.ok(withAt > 0 && promptAt > withAt, 'the prompt is a with: input');
});

test('the prompt still names `npm run check`, and tells the agent it need not install', () => {
  // If the prompt stopped naming the gate, the two steps above would be installing a toolchain
  // for a command nobody runs. And now that the workflow installs, the prompt has to say so, or
  // the agent spends turns re-doing it "just in case".
  const compose = agent.slice(stepAt(agent, 'Compose the delimited prompt file'));
  const body = compose.slice(0, compose.indexOf('- name: Implement with Claude Code'));
  assert.ok(body.includes('npm run check'), 'the prompt must still name the gate');
  assert.ok(
    /ALREADY INSTALLED/u.test(body),
    'and must tell the agent the toolchain is already there, or it burns turns reinstalling it',
  );
});

test('the prompt names no engine-only path, because the same bytes run in every module repository', () => {
  // This workflow is byte-identical in the engine and in every module repository made from the
  // template (the gate-file digest check refuses a build otherwise), so every path the prompt
  // names must exist in BOTH. A module repository has no `src/core/`, `src/adapters/` or
  // `src/main.ts` (the engine is in node_modules), and the worked example is at
  // `template/src/modules/tags/` in the engine but `src/modules/tags/` in a module repository.
  // The prompt defers those to AGENTS.md, which the build writes correctly for each.
  const compose = agent.slice(stepAt(agent, 'Compose the delimited prompt file'));
  const body = compose.slice(0, compose.indexOf('- name: Implement with Claude Code'));
  for (const enginePath of ['src/core/', 'src/adapters/', 'src/main.ts', 'src/modules/tags', 'template/']) {
    assert.ok(!body.includes(enginePath), `the prompt names ${enginePath}, which does not exist in a module repository`);
  }
  assert.match(body, /AGENTS\.md names the worked/u, 'the worked example is found through AGENTS.md');
  assert.match(body, /AGENTS\.md says how to compute it/u, 'and so is the permissions integer');
});
