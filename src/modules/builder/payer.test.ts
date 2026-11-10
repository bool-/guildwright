/**
 * WHO PAYS FOR THE BUILD.
 *
 * `resolveBuildPayer` is the only decision in the bot that moves money between people, and
 * every one of its wrong answers is silent:
 *
 *   - picking the shared environment when the user has their own credential bills the OPERATOR
 *     for a build the user offered to pay for, and the run succeeds, so nobody finds out;
 *   - picking the user's environment when it is empty produces an auth error thirty minutes
 *     into the run, inside the agent step, reported to the user as "Build failed";
 *   - picking anything at all when nothing can pay does the same to the operator, on a fresh
 *     install where `ai-agent` holds only APPROVAL_HMAC_KEY.
 *
 * None of those fail a typecheck and none of them fail a dispatch, so they are asserted here.
 *
 * THE THIRD ARGUMENT IS THE `requireOwnCredentials` SWITCH, and it splits this file in two.
 * The first half passes `false` and pins TODAY'S behaviour - an operator who wants to fund a
 * private server must keep getting exactly it. The second half passes `true`, the shipped
 * default, in which the shared environment is unreachable from a user request at all.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CREDENTIALS_NEXT_STEP, resolveBuildPayer } from '#modules/builder/module';
import { SHARED_BUILD_ENVIRONMENT, buildEnvironmentName } from '#core/text';
import { Err, Ok, type Result } from '#core/result';
import { errors, userMessage, type AppError } from '#core/errors';
import type { BuildCredentialName, EnvironmentCredentials } from '#core/ports';
import { fakeBuilds } from '#testing/fakes';

const REQUESTER = '111111111111111111';
const OTHER = '222222222222222222';

/** A builds port that answers only about credentials, recording what it was asked. */
function credentials(seed: Readonly<Record<string, readonly BuildCredentialName[]>>) {
  const asked: string[] = [];
  const builds = {
    async environmentCredentials(environmentName: string): Promise<Result<EnvironmentCredentials, AppError>> {
      asked.push(environmentName);
      const found = seed[environmentName];
      return Ok({ environmentName, exists: found !== undefined, credentials: found ?? [] });
    },
  };
  return { builds, asked };
}

// ---------------------------------------------------------------------------------------
// requireOwnCredentials: FALSE - the operator funds strangers, which is what shipped first
// ---------------------------------------------------------------------------------------

test('a user with their own credential pays for their own build', async () => {
  const { builds, asked } = credentials({
    [buildEnvironmentName(REQUESTER)]: ['ANTHROPIC_API_KEY'],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });

  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, REQUESTER, 'the requester funds it');
  assert.equal(buildEnvironmentName(r.value), 'user-111111111111111111');
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER)], 'and the shared environment is not even read');
});

test('a subscription token counts exactly as much as an API key', async () => {
  // The bot must never care WHICH of the two a user brought; the workflow passes both and lets
  // whichever exists resolve. A check that only recognised ANTHROPIC_API_KEY would move every
  // Pro/Max subscriber back onto the operator's bill without a word.
  const { builds } = credentials({
    [buildEnvironmentName(REQUESTER)]: ['CLAUDE_CODE_OAUTH_TOKEN'],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });
  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, REQUESTER);
});

test('a user who never configured anything falls back to the shared environment', async () => {
  const { builds, asked } = credentials({ [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'] });

  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, null, 'null means the operator pays');
  assert.equal(buildEnvironmentName(r.value), SHARED_BUILD_ENVIRONMENT);
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER), SHARED_BUILD_ENVIRONMENT], 'their own first, then the shared one');
});

test('an EMPTY user environment fails the build instead of silently billing the operator', async () => {
  // The case worth arguing about, decided deliberately. The environment exists, so this person
  // did opt in to funding their own builds; their credential has since been revoked, rotated or
  // deleted. Falling back would charge the operator for a build the user offered to pay for and
  // would never surface anywhere.
  const { builds } = credentials({
    [buildEnvironmentName(REQUESTER)]: [],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });

  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.retryable, false, 'retrying cannot conjure a credential');
  assert.match(r.error.userDetail, /credential/iu, 'and the user must be told what is actually wrong');
  assert.ok(r.error.nextStep.length > 0, 'every AppError carries a next step');
});

