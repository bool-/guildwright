/**
 * The secrets port - how a user's own Claude credential gets from a Discord modal to the
 * runner that spends it, WITHOUT this process ever storing it.
 *
 * READ THE ABSENCE FIRST. There is no `get`, no `read`, no `reveal`, and no method that
 * returns anything derived from a secret's value. That is not an oversight to be fixed by a
 * future PR: it is the entire security argument for "bring your own credentials".
 *
 *   - GitHub environment secrets are genuinely write-only. There is no REST endpoint that
 *     returns a stored value, so a `get` here could not be implemented honestly anyway - it
 *     would have to be backed by a copy this process kept, which is exactly the thing we are
 *     refusing to do.
 *   - Because the port cannot read, a module holding `capabilities: ['secrets']` cannot
 *     exfiltrate one. The worst a compromised or careless module can do is overwrite or
 *     delete a credential - loud, recoverable, and visible in the audit log - rather than
 *     quietly forward one somewhere.
 *   - `list` returns NAMES, never values, because "did my key save?" is a question a user
 *     genuinely needs answered and "what is my key?" is one they never need answered by a bot.
 *
 * POSTMORTEMS THIS FILE CLOSES (all of them from the design phase, not production - the
 * point of writing them down is that they were live possibilities until the types closed them):
 *
 *  (1) "The build spent the wrong person's subscription." `EnvironmentName` selects which
 *      credentials a workflow run gets to spend, so it is an AUTHORIZATION INPUT, not a label.
 *      It is branded and mintable only through `toEnvironmentName`, whose regex admits exactly
 *      `ai-agent` and `user-<17-20 digit snowflake>`. A free-form string - a user id that is
 *      really `../ai-agent`, an empty string, a name assembled from unvalidated text - does not
 *      typecheck at the call site.
 *
 *  (2) "The OAuth token was written into ANTHROPIC_API_KEY." Both credentials begin `sk-ant-`,
 *      so a `startsWith('sk-ant-')` test evaluated first classifies EVERY OAuth token as an API
 *      key, and the result is an opaque 401 half an hour into somebody else's build.
 *      `classifyCredential` uses anchored per-family patterns that cannot be reordered back
 *      into that bug, and returns `null` - never a guess - for anything it does not recognise.
 *
 *  (3) "A secret ended up in a workflow_dispatch input." Nothing here is an input. The
 *      environment NAME is the only value that crosses into a workflow, it is deliberately
 *      non-secret, and GitHub prints dispatch inputs in the run title, the REST API and the job
 *      log in plaintext (verified live). Keeping the credential in the environment and the
 *      selector in the input is what makes that asymmetry safe.
 *
 * WHY `Secret` and not `string` for the value: `Secret.reveal()` is the single greppable
 * unwrap in the repo (SC-6). A `string` parameter here would mean every caller had already
 * unwrapped, and the grep that audits credential handling would return the whole call graph
 * instead of one line in one adapter.
 */

import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
// TYPE-ONLY, and it has to be: `#core/config` imports the branded constructors from
// `#core/ports`, so a VALUE import here would close a runtime cycle. `import type` is erased
// entirely under `verbatimModuleSyntax`, so this edge does not exist at run time.
import type { Secret } from '#core/config';

// ---------------------------------------------------------------------------------------
// EnvironmentName - an authorization input, therefore branded
// ---------------------------------------------------------------------------------------

declare const SECRETS_BRAND: unique symbol;

/**
 * A GitHub Actions environment this bot is allowed to write to.
 *
 * WHY BRANDED: the workflow selects its secrets with `environment: ${{ inputs.environment_name }}`,
 * so this string decides whose credentials a build spends. It is closer to a user id than to a
 * label, and a `string` parameter would let any code path pick any environment in the
 * repository - including one holding the operator's own keys.
 */
export type EnvironmentName = string & { readonly [SECRETS_BRAND]: 'EnvironmentName' };

