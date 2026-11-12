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
 *
 * TWO LAYERS (RFC-001 PR 2.3): `RepositoryCredentials` is everything above against ONE
 * repository's environments; `CredentialService` decides WHICH repository a command acts on - a
 * server's own, a DM's `repo:` choice, or every one - and hands the command to it.
 */

import { Err, Ok, type Result } from '#core/result';
import { errors, userMessage, type AppError } from '#core/errors';
import { toEnum, toMarkdown, toSecret, type UserText } from '#core/text';
import { MAX_AUTOCOMPLETE_CHOICES, type AutocompleteChoice } from '#core/module';
import type { GuildId, UserId } from '#core/ids';
import type { Audit } from '#core/ports/audit';
import { repoFullName, type RepoRef, type RepoScoped, type ReposPort } from '#core/ports/repos';
import {
  classifyCredential,
  toSecretName,
  userEnvironmentName,
  type EnvironmentName,
  type SecretName,
  type Secrets,
} from '#core/ports/secrets';

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

/**
 * ONE REPOSITORY'S credential store: `set`, `status` and `clear` against that repository's
 * `Secrets`. This is the whole of what the module did before RFC-001 PR 2.3, unchanged except
 * that every audit row now names the repository (`repo: 'owner/repo'`, RFC-001 8.3).
 * `CredentialService`, below, decides WHICH repository and hands the command to one of these.
 */
export class RepositoryCredentials {
  private readonly secrets: Secrets;
  private readonly audit: Audit;
  /** `owner/repo`, as configured: the `repo` field of every audit row this store writes. */
  private readonly repo: string;

  constructor(secrets: Secrets, audit: Audit, repo: string) {
    // Assigned explicitly: `erasableSyntaxOnly` rejects parameter properties (TS1294).
    this.secrets = secrets;
    this.audit = audit;
    this.repo = repo;
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
        detail: { reason: 'unrecognised-shape', repo: this.repo },
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
      detail: { secretName: name, supersededRemoved: cleared.ok ? cleared.value : null, repo: this.repo },
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
    this.audit.record({ action: 'credentials.clear', actorId, guildId, detail: { existed: removed.value, repo: this.repo } });
    return Ok(removed.value);
  }
}

// ---------------------------------------------------------------------------------------
// WHICH REPOSITORY (RFC-001 PR 2.3, section 8.1)
// ---------------------------------------------------------------------------------------
//
// GitHub environments are per repository, so a credential lives PER USER PER REPOSITORY:
// `user-<id>` must exist in whichever repository a build lands in. The rule for which one a
// command acts on is the rule for where that user's builds from the same place land:
//
//   - IN A SERVER: the server's repository, `ReposPort.target(guild)` - its `/repo use` link, else
//     the default. A server with neither, or linked to a repository the operator has since
//     removed, is refused with the PR 2.2 sentences: never "some other repository", because a
//     credential is money and which repository holds it is the operator's trust decision.
//   - IN A DM: with one repository, that one; with several, `/credentials set` needs `repo:`, and
//     `status` and `clear` cover every repository.
//
// NO `all:` ON `set` (RFC-001 8.1, "Resolved"): storing a credential in repositories the user has
// never built in widens its exposure for no request they made.

/** The part of `ReposPort` this module reads. Synchronous, so `set` can resolve before its modal. */
export type CredentialRepos = Pick<ReposPort, 'all' | 'target' | 'byKey'>;

/** A repository as the views print it. Configuration, never user text. */
export interface RepoLabel {
  readonly key: string;
  /** `owner/repo`, as configured. */
  readonly fullName: string;
}

export function labelOf(repo: RepoRef): RepoLabel {
  return { key: repo.key, fullName: repoFullName(repo) };
}

/**
 * The PR 2.2 refusal for a server with no `/repo use` link and no default repository, in the
 * words RFC-001 8.1 gives it for credentials. A `config` error, like the builder's: the user is
 * told to fetch an admin, and the operator reads this sentence and the next step.
 */