test('an environment holding only APPROVAL_HMAC_KEY cannot pay for anything', async () => {
  // Exactly the fresh-install state described in docs/SETUP.md step 4b: `ai-agent` exists and
  // holds the MAC key, and no build can authenticate. Reporting that as fundable is the one
  // answer that makes the whole pre-flight pointless, so it is pinned here as well as in the
  // adapter's own filter test.
  const { builds } = credentials({ [SHARED_BUILD_ENVIRONMENT]: [] });

  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, 'config', 'nothing anywhere can pay: that is an operator problem');
  assert.match(r.error.nextStep, /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/u, 'and the fix must name the secret');
});

test('a GitHub failure is reported as retryable, never as "no credentials"', async () => {
  // A 500 treated as "this user has nothing" would quietly move their build onto the shared
  // bill; treated as terminal it would burn an approved request over a blip.
  const builds = {
    async environmentCredentials(): Promise<Result<EnvironmentCredentials, AppError>> {
      return Err(errors.upstream('github', 500, 'Try again in a minute.'));
    },
  };

  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.retryable, true, 'the job must retry rather than decide who pays from a blip');
});

// ---------------------------------------------------------------------------------------
// A MISSING **Environments** PERMISSION MUST NOT BREAK EVERY BUILD
// ---------------------------------------------------------------------------------------
//
// `environmentCredentials` reads an ENVIRONMENT endpoint, which a fine-grained token reaches only
// with the permission named "Environments" — a permission that did not appear in docs/SETUP.md
// until this change, so any existing install upgrading into this feature has it MISSING. Every
// read then answers 403.
//
// The shipped behaviour was to return that error, which failed the build. And because the
// requester's OWN environment is read first and returned on error, it failed the build for
// everyone — including the majority who never brought a credential and whose build should simply
// have run on `ai-agent`, exactly as it did before this feature existed. Adding an optional
// feature took the product out.
//
// `errors.upstream` marks exactly 401/403 non-retryable, which is precisely the signal for
// "asking again will never work", so that is the signal used to degrade.
//
// THIS DEGRADATION BELONGS TO `requireOwnCredentials: false` ONLY. With the gate on, degrading
// means "the operator pays", which is the one outcome the gate exists to forbid — see the second
// half of this file.

/** Refuses every environment, the way a token without the permission does. */
function refuses(error: AppError) {
  const asked: string[] = [];
  const builds = {
    async environmentCredentials(environmentName: string): Promise<Result<EnvironmentCredentials, AppError>> {
      asked.push(environmentName);
      return Err(error);
    },
  };
  return { builds, asked };
}

test('a token without the Environments permission still builds: the operator pays', async () => {
  const { builds, asked } = refuses(
    errors.upstream('github', 403, 'Ask an admin to add Environments access to GITHUB_TOKEN.'),
  );

  const r = await resolveBuildPayer(builds, REQUESTER, false);

  assert.equal(r.ok, true, 'a missing OPTIONAL permission must cost the optional feature, not every build');
  if (!r.ok) return;
  assert.equal(r.value, null, 'the operator pays — which is where a user who brought nothing belonged anyway');
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER), SHARED_BUILD_ENVIRONMENT], 'both reads are still attempted');
});

test('a 401 degrades the same way, and a 500 still does not', async () => {
  // The line is RETRYABILITY, not the status number: "asking again cannot help" degrades, and
  // "asking again might" must retry rather than move who pays on the strength of a blip.
  const unauthorised = await resolveBuildPayer(refuses(errors.upstream('github', 401, 'Renew GITHUB_TOKEN.')).builds, REQUESTER, false);
  assert.equal(unauthorised.ok, true);
  assert.equal(unauthorised.ok && unauthorised.value, null);

  const blip = await resolveBuildPayer(refuses(errors.upstream('github', 500, 'Try again in a minute.')).builds, REQUESTER, false);
  assert.equal(blip.ok, false, 'a 500 must still retry');
});

test('degrading is not a way to dodge paying: a readable credential still charges its owner', async () => {
  // If the bot CAN read the user's environment, the answer it gets is the answer. This fails if
  // the permission branch ever starts swallowing a successful read.
  const { builds } = credentials({
    [buildEnvironmentName(REQUESTER)]: ['CLAUDE_CODE_OAUTH_TOKEN'],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });
  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok && r.value, REQUESTER);
});

