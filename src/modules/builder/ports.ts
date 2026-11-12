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
import { DEFAULT_REPO_KEY, repoFullName } from '#core/ports';
import type { GuildId } from '#core/ids';
import type { BuildState } from '#modules/builder/rows';

// ---------------------------------------------------------------------------------------
// Which repository (RFC-001 PR 2.1 and PR 2.2)
// ---------------------------------------------------------------------------------------

/**
 * The GitHub side of the ports as the builder holds them: one `issues` and one `builds` PER
 * CONFIGURED REPOSITORY behind `.at(repo)`, and `repos` to say which. Generic over the port
 * shapes so a call site that needs only `close` can say so (`history.ts`).
 */
export interface GithubScopes<I, B> {
  readonly repos: Pick<ReposPort, 'target' | 'byKey' | 'all'>;
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
 * The refusal for a guild with no repository: no `/repo use` link and no default (RFC-001 7.3's
 * sentence, verbatim). With one repository this is unreachable - the shim's only repository is
 * the default.
 */
export function noBuildRepositoryError(): AppError {
  return errors.config(
    'repos.unmapped',
    'This server is not linked to a repository yet, so nothing can be built from it.',
    'Ask the bot operator to run /repo use in this server.',
  );
}

/**
 * The refusal for a guild linked to a repository the operator has since REMOVED from the set.
 *
 * NOT a fallback to the default repository: which repository a server builds in is the
 * operator's trust decision (RFC-001 7.2), so a removed one must not silently hand the server to
 * another of the operator's repositories.
 */
export function staleRepositoryLinkError(key: string): AppError {
  return errors.config(
    'repos.stale_link',
    `This server is linked to the repository ${key}, which this bot is no longer configured for, so nothing can be built from it.`,
    `Ask the bot operator to run /repo use in this server, or to add ${key} back to GITHUB_REPOS_JSON.`,
  );
}

/**
 * The refusal for a REQUEST whose persisted repository is no longer configured (RFC-001 7.3:
 * "retry ... refuses if the row's repo is no longer configured"). Every later step of such a
 * request refuses with it rather than acting anywhere else - an issue number means a different
 * issue in every repository.
 */
export function requestRepositoryGoneError(key: string): AppError {
  return errors.config(
    'repos.request_repo_gone',
    `This request was filed in the repository ${key}, which this bot is no longer configured for.`,
    `Ask the bot operator to add ${key} back to GITHUB_REPOS_JSON, or open a new request with /request new.`,
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
 * `ReposPort.target` is synchronous, so this is safe ahead of a `showModal` too.
 */
export function githubForGuild<I, B>(ports: GithubScopes<I, B>, guildId: GuildId): Result<RepoGithub<I, B>, AppError> {
  const target = ports.repos.target(guildId);
  switch (target.kind) {
    case 'mapped':
    case 'default':
      return scopeTo(ports, target.repo);
    case 'stale':
      return Err(staleRepositoryLinkError(target.key));
    case 'none':
      return Err(noBuildRepositoryError());
    default: {
      const exhaustive: never = target;
      void exhaustive;
      return Err(noBuildRepositoryError());
    }
  }
}

/**
 * THE REPOSITORY AN EXISTING ROW LIVES IN: every later step of a request (approve, dispatch,
 * poll, reject, cancel, retry, expire) calls `.at()` once, here.
 *
 * THE ROW'S OWN KEY, never the guild's current mapping (RFC-001 7.3). `/repo use` mid-build
 * therefore cannot move a poll, and `/request retry` re-resolves THIS key against the set as it
 * is now - refusing, rather than guessing, when the operator has removed it.
 */
export function githubForRow<I, B>(ports: GithubScopes<I, B>, row: { readonly repoKey: string }): Result<RepoGithub<I, B>, AppError> {
  const repo = ports.repos.byKey(row.repoKey);
  return repo === null ? Err(requestRepositoryGoneError(row.repoKey)) : scopeTo(ports, repo);
}

/**
 * `owner/repo` for a row's repository key, for a sentence (the per-repository cap refusal). The
 * bare key when the set no longer configures it: the sentence must still say something true.
 */
export function repositoryLabel(ports: { readonly repos: Pick<ReposPort, 'byKey'> }, key: string): string {
  const repo = ports.repos.byKey(key);
  return repo === null ? key : repoFullName(repo);
}

// ---------------------------------------------------------------------------------------
// Rows whose repository key is not configured: the boot adoption (RFC-001 PR 2.2)
// ---------------------------------------------------------------------------------------

/**
 * THE DECISION THE RFC LEFT OPEN, and the rule that settles it.
 *
 * Migration 0005 gives every existing row `repo_key = 'default'`, which is right for the
 * single-repository shim (it names its repository `default`) and wrong for an install whose
 * `GITHUB_REPOS_JSON` has no key `default` - including the operator who moves from the shim to
 * `GITHUB_REPOS_JSON` under a key like `main`. Left alone, those rows would be STRANDED: every
 * later step refuses them (`requestRepositoryGoneError`).
 *
 * THE RULE: a row whose key is not configured is re-keyed ONLY ON EVIDENCE THE ROW CARRIES.
 *
 *  1. Its issue URL names a configured repository (owner/repo, compared case-insensitively, as
 *     GitHub does) - so it moves to the repository its issue really is in. This settles the shim
 *     move, a 2.1 install that already used GITHUB_REPOS_JSON, and a key renamed in the JSON.
 *  2. It has NO issue URL (a submission mid-flight, or a row older than migration 0002), its key
 *     is `default`, and the set has a default repository - which is where the previous version
 *     acted on every row, so this changes nothing about where it lives.
 *
 * EVERYTHING ELSE IS LEFT EXACTLY AS IT IS - an issue URL naming a repository that is not
 * configured any more, or no evidence at all - and reported (boot log, audit, `/status`). It is
 * NOT re-keyed to "the default", because an issue number means a different issue in every
 * repository: approving, closing or reopening `#42` somewhere else is the one outcome worse than
 * refusing. And it does not refuse the boot either: nothing a stranded row can do spends money
 * (the dispatch pass fails it, finishing it and returning its slot), an unclicked one still
 * expires, and `/request cancel` still works on it - which a quarantined builder could not offer.
 */
export interface RepoKeyAdoption {
  readonly adopted: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly evidence: 'issue-url' | 'default-repository';
  }[];
  /** Rows left on a key this set does not configure. Their every later step refuses. */
  readonly stranded: readonly { readonly id: string; readonly repoKey: string; readonly state: BuildState }[];
}

/** `owner/repo` out of a GitHub issue URL, lowercased, or null. */
export function issueRepositoryOf(issueUrl: string): string | null {
  const m = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+\/?$/u.exec(issueUrl);
  return m === null ? null : `${m[1] ?? ''}/${m[2] ?? ''}`.toLowerCase();
}

/** Pure: decide, for every row on an unconfigured key, where (if anywhere) the evidence puts it. */
export function planRepoKeyAdoption(
  rows: readonly { readonly id: string; readonly repoKey: string; readonly issueUrl: string | null; readonly state: BuildState }[],
  refs: readonly RepoRef[],
): RepoKeyAdoption {
  const configured = new Set<string>(refs.map((r) => r.key));
  const byName = new Map(refs.map((r) => [repoFullName(r).toLowerCase(), r] as const));
  const dflt = refs.find((r) => r.isDefault) ?? null;
  const adopted: RepoKeyAdoption['adopted'][number][] = [];
  const stranded: RepoKeyAdoption['stranded'][number][] = [];
  for (const row of rows) {
    if (configured.has(row.repoKey)) continue;
    if (row.issueUrl !== null) {
      const named = issueRepositoryOf(row.issueUrl);
      const hit = named === null ? undefined : byName.get(named);
      if (hit !== undefined) adopted.push({ id: row.id, from: row.repoKey, to: hit.key, evidence: 'issue-url' });
      else stranded.push({ id: row.id, repoKey: row.repoKey, state: row.state });
      continue;
    }
    if (row.repoKey === DEFAULT_REPO_KEY && dflt !== null) {
      adopted.push({ id: row.id, from: row.repoKey, to: dflt.key, evidence: 'default-repository' });
      continue;
    }
    stranded.push({ id: row.id, repoKey: row.repoKey, state: row.state });
  }
  return { adopted, stranded };
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
