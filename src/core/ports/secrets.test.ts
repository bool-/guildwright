/**
 * The two types that make "bring your own credentials" safe to hand to an AI-written module.
 *
 * Neither of these is about encryption. They are about the two ways this feature can pay the
 * wrong person or reject a valid key:
 *
 *  1. `EnvironmentName` decides WHOSE credentials a workflow run spends. A free-form string
 *     there is an authorization hole, not a formatting preference, so the constructor is
 *     tested against the shapes an attacker or a bug would actually produce.
 *  2. `classifyCredential` decides WHICH secret name a credential is written under. Both
 *     credentials start `sk-ant-`, and the obvious implementation silently files every OAuth
 *     token as an API key - a 401 half an hour into somebody else's build. That regression has
 *     its own named test below, because it was written once already.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { secret } from '#core/secret';
import {
  AI_AGENT_ENVIRONMENT,
  SECRET_NAMES,
  agentEnvironment,
  classifyCredential,
  isUserEnvironment,
  toEnvironmentName,
  toSecretName,
  userEnvironmentName,
  type SecretsPort,
} from '#core/ports/secrets';

// ---------------------------------------------------------------------------------------
// EnvironmentName
// ---------------------------------------------------------------------------------------

test('toEnvironmentName admits exactly two shapes', () => {
  const agent = toEnvironmentName('ai-agent');
  assert.equal(agent.ok, true);
  assert.equal(agent.ok && agent.value, 'ai-agent');

  const user = toEnvironmentName('user-123456789012345678');
  assert.equal(user.ok, true);
  assert.equal(user.ok && user.value, 'user-123456789012345678');
});

test('toEnvironmentName rejects everything a bug or an attacker would produce', () => {
  const rejected = [
    '',
    ' ',
    'ai-agent ',
    ' ai-agent',
    // JS `$` is end-of-input, not end-of-line - this asserts that rather than assuming it.
    'ai-agent\n',
    'AI-AGENT',
    'ai-agent2',
    'user-',
    'user-abc',
    // 16 digits: below the snowflake floor.
    'user-1234567890123456',
    // 21 digits: above the ceiling.
    'user-123456789012345678901',
    'user-12345678901234567 8',
    // The one that matters most: a traversal that would select the OPERATOR's environment.
    '../ai-agent',
    'user-123456789012345678/../ai-agent',
    'production',
    'user-123456789012345678\nai-agent',
  ];
  for (const bad of rejected) {
    assert.equal(toEnvironmentName(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('a rejected environment name never echoes the value it rejected', () => {
  // `errors.validation` takes the OPTION NAME, never the value: a user who pastes a credential
  // into the wrong box must not have it read back to them in an error.
  const r = toEnvironmentName('sk-ant-api03-secretlookingthing');
  assert.equal(r.ok, false);
  if (r.ok) return;
  const serialised = JSON.stringify(r.error);
  assert.ok(!serialised.includes('sk-ant'), 'the rejected value must not appear in the error');
});

test('userEnvironmentName validates the Discord id rather than trusting it', () => {
  const ok = userEnvironmentName('123456789012345678');
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value, 'user-123456789012345678');

  for (const bad of ['', 'abc', '123', '../ai-agent', '12345678901234567890123', '123456789012345678 ']) {
    assert.equal(userEnvironmentName(bad).ok, false, `user id ${JSON.stringify(bad)} must be rejected`);
  }
});

test('agentEnvironment mints the operator environment without a cast', () => {
  assert.equal(agentEnvironment(), AI_AGENT_ENVIRONMENT);
  assert.equal(isUserEnvironment(agentEnvironment()), false);
});

test('isUserEnvironment separates a user environment from the operator one', () => {
  const user = userEnvironmentName('123456789012345678');
  assert.equal(user.ok, true);
  // A cleanup job that deleted `ai-agent` would take the bot's own funding and the approval
  // signing key with it, so this predicate is load-bearing rather than cosmetic.
  assert.equal(user.ok && isUserEnvironment(user.value), true);
});

// ---------------------------------------------------------------------------------------
// SecretName
// ---------------------------------------------------------------------------------------

test('toSecretName admits only the two names the workflow reads', () => {
  assert.equal(toSecretName('ANTHROPIC_API_KEY').ok, true);
  assert.equal(toSecretName('CLAUDE_CODE_OAUTH_TOKEN').ok, true);

  for (const bad of ['', 'GITHUB_TOKEN', 'anthropic_api_key', 'ANTHROPIC_API_KEY ', 'APPROVAL_HMAC_KEY']) {
    assert.equal(toSecretName(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.deepEqual([...SECRET_NAMES], ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
});

// ---------------------------------------------------------------------------------------
// classifyCredential
// ---------------------------------------------------------------------------------------

/**
 * WHY EVERY CASE BELOW WRAPS THE VALUE.
 *
 * `classifyCredential` takes a `Secret`, not a `string`. That is what lets its one real caller -
 * the credentials module - classify without unwrapping, which is what keeps `.reveal(` out of
 * `src/modules/**` entirely (`src/conventions.test.ts` asserts the count is zero). Passing a
 * bare string here is TS2345, which is exactly the wall a module would hit.
 *
 * The helper takes a `string` so the cases below still read as the credential shapes they are
 * about, rather than as a column of constructor calls.
 */