/**
 * The operator-owned environment. Always holds `APPROVAL_HMAC_KEY`; holds build credentials only
 * when the operator has chosen to fund builds themselves.
 *
 * WHAT CHANGED AND WHY THIS SENTENCE IS NOW CONDITIONAL: this used to be "the fallback
 * credentials", full stop, because a requester who had stored nothing fell through to it.
 * `modules.builder.requireOwnCredentials` defaults to TRUE, and with the gate on there is no
 * fallback - `resolveBuildPayer` refuses instead, so no user request can reach this environment's
 * credentials. It funds builds again only when an operator sets that switch to false.
 *
 * `APPROVAL_HMAC_KEY` is unaffected either way, and it is NOT an environment secret: it must be a
 * REPOSITORY secret or it is empty in every per-user run. See the `environment:` comment in
 * .github/workflows/agent-implement-request.yml.
 */
export const AI_AGENT_ENVIRONMENT = 'ai-agent';

/** Prefix for a per-user environment. The suffix is a Discord snowflake, nothing else. */
export const USER_ENVIRONMENT_PREFIX = 'user-';

/**
 * The two shapes, and only these two.
 *
 * WHY it is one anchored alternation rather than two checks: a name is either the operator's
 * environment or exactly one user's, and expressing that as a single regex means there is no
 * third branch for a future edit to add by accident. The `\d{17,20}` bound is the Discord
 * snowflake range - the same one `#core/ids` uses - so `user-` followed by anything else
 * (a path traversal, a username, an empty id) is not representable.
 */
const ENVIRONMENT_NAME_RE = /^(?:ai-agent|user-\d{17,20})$/u;

/** WHY a predicate and not a cast: the regex IS the evidence for the brand. */
function isEnvironmentName(value: string): value is EnvironmentName {
  return ENVIRONMENT_NAME_RE.test(value);
}

/**
 * The ONLY constructor for `EnvironmentName`.
 *
 * The `nextStep` is aimed at an admin rather than the user, because a user cannot cause this:
 * every path that builds a name does so from an id Discord gave us, so a rejection here means
 * the bot assembled a name from something unexpected.
 */
export function toEnvironmentName(value: string): Result<EnvironmentName, AppError> {
  return isEnvironmentName(value)
    ? Ok(value)
    : Err(
        errors.validation(
          'environment',
          'That is not an environment this bot may use.',
          'Report this to an admin: an environment name must be "ai-agent" or "user-" plus a Discord user id.',
        ),
      );
}

/**
 * The environment that holds one Discord user's credential.
 *
 * WHY the id is validated here rather than trusted: this is the join between a Discord
 * identity and a GitHub authorization boundary, and it is the exact place where a mistyped or
 * attacker-chosen id would silently redirect somebody else's spending.
 */
export function userEnvironmentName(discordUserId: string): Result<EnvironmentName, AppError> {
  return toEnvironmentName(`${USER_ENVIRONMENT_PREFIX}${discordUserId}`);
}

/**
 * The operator's environment, minted.
 *
 * WHY it throws instead of returning a `Result`, in a file where everything else returns one:
 * it takes no input. The argument is a literal in this file matched by a regex in this file,
 * so an `Err` branch would be unreachable code that every caller still has to write a handler
 * for. Same reasoning as `assertActionRef` in `#core/ids`, and there is a test that calls it.
 */
export function agentEnvironment(): EnvironmentName {
  const minted = toEnvironmentName(AI_AGENT_ENVIRONMENT);
  if (!minted.ok) throw new Error(minted.error.code);
  return minted.value;
}

/** True for a per-user environment. WHY exported: cleanup jobs must never touch `ai-agent`. */
export function isUserEnvironment(name: EnvironmentName): boolean {
  return name.startsWith(USER_ENVIRONMENT_PREFIX);
}

// ---------------------------------------------------------------------------------------
// SecretName - a closed set of two
// ---------------------------------------------------------------------------------------

/**
 * Every secret name this bot will ever write.
 *
 * WHY a closed set and not a `string`: these names are read by `.github/workflows/*.yml` as
 * `secrets.ANTHROPIC_API_KEY` / `secrets.CLAUDE_CODE_OAUTH_TOKEN`. A name the workflow does
 * not reference writes a secret nobody reads - which looks like success in the API response
 * and fails as an unfunded build later. A typo is TS2322 at the call site instead.
 */
export const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/** One of the two names the build workflow reads. */
export type SecretName = (typeof SECRET_NAMES)[number];

