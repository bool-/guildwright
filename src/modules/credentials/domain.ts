/**
 * Bring-your-own-credentials: the logic.
 *
 * There is exactly ONE `SecretsPort` (`#core/ports/secrets`), and this file is written against
 * it directly. An earlier integration carried three "INTEGRATION-COMPROMISE" notes here, where a
 * second, incompatible port design had been bent onto this one. All three are gone, and each is
 * described below rather than deleted silently, because every one of them was a real defect:
 *
 *   1. `classifyCredential` took a `string`, so this file had to call `credential.reveal()` to
 *      use it - putting the single greppable unwrap inside `src/modules/**` and destroying the
 *      one-line audit that justifies the `Secret` carrier at all. It takes a `Secret` now, and
 *      `src/conventions.test.ts` asserts `.reveal(` appears ZERO times under `src/modules/**`.
 *
 *   2. A failed `put` left behind the environment `ensureEnvironment` had just created. An empty
 *      user environment is not a harmless leftover: `resolveBuildPayer` reads it as "this person
 *      opted in to funding their own builds and the credential is gone" and FAILS the build,
 *      deliberately, so that a revoked key can never quietly move the bill back to the operator.
 *      One transient GitHub error during a modal submission therefore blocked that user's builds
 *      permanently, on an install whose shared environment was funded and would have paid.
 *      `set` now rolls it back - see `rollback`.
 *
 *   3. `clear` could only ever answer "removed", because the port returned `void`. The port
 *      answers `boolean` now, so `present.cleared(false)` - a view that shipped, was rendered at
 *      boot, and was unreachable in production - is reachable, and `/credentials clear` tells
 *      the truth to somebody who never stored anything.
 *
 * WHAT THIS WHOLE FILE IS CAREFUL ABOUT: the credential is a `Secret` from the moment it leaves
 * `toSecret` until the adapter seals it. It is never a `string` here, never interpolated, never
 * placed in an `AppError`, and cannot be put in an audit `detail` - that parameter is
 * `JsonObject` and `Secret` is not assignable to it, so the type is the wall rather than the
 * comment. The audit rows carry the secret NAME and the outcome, which is what "what happened?"
 * actually needs answered.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { toSecret, type UserText } from '#core/text';
import type { UserId } from '#core/ids';
import type { Audit } from '#core/ports/audit';
import type { RepoRef, RepoScoped } from '#core/ports/repos';
import {
  classifyCredential,
  toSecretName,
  userEnvironmentName,
  type EnvironmentName,
  type SecretName,
  type Secrets,
} from '#core/ports/secrets';

// ---------------------------------------------------------------------------------------
// Which repository (RFC-001 PR 2.1)
// ---------------------------------------------------------------------------------------

/**
 * The sentence for a bot with several repositories and no default: there is no repository whose
 * environments a credential could go into. RFC-001 8.1's unmapped refusal, with the next step
 * this version can actually offer (guild routing, `/repo use`, is PR 2.2).
 */
export function noCredentialRepositoryError(): AppError {
  return errors.config(
    'repos.unmapped',
    'This server is not linked to a repository yet, so there is nowhere to store a credential for it.',
    'Ask the bot operator to mark one repository "default": true in GITHUB_REPOS_JSON.',
  );
}

/** A `Secrets` that refuses everything with one error, for a bot with no repository to act on. */
function refusingSecrets(error: AppError): Secrets {
  const no = async (): Promise<Result<never, AppError>> => Err(error);
  return { ensureEnvironment: no, put: no, list: no, remove: no, deleteEnvironment: no };
}

/** Which repository's `Secrets` this module acts on, or why there is none. */
export interface CredentialRepository {
  readonly secrets: Secrets;
  /** Null when there is a repository; otherwise the `/status` sentence. */
  readonly unavailable: string | null;
}