export function unlinkedServerError(): AppError {
  return errors.config(
    'repos.unmapped',
    'This server is not linked to a repository yet, so there is nowhere to store a credential for it.',
    'Ask the bot operator to run /repo use in this server.',
  );
}

/**
 * The PR 2.2 refusal for a server linked to a repository the operator has REMOVED. Not the
 * default instead: a credential must not land in a repository nobody chose for this server.
 */
export function staleServerLinkError(key: string): AppError {
  return errors.config(
    'repos.stale_link',
    `This server is linked to the repository ${key}, which this bot is no longer configured for, so there is nowhere to store a credential for it.`,
    `Ask the bot operator to run /repo use in this server, or to add ${key} back to GITHUB_REPOS_JSON.`,
  );
}

/** A DM `/credentials set` on a bot with several repositories, without `repo:`. */
export function repoChoiceRequiredError(keys: readonly string[]): AppError {
  return errors.validation(
    'repo',
    'This bot keeps credentials in more than one repository, so in a direct message you have to say which one.',
    `Run /credentials set again with repo: set to one of: ${keys.join(', ')}.`,
  );
}

/** `repo:` naming something that is not configured. Keys only: they are what autocomplete offers. */
export function unknownRepoChoiceError(keys: readonly string[]): AppError {
  return errors.validation('repo', 'That is not a repository this bot is configured for.', `Pick one of: ${keys.join(', ')}.`);
}

/**
 * `repo:` in a SERVER naming a repository other than the server's. Refused rather than obeyed or
 * ignored: in a server the credential goes where that server's builds go (RFC-001 8.1), and
 * silently storing it somewhere other than where the user typed would be the one dishonest answer.
 */
export function otherRepoInServerError(server: RepoRef): AppError {
  return errors.validation(
    'repo',
    `This server's builds use the repository ${server.key}, so a credential set here goes there.`,
    'Leave repo: empty, or run /credentials set in a direct message with the bot to choose a repository.',
  );
}

/**
 * The modal was opened for one repository and submitted after the server was re-linked to
 * another. Refused: the modal NAMED the first one, and that is what the user agreed to.
 */
export function repoChangedError(): AppError {
  return errors.conflict(
    'repo',
    "This server's repository changed while the form was open, so the credential was not stored.",
    'Run /credentials set again.',
  );
}

/** Where one `/credentials set` goes. */
export interface CredentialTarget {
  readonly repo: RepoRef;
  /** In a server the repository is the server's; in a DM it is the user's choice (or the only one). */
  readonly inServer: boolean;
}

/** `set`'s answer: the secret name, and the repository when there is more than one to tell apart. */
export interface StoredCredential {
  readonly name: SecretName;
  readonly repo: RepoLabel | null;
}

/** One repository's row of a DM `/credentials status`. `names` is null when it could not be read. */
export interface RepoStatusRow {
  readonly repo: RepoLabel;
  readonly names: readonly SecretName[] | null;
  readonly problem: string | null;
}

/**
 * `status`: ONE repository (a server's, or the only one), or EACH (a DM on a bot with several).
 * `repo` is null on a one-repository install, whose views are exactly what they were.
 */
export type StatusReport =
  | { readonly kind: 'one'; readonly repo: RepoLabel | null; readonly status: CredentialStatus }
  | { readonly kind: 'each'; readonly rows: readonly RepoStatusRow[] };

/** One repository's row of `clear everywhere`: `existed` keeps today's true/false; null = failed. */
export interface RepoClearRow {
  readonly repo: RepoLabel;
  readonly existed: boolean | null;
  readonly problem: string | null;
}

export type ClearReport =
  | { readonly kind: 'one'; readonly repo: RepoLabel | null; readonly existed: boolean }
  | { readonly kind: 'each'; readonly rows: readonly RepoClearRow[] };

/** The repositories one `status` or `clear` covers. */
type Scope = { readonly kind: 'one'; readonly repo: RepoRef } | { readonly kind: 'each'; readonly repos: readonly RepoRef[] };

/** Discord caps an autocomplete choice name. */
const CHOICE_NAME_MAX = 100;

/**
 * The module's service: decides WHICH repository, then hands the command to that repository's
 * `RepositoryCredentials`.
 */