test('an EMPTY user environment still fails even though a refused read degrades', async () => {
  // The two must not be confused. "I cannot read it" degrades to the operator; "I read it and it
  // is empty" is the user's own revoked key and stays a hard failure, or the operator silently
  // picks up a bill for a build somebody else offered to pay for.
  const { builds } = credentials({
    [buildEnvironmentName(REQUESTER)]: [],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });
  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, false);
});

test('a corrupt requester id takes the shared path rather than crashing the job', async () => {
  // `buildEnvironmentName` THROWS on a non-snowflake, by design. A row written by an older
  // deploy must not turn that into an unhandled rejection inside a durable job.
  const { builds, asked } = credentials({ [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'] });

  const r = await resolveBuildPayer(builds, 'not-a-snowflake', false);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, null);
  assert.deepEqual(asked, [SHARED_BUILD_ENVIRONMENT], 'and it never asks about an impossible environment');
});

test('one user is never charged for another user’s build', async () => {
  // The selection is keyed on the REQUESTER, and nothing else in the payload can move it.
  const { builds } = credentials({
    [buildEnvironmentName(OTHER)]: ['ANTHROPIC_API_KEY'],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });

  const r = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value, null, 'the requester has nothing, so the operator pays - not the other user');
});

test('the shipped fake models the ordinary install, so a broken selection cannot pass by luck', async () => {
  // `fakeBuilds()` seeds ONLY the shared environment. A fake that gave every environment a
  // credential would make "the user pays" and "the operator pays" indistinguishable in tests.
  const builds = fakeBuilds();
  const before = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(before.ok, true);
  if (before.ok) assert.equal(before.value, null, 'nobody has brought credentials yet');

  builds.environments.set(buildEnvironmentName(REQUESTER), ['CLAUDE_CODE_OAUTH_TOKEN']);
  const after = await resolveBuildPayer(builds, REQUESTER, false);
  assert.equal(after.ok, true);
  if (after.ok) assert.equal(after.value, REQUESTER, 'and seeding one flips the answer');
});

// ---------------------------------------------------------------------------------------
// requireOwnCredentials: TRUE - NO FREE BUILDS, and this is the shipped default
// ---------------------------------------------------------------------------------------
//
// The front door already refused anyone without a credential when they submitted `/request`.
// This is the SECOND check, minutes to days later, and it is not redundant: `/credentials clear`
// in between, or a key revoked upstream, turns an approved request into a run the operator would
// have funded. Every test below is really the same assertion — the shared environment must not be
// reachable from a user request — asked in each of the ways the read can come back.

test('with the gate on, a user with their own credential still pays for their own build', async () => {
  const { builds, asked } = credentials({
    [buildEnvironmentName(REQUESTER)]: ['ANTHROPIC_API_KEY'],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });

  const r = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(r.ok, true, 'the gate refuses freeloaders, not payers');
  if (!r.ok) return;
  assert.equal(r.value, REQUESTER);
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER)], 'and the shared environment is never consulted');
});

test('with the gate on, a user who brought nothing is refused and the shared environment is NEVER read', async () => {
  // The whole feature in one assertion: with the operator's environment funded and ready, a
  // requester who brought no credential of their own still cannot reach it.
  const { builds, asked } = credentials({ [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'] });

  const r = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(r.ok, false, 'the operator does not subsidise strangers');
  if (r.ok) return;
  assert.equal(r.error.retryable, false, 'retrying cannot conjure a credential');
  assert.match(userMessage(r.error), /\/credentials set/u, 'and the refusal must say what to do');
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER)], 'ai-agent is not even asked about');
});

test('with the gate on, credentials that VANISHED between request and approve stop the dispatch', async () => {
  // THE REASON THIS CHECK EXISTS AT DISPATCH TIME AT ALL. `/request` was accepted because the
  // environment held a key; by the time an approver clicked, `/credentials clear` had emptied it.
  // Without this the run would start and the operator would quietly pay for it.
  const { builds, asked } = credentials({
    [buildEnvironmentName(REQUESTER)]: [],
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  });

  const r = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.retryable, false, 'a build nobody can fund must not be retried for six hours');
  assert.match(userMessage(r.error), /\/credentials set/u);
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER)], 'and no fallback read happens');
});