/**
 * THE SEAM PR 2.3 REPLACES. Today every `/credentials` command acts on the DEFAULT repository of
 * the set - which, for a one-repository install, is the repository it always acted on, so
 * nothing changes there. PR 2.3 resolves per command instead: a guild's own repository
 * (`repos.resolve(guildId)`), and in a DM a `repo:` option or every repository.
 *
 * With no default (several repositories, none marked), every command refuses with
 * `noCredentialRepositoryError` and `/status` reports the module down: storing a credential in
 * "the first repository" would put money where nobody asked for it.
 */
export function credentialRepository(
  repos: { all(): readonly RepoRef[] },
  secrets: RepoScoped<Secrets>,
): CredentialRepository {
  const target = repos.all().find((r) => r.isDefault) ?? null;
  if (target === null) {
    const error = noCredentialRepositoryError();
    return { secrets: refusingSecrets(error), unavailable: `${error.internal ?? ''} ${error.nextStep}`.trim() };
  }
  const scoped = secrets.at(target);
  if (!scoped.ok) return { secrets: refusingSecrets(scoped.error), unavailable: scoped.error.nextStep };
  return { secrets: scoped.value, unavailable: null };
}

/** What `/credentials status` learned. `names` is empty when nothing is stored. */
export interface CredentialStatus {
  readonly names: readonly SecretName[];
}

const WHAT_WE_EXPECTED =
  'Paste an Anthropic API key (starts sk-ant-api…, from console.anthropic.com) or a Claude Code OAuth token (starts sk-ant-oat…, from running `claude setup-token`). Admin API keys are not accepted.';

