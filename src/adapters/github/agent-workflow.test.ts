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
  const read = agent.slice(stepAt(agent, 'Read the approved request'), stepAt(agent, 'Create the working branch'));
  assert.match(read, /^\s+id: request$/mu, 'the step has an id so later steps can read its outputs');
  // The copy the approval gate fetched and the MAC verified, never a re-fetch.
  assert.ok(read.includes('ISSUE_JSON_PATH: ${{ runner.temp }}/issue.json'), 'it reads the verified copy of the issue');
  assert.ok(!read.includes('gh issue view'), 'and never re-fetches it');
  assert.ok(read.includes("grep -oE '<!-- build-request v1 nonce=[0-9a-f]{16}'"), 'the nonce comes from the trailing marker the bot writes');
  const check = read.indexOf('case "$NONCE" in');
  const output = read.indexOf('echo "nonce=$NONCE"');
  assert.ok(check > 0 && output > check, 'the 16-hex shape check runs before the value becomes a step output');
  // The three refusals, each with the exact text the operator will read in the run log.
  assert.ok(read.includes('carries no bot fence nonce, so it was not filed by the bot and will not be built'));
  assert.ok(read.includes('the fence nonce appears outside its delimiters; refusing to build a tampered issue'));
  assert.ok(read.includes('the fence nonce appears in the issue title; refusing to build a tampered issue'));
  assert.ok(output > read.indexOf('the fence nonce appears in the issue title'), 'every refusal happens before anything is written out');
  assert.ok(stepAt(agent, 'Read the approved request') < stepAt(agent, 'Compose the delimited prompt file'), 'and before the prompt file is composed');
});

test('a revision is told apart by the MAC-bound marker, and the stray check allows exactly that one extra line shape', () => {
  const read = agent.slice(stepAt(agent, 'Read the approved request'), stepAt(agent, 'Create the working branch'));
  // The fourth sanctioned line is anchored at both ends and its revision number is digits only,
  // so a forged boundary cannot hide inside it.
  assert.ok(read.includes('|^[0-9]+:<!-- build-revision v1 nonce=$NONCE revision=[0-9]{1,3} -->$'), 'the revision marker is the one added line shape');
  assert.ok(read.includes('s/^<!-- build-revision v1 nonce=$NONCE revision=([0-9]{1,3}) -->$/\\1/p'), 'the mode is read from that same anchored line');
  assert.ok(read.includes('sort -n | tail -n1'), 'the highest revision is the one to implement');
  assert.ok(read.includes('if [ -n "$REVISION" ]; then MODE=revise; else MODE=new; REVISION=0; fi'));
  // The mode is NOT a dispatch input: nothing a dispatcher chooses can turn a build into a push.
  const inputs = agent.slice(agent.indexOf('workflow_dispatch:'), agent.indexOf('permissions: {}'));
  assert.ok(!/^\s+mode:/mu.test(inputs), 'mode is never a workflow input');
});

test('a revision checks out the existing branch, only while its pull request is open, and the report says whether it pushed', () => {
  const branch = agent.slice(stepAt(agent, 'Create the working branch'), stepAt(agent, 'Stage the verified issue content'));
  assert.ok(branch.includes('MODE: ${{ steps.request.outputs.mode }}'));
  assert.ok(branch.includes('gh pr list --repo "$REPO" --head "$BRANCH" --state open'), 'it refuses a branch whose pull request is closed');
  assert.ok(branch.includes('git checkout -b "$BRANCH" "origin/$BRANCH"'), 'it builds on the open pull request');
  assert.ok(!branch.includes('--force') && !branch.includes('reset --hard'), 'and never rewrites it');
  const gate = agent.slice(stepAt(agent, 'Reject forbidden path changes'), stepAt(agent, 'Resolve the PR URL'));
  assert.ok(gate.indexOf('head_after=') < gate.indexOf('agent modified a forbidden path'), 'the head is recorded before a refusal can end the step');
  const report = agent.slice(stepAt(agent, 'Post the run report'));
  assert.ok(report.includes('HEAD_BEFORE: ${{ steps.branch.outputs.head_before }}'));
  assert.ok(report.includes('HEAD_AFTER: ${{ steps.gate.outputs.head_after }}'));
  assert.ok(report.includes('pushed: $pushed'), 'the machine-readable report carries the fact');
  // `pushed` needs BOTH heads: a run that died before the branch step recorded none.
  assert.ok(report.includes('if [ -n "${HEAD_BEFORE:-}" ] && [ -n "${HEAD_AFTER:-}" ]'));
  assert.ok(branch.includes('echo "head_before=$(git rev-parse HEAD)"'), 'recorded in both modes');
});

test('the agent never loads configuration from the unreviewed branch it is started inside', () => {
  const branch = agent.slice(stepAt(agent, 'Create the working branch'), stepAt(agent, 'Stage the verified issue content'));
  const snapshot = branch.indexOf('cp .github/claude/agent-settings.json "$RUNNER_TEMP/agent-settings.json"');
  assert.ok(snapshot > 0 && snapshot < branch.indexOf('git checkout -b "$BRANCH" "origin/$BRANCH"'), 'the base copy is taken before the switch');
  const claude = agent.slice(stepAt(agent, 'Implement with Claude Code'), stepAt(agent, "Show the agent's final message"));
  assert.match(claude, /^\s+settings: \$\{\{ runner\.temp \}\}\/agent-settings\.json$/mu, 'and the action loads that copy');
  // A branch carrying what Claude Code loads as its own config is refused before the agent starts...
  const precheck = branch.indexOf('carries agent configuration or a forbidden path');
  assert.ok(precheck > 0 && precheck < branch.indexOf('git checkout -b "$BRANCH" "origin/$BRANCH"'));
  for (const path of ['(^|/)\\.claude/', '(^|/)\\.mcp\\.json$', '(^|/)CLAUDE\\.md$']) {
    assert.ok(branch.includes(path), `the pre-check refuses ${path}`);
    // ...and a run that commits one is blocked, so it cannot configure the next run.
    const gate = agent.slice(stepAt(agent, 'Reject forbidden path changes'), stepAt(agent, 'Resolve the PR URL'));
    assert.ok(gate.includes(path), `the post-hoc gate forbids ${path}`);
  }
  assert.ok(branch.includes('select(.isCrossRepository == false)'), "a fork's PR with the same head name is not ours");
});

test('the action prompt names the nonce tag through the step output, not a literal', () => {
  const claude = agent.slice(stepAt(agent, 'Implement with Claude Code'), stepAt(agent, "Show the agent's final message"));
  assert.match(claude, /<untrusted_\$\{\{ steps\.request\.outputs\.nonce \}\}> tags in that file/u, 'the prompt must name the exact tag the file uses');
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