test('with the gate on, both refusals give the same instructions, because they are the same fix', async () => {
  // "You never brought one" and "yours is gone" are different sentences on purpose, but the next
  // step is identical and must not drift between the two arms.
  const never = await resolveBuildPayer(credentials({}).builds, REQUESTER, true);
  const gone = await resolveBuildPayer(credentials({ [buildEnvironmentName(REQUESTER)]: [] }).builds, REQUESTER, true);

  assert.equal(never.ok, false);
  assert.equal(gone.ok, false);
  if (never.ok || gone.ok) return;
  assert.equal(never.error.nextStep, CREDENTIALS_NEXT_STEP);
  assert.equal(gone.error.nextStep, CREDENTIALS_NEXT_STEP);
  assert.notEqual(never.error.userDetail, gone.error.userDetail, 'but the diagnosis differs');
});

test('with the gate on, an unreadable environment FAILS CLOSED instead of degrading', async () => {
  // The deliberate difference from the gate-off behaviour above. A 403 there means "skip the
  // pre-flight and let the operator pay", which is exactly the outcome the gate forbids — so
  // here it becomes an operator-facing config error naming both ways out.
  const { builds, asked } = refuses(
    errors.upstream('github', 403, 'Ask an admin to add Environments access to GITHUB_TOKEN.'),
  );

  const r = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(r.ok, false, '"I cannot check" is not "they can pay"');
  if (r.ok) return;
  assert.equal(r.error.kind, 'config', 'the bot cannot read environments: that is an operator problem');
  assert.match(r.error.nextStep, /Environments/u, 'and the fix names the permission');
  assert.match(r.error.nextStep, /requireOwnCredentials=false/u, 'or the switch that restores the old behaviour');
  assert.deepEqual(asked, [buildEnvironmentName(REQUESTER)], 'nothing falls through to the shared environment');
});

test('with the gate on, a blip is still retryable rather than a refusal', async () => {
  // A 500 must not read as "this person has nothing" — that would burn an approved request over
  // a transient failure, and tell the user to configure something they already configured.
  const { builds } = refuses(errors.upstream('github', 500, 'Try again in a minute.'));

  const r = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.retryable, true, 'the job retries rather than deciding from a blip');
});

test('with the gate on, a corrupt requester id cannot buy a free build', async () => {
  // A requester id that is not a snowflake cannot own an environment, so it cannot have brought
  // a credential. Falling back would make a corrupt row the cheapest way to spend somebody
  // else's money.
  const { builds, asked } = credentials({ [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'] });

  const r = await resolveBuildPayer(builds, 'not-a-snowflake', true);
  assert.equal(r.ok, false);
  assert.deepEqual(asked, [], 'and it never asks about an impossible environment');
});

test('with the gate on, the shipped fake refuses until the requester brings something', async () => {
  // `fakeBuilds()` seeds only `ai-agent`, i.e. the ordinary install: the operator is funded and
  // nobody else is. That is precisely the state in which the gate must refuse.
  const builds = fakeBuilds();
  const before = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(before.ok, false, 'a funded operator environment is not a free build');

  builds.environments.set(buildEnvironmentName(REQUESTER), ['CLAUDE_CODE_OAUTH_TOKEN']);
  const after = await resolveBuildPayer(builds, REQUESTER, true);
  assert.equal(after.ok, true);
  if (after.ok) assert.equal(after.value, REQUESTER, 'and bringing one flips the answer');
});

test('the gate changes who may spend, not which environment funds: with it off, ai-agent still pays', async () => {
  // The regression guard for "do not delete the shared path; gate it". One seed, two answers,
  // and the ONLY difference is the switch — so "gated" cannot quietly become "removed".
  const seed: Readonly<Record<string, readonly BuildCredentialName[]>> = {
    [SHARED_BUILD_ENVIRONMENT]: ['ANTHROPIC_API_KEY'],
  };

  const on = await resolveBuildPayer(credentials(seed).builds, REQUESTER, true);
  const off = await resolveBuildPayer(credentials(seed).builds, REQUESTER, false);

  assert.equal(on.ok, false, 'gate on: refused');
  assert.equal(off.ok, true, 'gate off: the shared path is preserved exactly');
  if (!off.ok) return;
  assert.equal(off.value, null, 'and null still means the operator pays');
});