export class CredentialService {
  private readonly repos: CredentialRepos;
  private readonly secrets: RepoScoped<Secrets>;
  private readonly audit: Audit;

  constructor(repos: CredentialRepos, secrets: RepoScoped<Secrets>, audit: Audit) {
    this.repos = repos;
    this.secrets = secrets;
    this.audit = audit;
  }

  /** More than one repository: views name the repository, and a DM `set` must choose one. */
  isMultiRepo(): boolean {
    return this.repos.all().length > 1;
  }

  /** The configured keys, in configuration order: the allow-list `repo:` is checked against. */
  keys(): readonly string[] {
    return this.repos.all().map((r) => r.key);
  }

  /**
   * Autocomplete for `repo:`. KEYS ONLY, never `owner/repo`, for the reason `/repo use` gives:
   * the router answers an autocomplete without checking the command's permission.
   */
  suggest(partial: UserText): readonly AutocompleteChoice[] {
    const q = toMarkdown(partial, { maxLength: CHOICE_NAME_MAX }).text.trim().toLowerCase();
    const out: AutocompleteChoice[] = [];
    for (const r of this.repos.all()) {
      if (out.length >= MAX_AUTOCOMPLETE_CHOICES) break;
      if (q.length > 0 && !r.key.includes(q)) continue;
      out.push({ name: r.isDefault ? `${r.key} (default)` : r.key, value: r.key });
    }
    return out;
  }

  /** What a view prints for a repository: null on a one-repository install, which says nothing new. */
  private label(repo: RepoRef): RepoLabel | null {
    return this.isMultiRepo() ? labelOf(repo) : null;
  }

  /** The server's repository, or the PR 2.2 refusal. */
  private serverRepo(guildId: GuildId): Result<RepoRef, AppError> {
    const t = this.repos.target(guildId);
    switch (t.kind) {
      case 'mapped':
      case 'default':
        return Ok(t.repo);
      case 'stale':
        return Err(staleServerLinkError(t.key));
      case 'none':
        return Err(unlinkedServerError());
      default: {
        const exhaustive: never = t;
        void exhaustive;
        return Err(unlinkedServerError());
      }
    }
  }

  /** A DM: the named repository, else the only one, else refused. */
  private dmTarget(key: string | null): Result<CredentialTarget, AppError> {
    if (key === null) {
      const all = this.repos.all();
      const only = all.length === 1 ? all[0] : undefined;
      return only === undefined ? Err(repoChoiceRequiredError(this.keys())) : Ok({ repo: only, inServer: false });
    }
    const repo = this.repos.byKey(key);
    return repo === null ? Err(unknownRepoChoiceError(this.keys())) : Ok({ repo, inServer: false });
  }

  /** A server: its repository; a key naming another one is refused with `mismatch`. */
  private serverTarget(
    guildId: GuildId,
    key: string | null,
    mismatch: (server: RepoRef) => AppError,
  ): Result<CredentialTarget, AppError> {
    const server = this.serverRepo(guildId);
    if (!server.ok) return server;
    if (key !== null && key !== server.value.key) return Err(mismatch(server.value));
    return Ok({ repo: server.value, inServer: true });
  }

  /**
   * `/credentials set` OPENING ITS MODAL, so the modal can name the repository.
   * SYNCHRONOUS on purpose: that command is `ack: 'form'` and must not await before the modal.
   */
  openTarget(guildId: GuildId | null, chosen: UserText | undefined): Result<CredentialTarget, AppError> {
    let key: string | null = null;
    if (chosen !== undefined) {
      const parsed = toEnum(chosen, this.keys());
      if (!parsed.ok) return Err(unknownRepoChoiceError(this.keys()));
      key = parsed.value;
    }
    return guildId === null ? this.dmTarget(key) : this.serverTarget(guildId, key, otherRepoInServerError);
  }