/** Parse a name that arrived as a string (a stored row, an operator command). */
export function toSecretName(value: string): Result<SecretName, AppError> {
  const found = SECRET_NAMES.find((name) => name === value);
  return found === undefined
    ? Err(
        errors.validation(
          'secretName',
          'That is not a credential this bot manages.',
          `Use one of: ${SECRET_NAMES.join(', ')}.`,
        ),
      )
    : Ok(found);
}

/**
 * Which secret name a supplied credential belongs under.
 *
 * Both credentials share the `sk-ant-` family prefix and are told apart by the SEGMENT that
 * follows it:
 *
 *     sk-ant-api03-...   Console API key, metered            -> ANTHROPIC_API_KEY
 *     sk-ant-oat01-...   `claude setup-token`, subscription   -> CLAUDE_CODE_OAUTH_TOKEN
 *
 * THE ORDER OF THE TWO TESTS IS NOT WHAT DISAMBIGUATES, and that is deliberate. An earlier
 * draft tested `startsWith('sk-ant-')` first, and every OAuth token was silently classified as
 * an API key: it would have written `sk-ant-oat01-...` into ANTHROPIC_API_KEY and produced an
 * opaque 401 thirty minutes into someone else's build - precisely the failure this feature
 * exists to remove. Anchored per-family patterns cannot be reordered into that bug.
 *
 * The generation digits are `\d+` rather than a pinned `03`/`01`: Anthropic has already shipped
 * `api01` and `api02`, so pinning the current number would start rejecting valid credentials on
 * the next rotation. Length is never checked either - it is not stable across generations, and
 * a length check fails the same way but more mysteriously.
 *
 * `null` means "not recognised" and the caller MUST reject rather than guess. Note that this
 * deliberately refuses `sk-ant-admin...` (an Admin API key): it is not a build credential, and
 * accepting one would hand an org-administration key to a build container.
 *
 * WHY IT TAKES A `Secret` AND NOT A `string` - it took a `string` until the integration, and
 * that signature was the whole reason the invariant broke. A `string` parameter forces the
 * CALLER to unwrap, and the only caller is the credentials module, so
 * `classifyCredential(credential.reveal())` put a `.reveal()` inside `src/modules/**`. That
 * absence is what makes `grep -rn '\.reveal(' src/` a COMPLETE audit of credential handling:
 * one line in the GitHub adapter, plus this one. `src/conventions.test.ts` now asserts the
 * count under `src/modules/**` is zero, so the old signature does not merely read badly - it
 * fails the suite.
 *
 * The unwrap here cannot become an oracle. The return type is a NAME drawn from a closed set of
 * two, so nothing derived from the value's bytes escapes this function; that is what makes it
 * safe to put the single core-side `reveal()` here instead of pushing it out to every caller.
 *
 * The trim mirrors `toSecret`, which trims at the modal door, so the bytes classified here are
 * the bytes `put` seals. There is a test pinning that agreement rather than leaving it to
 * inspection, because classifying trimmed and storing untrimmed is a silent 401 in a build.
 */
export function classifyCredential(credential: Secret): SecretName | null {
  const trimmed = credential.reveal().trim();
  if (/^sk-ant-oat\d+-/u.test(trimmed)) return 'CLAUDE_CODE_OAUTH_TOKEN';
  if (/^sk-ant-api\d+-/u.test(trimmed)) return 'ANTHROPIC_API_KEY';
  return null;
}

// ---------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------

/**
 * What one environment holds - or the fact that there is no such environment.
 *
 * WHY `exists` IS A SEPARATE FIELD AND NOT AN EMPTY `names`: those two states are the whole
 * difference between "you have never stored anything" (a normal answer to `/credentials status`,
 * and the majority case) and "you opted in to paying for your own builds and your credential has
 * since been revoked" (which `resolveBuildPayer` must REFUSE to fall back from, or the operator
 * silently picks up the bill - and with `requireOwnCredentials` on, the default, there is no
 * fallback to refuse from at all: BOTH answers stop the build, and only the sentence the user
 * reads differs). Collapsing them into `readonly string[]` is what forced the
 * integration to report a 404 as "ask an admin to check the token repository access" to every
 * user who had simply never run `/credentials set`.
 *
 * WHY IT MIRRORS `EnvironmentCredentials` in `#core/ports`: that type already draws exactly this
 * distinction for the builds side of the same GitHub endpoint. Two shapes for one question is
 * how the two sides come to disagree about what an empty environment means.
 *
 * `names` is `readonly string[]` and not `readonly SecretName[]` because an operator may have
 * set other secrets on the environment by hand, and silently dropping them from a listing would
 * make this the least trustworthy debugging tool in the bot. It is ALWAYS empty when `exists` is
 * false.
 */