/** The credential kind a user did NOT just supply. There are exactly two, so this is total. */
function otherCredentialName(name: SecretName): SecretName {
  return name === 'ANTHROPIC_API_KEY' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

export class CredentialService {
  private readonly secrets: Secrets;
  private readonly audit: Audit;

  constructor(secrets: Secrets, audit: Audit) {
    this.secrets = secrets;
    this.audit = audit;
  }

  async set(actorId: UserId, guildId: string | null, submitted: UserText): Promise<Result<SecretName, AppError>> {
    const env = userEnvironmentName(actorId);
    if (!env.ok) return env;

    // `toSecret` is the one door from `UserText` to a credential, and the only unwrap in
    // `#core/text` that does not sanitise. It strips whitespace - a paste out of a terminal
    // carries a trailing newline, and a wrapped one a newline in the middle - and nothing
    // downstream of it ever sees a `string`.
    const credential = toSecret(submitted);

    const name = classifyCredential(credential);
    if (name === null) {
      this.audit.record({
        action: 'credentials.set_refused',
        actorId,
        guildId,
        detail: { reason: 'unrecognised-shape' },
      });
      return Err(errors.validation('credential', 'That does not look like an Anthropic credential.', WHAT_WE_EXPECTED));
    }

    // `put` cannot create the environment: writing a secret needs that environment's public key,
    // and there is no key until it exists. The two calls are sequenced HERE rather than hidden
    // inside the adapter, because the gap between them is exactly where a user gets stranded,
    // and the module is the only layer that knows how to undo it.
    const created = await this.secrets.ensureEnvironment(env.value);
    if (!created.ok) return created;

    const stored = await this.secrets.put(env.value, name, credential);
    if (!stored.ok) return this.rollback(env.value, stored.error);

    // REMOVE THE OTHER KIND, and this is not tidiness.
    //
    // The workflow hands the action BOTH `anthropic_api_key` and `claude_code_oauth_token`, and
    // which one actually authenticates is decided by that action's own precedence, which we do
    // not control and which is not documented. So leaving the previous credential behind means
    // the most likely reason anyone runs this command twice — "my OAuth token expired, here is
    // an API key" — can produce a build that authenticates with the dead token and fails for a
    // reason the user has already fixed.
    //
    // Ordering matters: the new credential is written FIRST. If this removal fails, the user is
    // left with both (today's behaviour, recoverable) rather than with neither.
    const superseded = otherCredentialName(name);
    const cleared = await this.secrets.remove(env.value, superseded);

    this.audit.record({
      action: 'credentials.set',
      actorId,
      guildId,
      // `supersededRemoved` is null when the removal itself failed, which is distinguishable
      // from `false` ("there was nothing of the other kind to remove").
      detail: { secretName: name, supersededRemoved: cleared.ok ? cleared.value : null },
    });
    return Ok(name);
  }

  /**
   * UNDO A HALF-FINISHED `set`, then report the original failure.
   *
   * WHY IT DELETES ONLY A COMPLETELY EMPTY ENVIRONMENT, and re-reads to find that out instead of
   * remembering whether it just created one:
   *
   *   - A REPLACEMENT MUST SURVIVE. If the user already had a working credential and this
   *     submission was "here is my new key", a failed `put` must not take the old key with it.
   *     The re-read sees that name and leaves the environment alone.
   *   - AN OPERATOR'S OWN SECRET MUST SURVIVE. Deleting an environment takes every secret in it,
   *     including names this bot does not manage. Emptiness is precisely the state
   *     `ensureEnvironment` can have produced, so emptiness is precisely what gets rolled back.
   *   - It also HEALS an environment stranded by an earlier failure, which remembering "did I
   *     create it?" would not.
   *
   * WHY THE CLEANUP'S OWN RESULT IS DISCARDED: the user asked to store a credential and that
   * failed - that is the sentence they need, and it names something they can act on. Replacing
   * it with an error about the cleanup would not. If the re-read or the delete fails, the
   * environment simply stays as it was: the state this rollback improves on, never worse.
   */
  private async rollback(env: EnvironmentName, failure: AppError): Promise<Result<SecretName, AppError>> {
    const after = await this.secrets.list(env);
    if (after.ok && after.value.exists && after.value.names.length === 0) {
      await this.secrets.deleteEnvironment(env);
    }
    return Err(failure);
  }

  async status(actorId: UserId): Promise<Result<CredentialStatus, AppError>> {
    const env = userEnvironmentName(actorId);
    if (!env.ok) return env;
    const listed = await this.secrets.list(env.value);
    if (!listed.ok) return listed;
    // `exists: false` is the ordinary answer for somebody who has never run `/credentials set`,
    // and `names` is empty in that case, so there is no branch to write here - the view already
    // reads "No credential of your own". The distinction is load-bearing one layer down, where
    // it separates "nothing stored" from "the bot could not find out", and an `Err` above is the
    // only thing that reaches the user as a problem.
    //
    // `list` reports every name on the environment, including any an operator set by hand, so
    // names this bot does not manage are filtered out rather than presented as credentials.
    const names: SecretName[] = [];
    for (const raw of listed.value.names) {
      const parsed = toSecretName(raw);
      if (parsed.ok) names.push(parsed.value);
    }
    return Ok({ names });
  }

  /**
   * "Forget my credential."
   *
   * `true` there was something and it is gone; `false` there was nothing there. BOTH ARE
   * SUCCESS. A user who never stored anything and types `/credentials clear` has asked for a
   * state that already holds, and answering "ask an admin to check the token repository access"
   * - which is what a blanket 404 mapping did - is wrong for the majority of callers.
   *
   * A 404 that really is a permission problem is still an error: the adapter tells the two apart
   * rather than guessing. The audit row records which of the two answers the user was given.
   */
  async clear(actorId: UserId, guildId: string | null): Promise<Result<boolean, AppError>> {
    const env = userEnvironmentName(actorId);
    if (!env.ok) return env;
    const removed = await this.secrets.deleteEnvironment(env.value);
    if (!removed.ok) return removed;
    this.audit.record({ action: 'credentials.clear', actorId, guildId, detail: { existed: removed.value } });
    return Ok(removed.value);
  }
}
