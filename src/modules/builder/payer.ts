/**
 * WHO PAYS FOR THE BUILD, and the two places that question is asked.
 *
 * WHY IT IS ITS OWN FILE: `/request retry` re-dispatches an already-approved build, so it must
 * run the SAME credential check as a fresh submission - and a retry that skipped it would be a
 * door straight past "no free builds", reachable by anybody who could get one request approved
 * and then let it fail. Two callers means one home; the alternative was `history.ts` importing
 * `module.ts` importing `history.ts`.
 *
 * Nothing here was rewritten: this is the funding logic exactly as it was, moved.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { SHARED_BUILD_ENVIRONMENT, buildEnvironmentName } from '#core/text';
import { toUserId } from '#core/ids';
import type { BuildsPort } from '#core/ports';

// ---------------------------------------------------------------------------------------
// Who pays for the build
// ---------------------------------------------------------------------------------------

/**
 * THE SENTENCE SOMEBODY WHO BROUGHT NOTHING IS TOLD, written once because it is said twice:
 * when `/request new` is refused, and again if the credential disappears between requesting and
 * being approved.
 *
 * It names the command, BOTH accepted credential shapes and where each one comes from. "You
 * need credentials" with no instructions is precisely the dead end that `AppError.nextStep`
 * exists to make impossible, and the two shapes are not interchangeable to a user: one is
 * bought from a console, the other is minted by a CLI they may already be running.
 */
export const CREDENTIALS_NEXT_STEP =
  'Run /credentials set and paste either an Anthropic API key (sk-ant-api...) from console.anthropic.com, ' +
  'or a Claude Code OAuth token (sk-ant-oat...) from running `claude setup-token`.';

/**
 * The refusal itself. WHY exported: two call sites must refuse with the SAME sentence, and a
 * test pins that the sentence names `/credentials set` rather than merely implying it.
 *
 * `state` separates the two ways of having nothing, because they read differently to the
 * person holding the phone: `none` never brought a credential; `empty` brought one that has
 * since been revoked, rotated or deleted, and may not know it.
 */
export function ownCredentialsRequiredError(state: 'none' | 'empty'): AppError {
  return errors.conflict(
    'own_credentials_required',
    state === 'empty'
      ? 'Your build credentials are no longer stored on GitHub, so nothing would pay for this build.'
      : 'Builds here run on your own Anthropic credentials, and you have not stored any.',
    CREDENTIALS_NEXT_STEP,
    state,
  );
}

/**
 * What to say when the bot could not FIND OUT whether the requester can pay.
 *
 * A retryable cause (a 500, a rate limit, a dead socket) is handed back unchanged, so the
 * caller retries instead of deciding anything from a blip. A permanent one - in practice a 403
 * because the token lacks the **Environments** permission - becomes an operator-facing config
 * error, because with `requireOwnCredentials` on there is no honest degradation left: the whole
 * point of the switch is that the operator's environment must not silently pay, and "I cannot
 * check" is not "they can pay". So it fails closed, and names both ways out.
 */
function unverifiableCredentialsError(cause: AppError): AppError {
  if (cause.retryable) return cause;
  return errors.config(
    'modules.builder.requireOwnCredentials',
    `the requester's build environment could not be read: ${cause.code}`,
    'Ask an admin to give the bot token the GitHub "Environments" permission, or to set ' +
      'modules.builder.requireOwnCredentials=false so the shared ai-agent environment funds builds again.',
  );
}

/**
 * A read of the requester's OWN environment, reduced to the four answers that matter.
 *
 * WHY a small union rather than `Result<boolean, AppError>`: "the environment exists and is
 * empty" and "there is no environment" are different facts with different consequences - the
 * first is a revoked key, the second is somebody who never opted in - and every defect in this
 * area so far has come from a value that could not tell them apart.
 */
type OwnCredentials =
  | { readonly kind: 'has'; readonly payer: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly error: AppError };

async function readOwnCredentials(
  builds: Pick<BuildsPort, 'environmentCredentials'>,
  requesterId: string,
): Promise<OwnCredentials> {
  // A requester id that is not a snowflake cannot own an environment - `buildEnvironmentName`
  // would throw on it. That is a corrupt row, not something a user can produce, so it reads as
  // "brought nothing" rather than crashing a durable job.
  const requester = toUserId(requesterId);
  if (!requester.ok) return { kind: 'none' };

  const own = await builds.environmentCredentials(buildEnvironmentName(requester.value));
  if (!own.ok) return { kind: 'unreadable', error: own.error };
  if (own.value.exists && own.value.credentials.length > 0) return { kind: 'has', payer: requester.value };
  return own.value.exists ? { kind: 'empty' } : { kind: 'none' };
}