export interface EnvironmentListing {
  /** False only when the backend is CERTAIN there is no such environment. */
  readonly exists: boolean;
  /** The secret NAMES present. Never values; there is no endpoint that returns one. */
  readonly names: readonly string[];
}

/**
 * Write-only credential storage, backed by GitHub environment secrets.
 *
 * Every method is `Promise<Result<...>>`: this is a network port, and a user pasting a
 * credential must be told what to do next when GitHub says no, not shown a stack trace.
 *
 * THE `boolean` ON THE TWO REMOVALS IS LOAD-BEARING, so it is stated once here rather than
 * twice below: "I removed it" and "there was nothing to remove" are different sentences to the
 * person who typed `/credentials clear`, and only the backend can tell them apart. A `void`
 * return makes the second one unsayable, which is how `present.cleared(false)` became a view
 * that shipped, rendered at boot, and was unreachable in production.
 *
 * "Nothing there" is an ANSWER, never an error. An error means the bot could not find out.
 */
export interface SecretsPort {
  /**
   * Create the environment if absent. Idempotent.
   *
   * WHY it is a separate call rather than something `put` does implicitly: creating an
   * environment and writing a credential into it need different token permissions in an
   * operator's mind, and when only one of them is missing the user must be told which. It is
   * also the natural place for a "you have not set anything up yet" check that writes nothing.
   */
  ensureEnvironment(name: EnvironmentName): Promise<Result<void, AppError>>;

  /**
   * Encrypt and store one credential.
   *
   * The plaintext is never persisted, logged, or returned. It is sealed to GitHub's public key
   * in memory and the sealed box - not the value - is what leaves this process.
   *
   * Overwrites silently when the name already exists, which is what "update my key" means.
   */
  put(env: EnvironmentName, name: SecretName, value: Secret): Promise<Result<void, AppError>>;

  /**
   * Which secret NAMES an environment holds, or that there is no such environment.
   *
   * `Ok({ exists: false })` is the ordinary answer for a user who has never run
   * `/credentials set`, and it MUST NOT be an error - that is the majority of callers.
   *
   * An `Err` here means the bot could not find out: the token cannot see the repository, or it
   * is missing the **Environments** permission. Those two must stay distinguishable from
   * absence, because reporting them as "you have stored nothing" tells a user with a working
   * credential to paste it again, forever. The GitHub adapter documents how it tells a 404 that
   * means "no such environment" from a 404 that means "no such access".
   */
  list(env: EnvironmentName): Promise<Result<EnvironmentListing, AppError>>;

  /**
   * Remove one credential.
   *
   * `Ok(true)` it was there and is gone; `Ok(false)` there was nothing to remove - neither the
   * secret nor, possibly, the environment. Both are success: "make it gone" is the ask.
   */
  remove(env: EnvironmentName, name: SecretName): Promise<Result<boolean, AppError>>;

  /**
   * Delete the environment and every secret in it.
   *
   * This is the "forget me" path, and it is the only complete one: deleting the environment is
   * what guarantees no copy of the credential survives anywhere the bot can reach.
   *
   * `Ok(true)` the environment existed and is gone; `Ok(false)` there was nothing there. It is
   * also the ROLLBACK for a half-finished `/credentials set`: an environment created by
   * `ensureEnvironment` whose `put` then failed is empty, and an empty user environment blocks
   * that user's builds outright - at `/request` submission time as well as at dispatch, since
   * `modules.builder.requireOwnCredentials` defaults on (see `requireOwnCredentialsGate` and
   * `resolveBuildPayer`). So the module deletes it again rather than leaving a user locked out of
   * the flagship command by a failure that was not theirs.
   */
  deleteEnvironment(name: EnvironmentName): Promise<Result<boolean, AppError>>;
}

/** Short alias, matching `Audit`, `Builds` and `Chat`. */
export type Secrets = SecretsPort;
