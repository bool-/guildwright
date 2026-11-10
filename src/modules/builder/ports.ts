/**
 * THE THREE PORT CALLS THIS ROUND NEEDS, AND WHAT IS LEFT OF THE BRIDGE THAT LET THEM LAND.
 *
 * `#core/ports` was written by another author in the same round. This module needed three
 * methods from it:
 *
 *   `BuildsPort.cancelRun(runId)`              so `/request cancel` stops the run it says it stops
 *   `IssuesPort.reopen(issueNumber)`           so `/request retry` does not re-arm a CLOSED issue
 *   `BuildsPort.repositoryVariable(name)`      so the bot can notice its cap and the repo's differ
 *
 * WHILE THAT WAS IN FLIGHT this file declared each of them as an OPTIONAL member of a companion
 * interface, so the module compiled against a port that did not have them yet and took an
 * honest degraded branch until it did. THE PORT HAS LANDED AND THE OPTIONALS ARE GONE, which is
 * the point of this note rather than a footnote to it:
 *
 *   AN OPTIONAL METHOD THAT RESOLVES TO "THE BOT CANNOT ASK" IS HOW A FIX SHIPS IN NAME ONLY.
 *   If `cancelRun` were renamed on the far side, an optional member would silently stop
 *   binding, `requestRunCancellation` would answer `unavailable`, and the card would say "the
 *   bot could not stop the run" - a plausible sentence, a passing test suite, and a build still
 *   spending the requester's credits. Required members make that a compile error instead.
 *
 * The third call is the one where the two sides had genuinely designed different things. This
 * file asked for `agentDailyRunCap(): Result<number | null>`; the port shipped
 * `repositoryVariable(name): Result<RepositoryVariable>`, a three-arm union. The port's shape
 * won, and it is better: `number | null` has no way to say `not-a-number`, and that arm is the
 * one that means every future build dies at the workflow's guard. See `DailyCapReading`.
 *
 * WHAT SURVIVES: the named companion interfaces, because a call site that says exactly which
 * methods it needs is easier to review than one handed the whole port - and the `Result` arms
 * below, which are this module's reading of what the answers MEAN, and are not the port's job.
 * Nothing here ever simulates an answer the port did not give.
 */

import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import { isJsonObject } from '#core/json';
import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { BuildsPort, IssuesPort, RepoRef, RepoScoped, ReposPort } from '#core/ports';
import { toGuildId, type GuildId } from '#core/ids';

// ---------------------------------------------------------------------------------------
// Which repository (RFC-001 PR 2.1)
// ---------------------------------------------------------------------------------------

/**
 * The GitHub side of the ports as the builder holds them: one `issues` and one `builds` PER
 * CONFIGURED REPOSITORY behind `.at(repo)`, and `repos` to say which. Generic over the port
 * shapes so a call site that needs only `close` can say so (`history.ts`).
 */
export interface GithubScopes<I, B> {
  readonly repos: Pick<ReposPort, 'resolve' | 'all'>;
  readonly issues: RepoScoped<I>;
  readonly builds: RepoScoped<B>;
}

/** One repository's ports, resolved: what every builder path then calls methods on. */
export interface RepoGithub<I, B> {
  readonly repo: RepoRef;
  readonly issues: I;
  readonly builds: B;
}

/**
 * The refusal for a guild with no repository (RFC-001 7.3's sentence). With one repository this
 * is unreachable - the shim's only repository is the default. With several and no
 * `"default": true`, nothing can be built until one is marked; the next step says how in THIS
 * version, because `/repo use` (guild routing) arrives with PR 2.2.
 */
export function noBuildRepositoryError(): AppError {
  return errors.config(
    'repos.unmapped',
    'This server is not linked to a repository yet, so nothing can be built from it.',
    'Ask the bot operator to mark one repository "default": true in GITHUB_REPOS_JSON.',
  );
}