/**
 * MAY THIS PERSON OPEN A REQUEST AT ALL? The `requireOwnCredentials` gate, at the front door.
 *
 * WHY THE FRONT DOOR IS THE MODAL SUBMISSION and not `/request new` itself: it is
 * `ack: 'form'`, and such a handler must not await before returning a modal - Discord forbids
 * defer-then-modal - so the first place a credential read can legally happen is the submission.
 * It is also the LAST place that costs nothing. Everything downstream files a GitHub issue and
 * posts an Approve/Reject card, so refusing later leaves a permanent issue in the repository
 * and a card demanding a human decision, both describing a build that could never have run.
 *
 * WHY IT IS NOT THE ONLY CHECK: see `resolveBuildPayer`. A user can run `/credentials clear`
 * between being filed and being approved, and by then this answer is minutes to days old.
 */
export async function requireOwnCredentialsGate(
  builds: Pick<BuildsPort, 'environmentCredentials'>,
  requesterId: string,
): Promise<Result<void, AppError>> {
  const own = await readOwnCredentials(builds, requesterId);
  switch (own.kind) {
    case 'has':
      return Ok(undefined);
    case 'empty':
    case 'none':
      return Err(ownCredentialsRequiredError(own.kind));
    case 'unreadable':
      return Err(unverifiableCredentialsError(own.error));
    default: {
      // Exhaustiveness proof: a fifth answer fails HERE, at compile time, rather than falling
      // through to "let them in", which is the one wrong answer this gate must never give.
      const exhaustive: never = own;
      void exhaustive;
      return Err(ownCredentialsRequiredError('none'));
    }
  }
}

/**
 * Decide WHO PAYS for this build, and refuse to dispatch into an environment that cannot
 * possibly authenticate.
 *
 * Returns the Discord user id whose environment funds the run, or `null` for the shared
 * operator environment.
 *
 * WHY IT RETURNS THE PAYER AND NOT THE ENVIRONMENT NAME: the name has to appear in two places
 * that must be byte-identical - the `environment_name` dispatch input and the approval MAC -
 * and returning a name invites the caller to hold two variables that agree today. Returning
 * the payer means both are derived from it through `buildEnvironmentName`, which is the single
 * place that string is built, so they cannot drift.
 *
 * `requireOwnCredentials` IS A REQUIRED PARAMETER WITH NO DEFAULT. It decides whether the
 * operator's `ai-agent` environment may be reached at all, so a call site that could forget it
 * would be a call site that silently reopened the operator's wallet. The CONFIG field defaults
 * to `true`; this parameter defaults to nothing.
 *
 * THE RULE WITH THE GATE ON, which is the shipped default. One branch, one answer:
 *
 *   requester has an environment with a credential  -> theirs; they pay.
 *   anything else                                   -> ERROR. There is no fallback below this
 *       line, so no code path leads from "brought nothing" to spending the operator's
 *       credentials. That includes the operator, who is a requester like everybody else: there
 *       is deliberately NO owner bypass, because a silent exemption for whoever happens to hold
 *       the token is exactly the special case that surprises somebody later.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE CHECK AT `/request new`: the two are minutes to days apart.
 * `/credentials clear` in between, or a key revoked upstream, turns an approved request into a
 * run the operator would have funded. This is the check standing between that and the bill, so
 * it re-reads rather than trusting the earlier answer.
 *
 * THE RULE WITH THE GATE OFF is exactly what shipped before this switch existed, unchanged, so
 * an operator funding a private server still gets today's behaviour:
 *
 *   requester has an environment with a credential  -> theirs; they pay.
 *   requester has an environment holding NOTHING    -> ERROR. They opted in to funding their
 *       own builds and the credential is gone (revoked, rotated, deleted by hand). Quietly
 *       falling back to `ai-agent` would bill the operator for a build the user chose to pay
 *       for, and nobody would ever find out, because the run would simply succeed.
 *   requester has no environment at all             -> the shared one; the operator pays.
 *   the shared one holds nothing either             -> ERROR, and this is the LIKELY state on
 *       a fresh install: `ai-agent` ships holding only APPROVAL_HMAC_KEY.
 *   GitHub cannot be asked, transiently (500, a   -> ERROR, retryable. Deciding who pays from
 *       rate limit, a dead socket)                     a blip is how a user with their own key
 *                                                      silently lands on the operator's bill.
 *   GitHub REFUSES to be asked (401/403: the      -> the shared one; the operator pays. See
 *       token lacks the Environments permission)       the long note in the body.
 *
 * THAT LAST ROW IS THE ONE WORTH ARGUING ABOUT, and note it holds only with the gate OFF. This
 * function is a PRE-FLIGHT: an optimisation that turns "an opaque auth error thirty minutes
 * into the agent step" into an immediate, specific sentence. It is not the thing that
 * authorises spending - the RUNNER reads the environment, under GitHub's own access rules, and
 * its access has nothing to do with this token. So when the bot is not permitted to run the
 * pre-flight, the correct degradation is to skip it, not to refuse. Refusing meant that one
 * missing OPTIONAL permission broke every build for every user, including everyone who never
 * brought a credential and whose build should simply have run on `ai-agent` exactly as it did
 * before this feature existed. The adapter logs a warning when this happens, because "the
 * operator pays" must never be a silent answer.
 *
 * With the gate ON that degradation is not available, and that is not an inconsistency:
 * degrading means "the operator pays", which is the single outcome the gate exists to forbid.
 * So an unreadable environment fails closed and names the permission to grant.
 *
 * WHY IT IS CHECKED BEFORE DISPATCH RATHER THAN LEARNED FROM THE RUN: an environment with no
 * credential does not fail the dispatch. The run starts, passes the approval gate, consumes a
 * daily-cap slot and a concurrency slot, and dies with an auth error inside the agent step up
 * to thirty minutes later - and what the user sees is "Build failed", with nothing pointing at
 * their own expired key. One read beforehand turns that into an immediate, specific sentence.
 *
 * WHY IT TAKES THE PORT AND NOT `ctx`: it is the interesting decision in this file, and it is
 * worth testing with a fake and no database, clock or job runner.
 */