  /**
   * THE MODAL CAME BACK. `carried` is the repository key the modal was opened for (from its
   * `custom_id`), or null for a modal opened before PR 2.3. Re-validated, never trusted: in a DM
   * it must still be configured, and in a server it must still be the server's repository - the
   * modal named it, so a re-link in between is refused rather than followed.
   */
  submitTarget(guildId: GuildId | null, carried: string | null): Result<CredentialTarget, AppError> {
    return guildId === null ? this.dmTarget(carried) : this.serverTarget(guildId, carried, repoChangedError);
  }

  private store(repo: RepoRef): Result<RepositoryCredentials, AppError> {
    const scoped = this.secrets.at(repo);
    if (!scoped.ok) return scoped;
    return Ok(new RepositoryCredentials(scoped.value, this.audit, repoFullName(repo)));
  }

  /** Seal into the target repository's `user-<id>` environment, and nowhere else. */
  async set(
    actorId: UserId,
    guildId: GuildId | null,
    target: CredentialTarget,
    submitted: UserText,
  ): Promise<Result<StoredCredential, AppError>> {
    const store = this.store(target.repo);
    if (!store.ok) return store;
    const stored = await store.value.set(actorId, guildId, submitted);
    if (!stored.ok) return stored;
    return Ok({ name: stored.value, repo: this.label(target.repo) });
  }

  /**
   * Which repositories a `status` or `clear` covers. A server: its own, unless `everywhere`. A
   * DM: every one - and with one repository that is the one, so a one-repository install is
   * exactly what it was.
   */
  private scope(guildId: GuildId | null, everywhere: boolean): Result<Scope, AppError> {
    if (guildId !== null && !everywhere) {
      const server = this.serverRepo(guildId);
      return server.ok ? Ok({ kind: 'one', repo: server.value }) : server;
    }
    const all = this.repos.all();
    const only = all.length === 1 ? all[0] : undefined;
    return Ok(only === undefined ? { kind: 'each', repos: all } : { kind: 'one', repo: only });
  }

  async status(actorId: UserId, guildId: GuildId | null): Promise<Result<StatusReport, AppError>> {
    const scope = this.scope(guildId, false);
    if (!scope.ok) return scope;
    if (scope.value.kind === 'one') {
      const repo = scope.value.repo;
      const store = this.store(repo);
      if (!store.ok) return store;
      const status = await store.value.status(actorId);
      return status.ok ? Ok({ kind: 'one', repo: this.label(repo), status: status.value }) : status;
    }
    // EVERY repository answers for itself: one unreadable repository is a row saying so, not a
    // failure that hides what the others hold.
    const rows: RepoStatusRow[] = [];
    for (const repo of scope.value.repos) {
      const store = this.store(repo);
      const status = store.ok ? await store.value.status(actorId) : store;
      rows.push(
        status.ok
          ? { repo: labelOf(repo), names: status.value.names, problem: null }
          : { repo: labelOf(repo), names: null, problem: userMessage(status.error) },
      );
    }
    return Ok({ kind: 'each', rows });
  }

  /**
   * `clear` in a server clears that server's repository; `everywhere` (implied in a DM) clears
   * every configured repository, each with its own audit row and its own true/false answer.
   */
  async clear(actorId: UserId, guildId: GuildId | null, everywhere: boolean): Promise<Result<ClearReport, AppError>> {
    const scope = this.scope(guildId, everywhere);
    if (!scope.ok) return scope;
    if (scope.value.kind === 'one') {
      const repo = scope.value.repo;
      const store = this.store(repo);
      if (!store.ok) return store;
      const removed = await store.value.clear(actorId, guildId);
      return removed.ok ? Ok({ kind: 'one', repo: this.label(repo), existed: removed.value }) : removed;
    }
    // Keep going past a failure: "forget my credential" must reach every repository it can, and
    // the view names the ones it could not.
    const rows: RepoClearRow[] = [];
    for (const repo of scope.value.repos) {
      const store = this.store(repo);
      const removed = store.ok ? await store.value.clear(actorId, guildId) : store;
      rows.push(
        removed.ok
          ? { repo: labelOf(repo), existed: removed.value, problem: null }
          : { repo: labelOf(repo), existed: null, problem: userMessage(removed.error) },
      );
    }
    return Ok({ kind: 'each', rows });
  }
}