function classify(raw: string): ReturnType<typeof classifyCredential> {
  return classifyCredential(secret(raw));
}

test('classifyCredential tells an OAuth token from an API key', () => {
  assert.equal(classify('sk-ant-api03-abc123'), 'ANTHROPIC_API_KEY');
  assert.equal(classify('sk-ant-oat01-abc123'), 'CLAUDE_CODE_OAUTH_TOKEN');
  // A paste out of a terminal into a modal.
  assert.equal(classify('  sk-ant-api03-abc  \n'), 'ANTHROPIC_API_KEY');
});

test('THE REGRESSION: an OAuth token is never filed as an API key', () => {
  // The first draft of this function tested `startsWith('sk-ant-')` first. Every OAuth token
  // was then classified as an API key, written into ANTHROPIC_API_KEY, and produced an opaque
  // 401 thirty minutes into a build - the exact failure the feature exists to remove.
  assert.notEqual(classify('sk-ant-oat01-abc123'), 'ANTHROPIC_API_KEY');
  assert.notEqual(classify('sk-ant-api03-abc123'), 'CLAUDE_CODE_OAUTH_TOKEN');
});

test('classifyCredential survives a key-generation bump', () => {
  // Anthropic has already shipped api01 and api02, so pinning `03` would start rejecting valid
  // credentials on the next rotation - a failure that reads to the user as "my key is bad".
  assert.equal(classify('sk-ant-api04-abc'), 'ANTHROPIC_API_KEY');
  assert.equal(classify('sk-ant-api1-abc'), 'ANTHROPIC_API_KEY');
  assert.equal(classify('sk-ant-oat02-abc'), 'CLAUDE_CODE_OAUTH_TOKEN');
  // Length is deliberately not checked: it is not stable across generations.
  assert.equal(classify(`sk-ant-api03-${'x'.repeat(300)}`), 'ANTHROPIC_API_KEY');
});

test('classifyCredential refuses rather than guesses', () => {
  for (const bad of [
    '',
    'sk-ant-',
    'sk-ant-api-abc',
    'sk-ant-oat-abc',
    'xsk-ant-api03-abc',
    ' \n',
    'sk-proj-openai',
    'ghp_notevenclose',
    'Bearer sk-ant-api03-abc',
  ]) {
    assert.equal(classify(bad), null, `${JSON.stringify(bad)} must not be classified`);
  }
});

test('an Admin API key is refused, not routed', () => {
  // `sk-ant-admin...` administers an Anthropic ORGANISATION. Accepting one would hand an
  // org-administration key to a build container that runs model-authored code.
  assert.equal(classify('sk-ant-admin01-abc'), null);
  assert.equal(classify('sk-ant-admin-abc'), null);
});

// ---------------------------------------------------------------------------------------
// The shape of the port itself
// ---------------------------------------------------------------------------------------

/**
 * A COMPILE-TIME assertion that the port stays write-only.
 *
 * Adding a `get`, a `read`, or anything else that could return a credential makes `Exclude<...>`
 * non-empty, the annotation resolve to `never`, and this line stop compiling - which is a
 * conversation in review rather than a security property that quietly evaporates.
 */
const WRITE_ONLY_METHODS = ['ensureEnvironment', 'put', 'list', 'remove', 'deleteEnvironment'] as const;
const PORT_HAS_NO_READ_PATH: Exclude<keyof SecretsPort, (typeof WRITE_ONLY_METHODS)[number]> extends never
  ? true
  : never = true;

test('SecretsPort exposes no way to read a credential back', () => {
  assert.equal(PORT_HAS_NO_READ_PATH, true);
  assert.equal(WRITE_ONLY_METHODS.length, 5);
});