export async function resolveBuildPayer(
  builds: Pick<BuildsPort, 'environmentCredentials'>,
  requesterId: string,
  requireOwnCredentials: boolean,
): Promise<Result<string | null, AppError>> {
  const own = await readOwnCredentials(builds, requesterId);
  if (own.kind === 'has') return Ok(own.payer);

  // NO FREE BUILDS. Every remaining answer means "this requester is not demonstrably paying",
  // and with the gate on that is the end of the road: the shared read below is unreachable, so
  // there is no path from here to spending the operator's credentials.
  if (requireOwnCredentials) {
    return own.kind === 'unreadable'
      ? Err(unverifiableCredentialsError(own.error))
      : Err(ownCredentialsRequiredError(own.kind));
  }

  if (own.kind === 'empty') {
    return Err(
      errors.conflict(
        'user_credentials_missing',
        'Your build credentials are no longer stored on GitHub, so this build was not started.',
        'Add your Anthropic API key or Claude Code OAuth token again, or ask an admin to delete your environment so builds fall back to the shared one.',
        'empty',
      ),
    );
  }
  if (own.kind === 'unreadable' && own.error.retryable) {
    // A BLIP (500, a rate limit, a dead socket). Retrying can still learn the true answer, and
    // deciding who pays from a transient failure is how a user with their own credential
    // silently ends up on the operator's bill.
    return Err(own.error);
  }
  // Otherwise: no environment of their own, or a PERMANENT read failure - in practice a 403
  // because GITHUB_TOKEN is missing the **Environments** permission, or a 401.
  // `errors.upstream` marks exactly 401/403 non-retryable, so that arm is precisely "asking
  // again will never work".
  //
  // WHY THE PERMANENT FAILURE DEGRADES INSTEAD OF FAILING, which is the whole point of this
  // branch: the bot cannot read ANY environment in that state, including its own, so returning
  // the error here broke every build for every user - including the majority who never brought
  // credentials and whose builds should simply run on `ai-agent`, exactly as they did before
  // this feature existed. A missing optional permission must cost the OPTIONAL feature, not the
  // product. The shared read below is the same call against `ai-agent`; if the permission gap is
  // real it fails there too, and the operator gets the Environments sentence with nothing
  // silently spent. If it somehow succeeds, the operator pays - the pre-feature behaviour.

  const shared = await builds.environmentCredentials(SHARED_BUILD_ENVIRONMENT);
  if (!shared.ok) {
    // Same split as above, and it has to be here too or the degradation is only half built: a
    // token without the **Environments** permission fails BOTH reads, so returning the error
    // here would still mean nothing builds anywhere.
    //
    // This whole function is a PRE-FLIGHT - an optimisation that turns "an opaque auth error
    // thirty minutes into the agent step" into an immediate sentence. When the bot is not
    // permitted to run the pre-flight at all, the right answer is to skip it and dispatch to the
    // operator's environment, which is exactly what the bot did before this feature existed. The
    // credentials themselves are read by the RUNNER, whose access has nothing to do with this
    // token, so a build that would have worked still works.
    if (shared.error.retryable) return Err(shared.error);
    return Ok(null);
  }
  if (shared.value.credentials.length === 0) {
    return Err(
      errors.config(
        'build_credentials',
        `neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set in the ${SHARED_BUILD_ENVIRONMENT} environment`,
        'Supply your own Anthropic credentials, or ask an admin to add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN to the ai-agent environment.',
      ),
    );
  }
  return Ok(null);
}
