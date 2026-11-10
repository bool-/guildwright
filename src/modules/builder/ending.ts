/**
 * WHAT ACTUALLY HAPPENED TO A BUILD - decided from the facts, not from the run's conclusion.
 *
 * The run's green or red tick was the only input before, and it lies in both directions:
 *
 *   - RED WITH A PULL REQUEST. The agent opened the PR and then used up its turn budget, which
 *     the action reports as a failure. The requester was told "Build failed" about a PR that was
 *     sitting there ready to merge.
 *   - GREEN WITH NO PULL REQUEST. A push that failed inside the agent ends the run cleanly, and
 *     "no PR after a clean run" was read as a deliberate refusal - "the agent refused it on
 *     purpose" about an agent that had tried and been blocked.
 *
 * The workflow's report comment (`RunReport`) says which guard failed, why the agent stopped,
 * and what the agent itself said, so each ending can be named for what it is. A run with no
 * report - one dispatched by an older workflow - falls back to the conclusion and the PR.
 */

import { errors, type AppError } from '#core/errors';
import type { PrRef, RunReport } from '#core/ports';

export type Ending =
  /** A pull request the agent says is complete. */
  | { readonly kind: 'pr-ready'; readonly pr: PrRef; readonly summary: string | null }
  /** A pull request exists, but the agent did not finish; `why` is ours, `remaining` is the agent's. */
  | { readonly kind: 'pr-unfinished'; readonly pr: PrRef; readonly why: string; readonly remaining: string | null }
  /** The agent touched a forbidden path. The PR, if any, must not be merged. */
  | { readonly kind: 'blocked'; readonly pr: PrRef | null }
  /** The agent declined on purpose; `reason` is its own explanation. */
  | { readonly kind: 'refused'; readonly reason: string | null }
  | { readonly kind: 'failed'; readonly error: AppError }
  /** A clean run with no PR and no report: the PR may still be a moment away. */
  | { readonly kind: 'no-pr-yet' };

/** Model-written text that says nothing is treated as absent, so a card never shows an empty field. */
function said(text: string | undefined): string | null {
  const t = text?.trim() ?? '';
  return t === '' ? null : t;
}

function turnLimitHit(report: RunReport | null): boolean {
  return report?.stop === 'error_max_turns';
}

/** "all 150 of its turns", or "its turns" when the count is missing. */
function allTurns(report: RunReport | null): string {
  const turns = report?.turns ?? null;
  return turns === null ? 'its turns' : `all ${String(turns)} of its turns`;
}

export function classifyEnding(input: {
  readonly runSucceeded: boolean;
  readonly pr: PrRef | null;
  readonly report: RunReport | null;
}): Ending {
  const { runSucceeded, pr, report } = input;
  const agent = report?.agent ?? null;

  if (report?.failedStep === 'forbidden_path') return { kind: 'blocked', pr };

  if (pr !== null) {
    const complete = report === null ? runSucceeded && !pr.isDraft : agent?.status === 'done' && report.stop === 'success' && !pr.isDraft;
    if (complete) return { kind: 'pr-ready', pr, summary: said(agent?.summary) };
    const why = turnLimitHit(report)
      ? `The agent used ${allTurns(report)} before finishing.`
      : pr.isDraft
        ? 'The agent opened it as a draft because it could not finish.'
        : agent?.status === 'partial'
          ? 'The agent says it is not finished.'
          : 'The agent stopped with an error after opening it.';
    return { kind: 'pr-unfinished', pr, why, remaining: said(agent?.remaining) };
  }

  if (agent?.status === 'refused') return { kind: 'refused', reason: said(agent.remaining) ?? said(agent.summary) };
  if (report === null && runSucceeded) return { kind: 'no-pr-yet' };
  return { kind: 'failed', error: failureError(report) };
}

/**
 * A clean run with no PR from a workflow that posted no report. Deliberately not "refused": only
 * the agent's own report can say that, and guessing it is how a blocked push became a refusal.
 */
export function noPrError(): AppError {
  return errors.conflict('run_no_pr', 'The run finished without opening a pull request.', 'Open the run log to see what happened, then run /request retry.', 'failed');
}

/** Why a run with no pull request failed, in the requester's terms. */
export function failureError(report: RunReport | null): AppError {
  const fail = (code: string, detail: string, next: string): AppError => errors.conflict(code, detail, next, 'failed');
  switch (report?.failedStep) {
    case 'approval':
      return fail('run_approval', 'GitHub could not verify the approval, so the build never started.', 'Ask an admin to check the approval key, then run /request retry.');
    case 'approval_expired':
      return fail('run_approval_expired', 'The repository refused this build because its approval was too old by the time the run started.', 'Run /request retry to get a fresh approval.');
    case 'approval_replayed':
      // Reached only when the bot could not find an earlier run of its own carrying this
      // approval - see the adoption branch in module.ts. What is left is somebody re-dispatching
      // a token they read out of a run log, which the workflow refused.
      return fail('run_approval_replayed', 'The repository refused this build because its approval had already been used by an earlier run.', 'Run /request retry to get a fresh approval. If nobody here retried it, tell an admin: someone re-dispatched an old approval by hand.');
    case 'credentials':
      return fail('run_credentials', 'Your GitHub environment has no Claude credential, so the build never started.', 'Run /credentials set, then /request retry.');
    case 'daily_cap':
      return fail('run_daily_cap', "Today's build cap was already used up, so the build never started.", 'Run /request retry after midnight UTC.');
    case 'setup':
      return fail('run_setup', 'The build machine failed while setting up, before the agent started.', 'Run /request retry. If it fails again, ask an admin to check the run log.');
    default:
      break;
  }
  if (turnLimitHit(report)) {
    return fail('run_turn_limit', `The agent used ${allTurns(report)} before opening a pull request.`, 'Split the request into smaller pieces, or run /request retry.');
  }
  if (report?.stop === 'success') {
    return fail('run_no_pr', 'The agent finished without opening a pull request.', 'The GitHub issue has its report. Run /request retry once you know why.');
  }
  if (report !== null && report.stop !== null) {
    return fail('run_agent_error', 'The agent stopped with an error before opening a pull request.', 'The GitHub issue has its report. Run /request retry once you know why.');
  }
  return fail('run_failed', 'The build failed before opening a pull request.', 'Open the run log to see what broke, then run /request retry.');
}