/** `.at()` on both ports, for one ref. */
function scopeTo<I, B>(ports: GithubScopes<I, B>, repo: RepoRef): Result<RepoGithub<I, B>, AppError> {
  const issues = ports.issues.at(repo);
  if (!issues.ok) return issues;
  const builds = ports.builds.at(repo);
  if (!builds.ok) return builds;
  return Ok({ repo, issues: issues.value, builds: builds.value });
}

/**
 * THE FRONT DOOR'S REPOSITORY: where a NEW request from this guild is filed and built
 * (RFC-001 7.3: the guild's mapping, else the default repository, else refuse - nothing filed).
 * `ReposPort.resolve` is synchronous, so this is safe ahead of a `showModal` too.
 */
export function githubForGuild<I, B>(ports: GithubScopes<I, B>, guildId: GuildId): Result<RepoGithub<I, B>, AppError> {
  const repo = ports.repos.resolve(guildId);
  return repo === null ? Err(noBuildRepositoryError()) : scopeTo(ports, repo);
}

/**
 * THE REPOSITORY AN EXISTING ROW LIVES IN: every later step of a request (approve, dispatch,
 * poll, reject, cancel, retry, expire) calls `.at()` once, here.
 *
 * THE SEAM PR 2.2 FILLS. The row carries no repository key yet - `repo_key` is PR 2.2's
 * migration `0005_repo_key.sql`, which also makes a mapping change mid-build unable to move a
 * poll - so today this resolves the row's GUILD exactly as the front door did. That is the same
 * answer for the row's whole life, because in this version nothing can change it while the
 * process runs: there is no guild mapping, and the set and its default are static config.
 * PR 2.2 replaces the body with `repos.byKey(row.repoKey)` and keeps every caller.
 */
export function githubForRow<I, B>(ports: GithubScopes<I, B>, row: { readonly guildId: string }): Result<RepoGithub<I, B>, AppError> {
  const guildId = toGuildId(row.guildId);
  if (!guildId.ok) return guildId;
  return githubForGuild(ports, guildId.value);
}

/**
 * The repository `/status` and the boot cap check report on: the DEFAULT one, which in this
 * version is the only repository a build can land in. `null` with no default. Per-repository
 * caps and drift reporting across the set are PR 2.4.
 */
export function githubForDefault<I, B>(ports: GithubScopes<I, B>): Result<RepoGithub<I, B>, AppError> | null {
  const repo = ports.repos.all().find((r) => r.isDefault) ?? null;
  return repo === null ? null : scopeTo(ports, repo);
}

// ---------------------------------------------------------------------------------------
// Cancelling a workflow run
// ---------------------------------------------------------------------------------------

/**
 * WHAT GITHUB ANSWERS WHEN YOU ASK IT TO CANCEL A RUN, and both answers are ordinary.
 *
 * `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel` returns **202 Accepted** when the
 * cancellation was queued, and **409 Conflict** when the run is not in a cancellable state -
 * which, in practice, means it finished between the user pressing cancel and the request
 * arriving.
 *
 * THEY MEAN DIFFERENT THINGS TO THE PERSON READING THE CARD and must not be collapsed. 202 is
 * "it is stopping"; 409 is "it is over, and it may well have opened a pull request". Telling
 * somebody the second was the first is exactly the lie this round exists to remove.
 *
 * Neither is a promise. 202 is a REQUEST to GitHub: a step already executing runs to its end,
 * and a run that finished a second before the click cannot be recalled.
 */
export type RunCancellation =
  | { readonly kind: 'requested' }
  | { readonly kind: 'already-finished' };

/**
 * The `builds` port's cancel method, restated so this module's call site names one shape.
 *
 * IT IS REQUIRED, not optional. It shipped optional while `#core/ports` was still being written
 * so that this module could compile against a port that did not have it yet, taking an honest
 * degraded branch in the meantime. The port has landed; an optional member kept past that point
 * would mean a rename on the far side degrades to "the bot could not stop the run" - a
 * plausible, wrong sentence in front of a user - instead of failing the build.
 */
export interface CancelsRuns {
  cancelRun(runId: number): Promise<Result<RunCancellation, AppError>>;
}

/**
 * What a caller learns from asking. FOUR arms, because there are four different sentences a
 * requester deserves and only one of them is "we stopped it".
 */
export type RunCancelReport =
  /** 202. GitHub took the request. */
  | { readonly kind: 'requested' }
  /** 409. The run was already over. */
  | { readonly kind: 'already-finished' }
  /**
   * THERE IS NOTHING TO ASK ABOUT: the row holds no run id, so no cancel call can name a run.
   *
   * This used to also mean "this build has no such port method", which stopped being possible
   * when `BuildsPort.cancelRun` became required. The remaining meaning is the real one and it
   * is reached from `stopTheRun`: a request still in `dispatching` may or may not have created
   * a workflow run, and a request that never dispatched certainly has not.
   */
  | { readonly kind: 'unavailable' }
  /** We asked and the call failed: a network blip, a token without `actions: write`. */
  | { readonly kind: 'refused'; readonly error: AppError };

/**
 * Ask GitHub to stop a run, and report honestly what came back.
 *
 * WHY THE `conflict` ERROR ARM IS ALSO "already finished": if the port ever chooses to model
 * 409 as an `Err(errors.conflict(...))` rather than an `Ok` arm, the user-visible answer is
 * identical and should not depend on which side of the `Result` the adapter put it. Every other
 * failure stays a failure, because "we could not reach GitHub" and "the run was over" are not
 * the same news.
 */
export async function requestRunCancellation(builds: CancelsRuns, runId: number): Promise<RunCancelReport> {
  const answered = await builds.cancelRun(runId);
  if (!answered.ok) {
    return answered.error.kind === 'conflict' ? { kind: 'already-finished' } : { kind: 'refused', error: answered.error };
  }
  return cancellationKind(answered.value) === 'already-finished' ? { kind: 'already-finished' } : { kind: 'requested' };
}

/**
 * Read the arm, TOLERANTLY - the same discipline as `readPrDraft`.
 *
 * The declared type says this is exhaustive. The runtime value crossed a port boundary that is
 * still being built, so the ONE fact worth defending is that an unrecognised shape must not be
 * reported as "already finished" - that is the arm which tells somebody to stop worrying about a
 * run. Anything unrecognised therefore reads as "we asked", whose wording already says the
 * outcome is not guaranteed.
 */
function cancellationKind(value: RunCancellation): 'requested' | 'already-finished' {
  const raw: unknown = value;
  if (isJsonObject(raw) && raw['kind'] === 'already-finished') return 'already-finished';
  return 'requested';
}

// ---------------------------------------------------------------------------------------
// Reopening an issue
// ---------------------------------------------------------------------------------------

/** The `issues` port's reopen method. REQUIRED, for the reason given on `CancelsRuns`. */
export interface ReopensIssues {
  reopen(issueNumber: number): Promise<Result<void, AppError>>;
}

/**
 * Whether the issue behind a re-armed request is OPEN again.
 *
 * TWO ARMS ONLY. There used to be an `unavailable` for "this build has no such port method",
 * which stopped being a state that can occur the moment `IssuesPort.reopen` became required.
 * A failure here is always a call that was made and rejected - a token scope, or GitHub - and
 * that is a thing an operator can act on.
 */
export type IssueReopenReport =
  | { readonly kind: 'reopened' }
  | { readonly kind: 'failed'; readonly error: AppError };

/**
 * Put a closed issue back into the open state.
 *
 * WHY IT MATTERS ENOUGH TO BE ITS OWN CALL: expiry closes the issue `not_planned`. `/request
 * retry` on an expired request then draws a fresh Approve/Reject card - so an approver is asked
 * to authorise spend against an issue GitHub is showing as closed and not planned, and the agent
 * would be handed the same. Re-arming without this is the product stating something untrue in
 * the one place a reviewer goes to check.
 *
 * A failure is NEVER fatal to the retry. The state change is what governs spend and it has
 * already committed; the worst case is a closed issue that a card admits is closed.
 */
export async function reopenIssue(issues: ReopensIssues, issueNumber: number): Promise<IssueReopenReport> {
  const answered = await issues.reopen(issueNumber);
  return answered.ok ? { kind: 'reopened' } : { kind: 'failed', error: answered.error };
}

// ---------------------------------------------------------------------------------------
// Reading the repository's own daily cap
// ---------------------------------------------------------------------------------------

/**
 * The repository variable the workflow's own cap step reads.
 *
 * Spelled once, here, because the adapter turns it into a REST path segment and the workflow
 * spells it in YAML: three copies of a name is two chances to typo one into a permanent
 * "unset".
 */
export const AGENT_DAILY_RUN_CAP = 'AGENT_DAILY_RUN_CAP';

/**
 * What came back, before any comparison is made.
 *
 * FOUR ARMS, AND `not-a-number` IS THE ONE THE INTEGRATION ADDED. The bridge this file used to
 * carry asked the port for `number | null`, which has no way to say "the operator set it to
 * `4.0`". The port that actually landed answers a three-arm `RepositoryVariable`, and the third
 * arm matters more than either of the others: the workflow guards with
 * `case "$DAILY_CAP" in ''|*[!0-9]*) ... exit 1`, so a value like ` 4 `, `4.0`, `+4` or `four`
 * does not mean "a cap we disagree with" - it means EVERY FUTURE BUILD dies in its first
 * seconds, with the reason living only in an Actions log nobody is reading. Collapsing it into
 * `unset` would have reported a healthy repository.
 */
export type DailyCapReading =
  | { readonly kind: 'set'; readonly cap: number }
  /** No such variable. The workflow's own literal default applies - this is not an error. */
  | { readonly kind: 'unset' }
  /** Set to something the workflow's guard will reject outright. Every build dies. */
  | { readonly kind: 'not-a-number' }
  /** We asked and could not find out - a network blip, or a token without `Variables: read`. */
  | { readonly kind: 'failed'; readonly error: AppError };

/**
 * Read the repository variable, or say why not. Never throws, never guesses a number.
 *
 * IT TAKES THE WHOLE `BuildsPort` AND CALLS A REQUIRED METHOD. The optional-companion bridge
 * that used to live here existed so this module could land before `#core/ports` did; the port
 * has landed, so the bridge is gone. That is not tidying — an OPTIONAL method that silently
 * resolves to "the bot cannot ask" is exactly how this check could have shipped green and never
 * fired in production, because a rename on the far side would degrade instead of failing to
 * compile. Required is what makes drift a red build.
 */
export async function readAgentDailyRunCap(builds: BuildsPort): Promise<DailyCapReading> {
  const answered = await builds.repositoryVariable(AGENT_DAILY_RUN_CAP);
  if (!answered.ok) return { kind: 'failed', error: answered.error };
  switch (answered.value.kind) {
    case 'number':
      return { kind: 'set', cap: answered.value.value };
    case 'unset':
      return { kind: 'unset' };
    case 'not-a-number':
      return { kind: 'not-a-number' };
    default: {
      const exhaustive: never = answered.value;
      void exhaustive;
      return { kind: 'unset' };
    }
  }
}

// ---------------------------------------------------------------------------------------
// The narrowed port shapes the call sites take
// ---------------------------------------------------------------------------------------

/**
 * `ctx.ports.builds`, narrowed at the call sites.
 *
 * Now that every method is on `BuildsPort` itself this is an alias, kept so the call sites keep
 * naming what they need rather than the whole port.
 */
export type BuildsWithCancel = BuildsPort & CancelsRuns;

/** `ctx.ports.issues`, plus reopen. */
export type IssuesWithReopen = IssuesPort & ReopensIssues;
