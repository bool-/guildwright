/**
 * THE BOOT-TIME GITHUB PREFLIGHT. Three reads, once, before the bot says "ready".
 *
 * THE HOLE IT CLOSES. Boot validates config, opens the database, installs modules, logs in to
 * Discord and REFUSES TO START on a bad `DISCORD_TOKEN` - and then never makes a single GitHub
 * call. So the GitHub half of the configuration is unverified at the moment the bot reports
 * healthy, and an expired PAT, a `GITHUB_REF` pointing at a branch somebody deleted, or a
 * `GITHUB_WORKFLOW_FILE` renamed in a refactor all survive boot untouched.
 *
 * What that costs, precisely: the first person to learn is a user who clicked Approve. The
 * dispatch path collapses every error into a retry with a deadline hours out, so the card says
 * "building..." and, six hours later, "it timed out" - about a build that never started, for a
 * reason nobody was told, on a bot the operator watched come up clean. One expired token can
 * eat a day of that.
 *
 * WHY THIS IS NOT A `health()` CHECK, AND MUST NOT BECOME ONE. `/status` is polled, and health
 * checks are polled hardest exactly when something is wrong. A health check that spends the
 * same rate-limit budget as the feature it reports on can take the feature down during the
 * incident it exists to surface - the bot burns its remaining quota answering "am I ok?" and
 * every real dispatch gets a 429. This runs ONCE, at boot, where the answer is actionable
 * (restart with a fixed value) and the cost is three requests per process lifetime.
 *
 * WHAT IS FATAL AND WHAT IS NOT - the line, and why it is drawn there:
 *
 *   401        FATAL, on every probe. Nothing this bot does works without a valid credential.
 *
 *   404        FATAL on the repository and on the workflow file. Both are answered by
 *              permissions the bot already cannot work without - Metadata is mandatory on every
 *              fine-grained PAT, and Actions read is what the poller uses on every build - so a
 *              404 there really does mean a value in the environment is wrong, and it will stay
 *              wrong until somebody edits it and restarts.
 *
 *              NOT fatal on the REF, and that asymmetry is deliberate. Resolving a ref needs the
 *              **Contents** permission, and nothing else in this bot needs it (a dispatch needs
 *              Actions write). So a token that has been dispatching builds happily for months
 *              can 404 here, and refusing to start on that would take down a working bot to
 *              report a guess. It earns a loud warning naming BOTH possible causes instead.
 *
 *   403, 429, 5xx, and a network failure   NOT FATAL, loudly warned. None of them is evidence
 *              of a misconfiguration: GitHub has outages, and a rate limit at boot says only
 *              that somebody else was busy a minute ago. Refusing to start would mean a GitHub
 *              incident takes `/tags` and `/help` down with it, and - worse - a bot in a
 *              restart loop hammers the API that is already limiting it.
 *
 * A 404 on a PRIVATE repository is a token-scope story, not a missing-repository story; GitHub
 * hides existence deliberately. Every sentence below says so, because "not found" sends an
 * operator hunting for a deleted repo for an hour.
 */

import type { Octokit } from 'octokit';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { redactSecrets } from '#core/text';
import type { GitRef, LoggerPort, WorkflowFile } from '#core/ports';
import { GithubAuthFailure, readGithubFailure, type GithubRepo } from '#adapters/github/client';

// ---------------------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------------------

/**
 * The response header a FINE-GRAINED personal access token comes back with.
 *
 * Classic PATs and GitHub App installation tokens do not send it, so its absence is not a
 * finding - it is simply "this credential does not advertise an expiry".
 */
export const TOKEN_EXPIRY_HEADER = 'github-authentication-token-expiration';

/** How close to expiry is close enough to say something. Two weeks is one holiday. */
export const TOKEN_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * `2026-03-10 15:04:05 UTC` -> epoch ms.
 *
 * WHY IT IS PARSED BY HAND rather than handed to `Date.parse`: GitHub's format is a space
 * separator and a bare `UTC` suffix, which is NOT ISO-8601, and `Date.parse` on a non-ISO
 * string is implementation-defined - V8 accepts it today, and a warning that silently stops
 * working on a runtime upgrade is worse than no warning. The value is normalised into a real
 * ISO instant first, and only a value this function recognises produces a number.
 *
 * An unrecognised or absent header is `null`, which downstream means "say nothing". A header we
 * cannot read is not evidence that a token is expiring.
 */
export function parseTokenExpiry(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*(UTC|Z|[+-]\d{2}:?\d{2}))?$/u.exec(raw.trim());
  if (match === null) return null;
  const [, date, time, zoneRaw] = match;
  const zone = zoneRaw === undefined || zoneRaw === 'UTC' ? 'Z' : zoneRaw;
  // `+0100` is legal in GitHub's output and illegal in ISO-8601's extended form.
  const iso = `${date ?? ''}T${time ?? ''}${/^[+-]\d{4}$/u.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days remaining, rounded down; negative once the token has already expired. */
export function daysUntil(expiresAtMs: number, nowMs: number): number {
  return Math.floor((expiresAtMs - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * The one sentence an operator gets about an expiring credential, or `null` for silence.
 *
 * WHY AN ALREADY-EXPIRED TOKEN IS STILL ONLY A WARNING HERE: if it were truly expired the
 * requests below would have answered 401, and 401 is fatal. Reaching this line with a past
 * date means the header and the API disagree - a clock skew, or a header cached by a proxy -
 * and the API is the authority. Saying so is useful; refusing to boot on it is not.
 */
export function tokenExpiryWarning(expiresAtMs: number | null, nowMs: number): string | null {
  if (expiresAtMs === null) return null;
  const days = daysUntil(expiresAtMs, nowMs);
  if (days > TOKEN_EXPIRY_WARN_MS / (24 * 60 * 60 * 1000)) return null;
  const when = new Date(expiresAtMs).toISOString();
  if (days < 0) {
    return `GITHUB_TOKEN reports an expiry that has already passed (${when}); GitHub still accepted it, so treat this as a clock or proxy problem and renew the token.`;
  }
  return `GITHUB_TOKEN expires in ${days} day(s), on ${when}. Renew it before then, or every build stops with a 401 that looks like GitHub being down.`;
}

// ---------------------------------------------------------------------------------------
// Wire shapes. Same posture as the rest of the adapter: nothing off the network is trusted.
// ---------------------------------------------------------------------------------------

const RepoPayload = z.object({
  full_name: z.string(),
  /** `false` when Issues are switched off, which makes `/request` impossible. */
  has_issues: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const WorkflowPayload = z.object({
  /** `active`, `disabled_manually`, `disabled_inactivity`, `disabled_fork`. */
  state: z.string(),
  path: z.string().optional(),
});

// ---------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------

/** What a successful preflight learned. Everything here is safe to log. */
export interface GithubPreflightReport {
  /** `owner/repo` as GitHub spells it, which is how a typo in the CASE of a name shows up. */
  readonly fullName: string;
  /** The workflow's own state. Anything but `active` means a dispatch will be refused. */
  readonly workflowState: string;
  /** Epoch ms from the fine-grained-PAT expiry header, or `null` for a token without one. */
  readonly tokenExpiresAtMs: number | null;
  /**
   * Non-fatal findings, in the order they were discovered. Each is one finished sentence
   * addressed to the operator; the caller decides how loudly to print them.
   */
  readonly warnings: readonly string[];
}

/** Everything the preflight needs. It borrows the SHARED client, never builds its own. */
export interface GithubPreflightInput {
  readonly octokit: Octokit;
  readonly repo: GithubRepo;
  /** From config, already branded, so this cannot be asked about a free-text file name. */
  readonly workflowFile: WorkflowFile;
  /** From config, likewise branded. */
  readonly ref: GitRef;
  /** Wall clock, for the expiry arithmetic. Injected so the warning is testable. */
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------------------

/**
 * Turn one failed probe into either a fatal `ConfigError` or a warning sentence.
 *
 * `location` is the ENVIRONMENT VARIABLE an operator would edit, because a boot failure whose
 * `where:` line names a REST endpoint tells them nothing they can act on.
 *
 * NOTHING READ OFF THE ERROR REACHES A SENTENCE. Only the status code selects wording, exactly
 * as in `mapGithubError`; an octokit error carries `request.headers.authorization`, and the one
 * hand-built line that mentions the failure at all goes through `redactSecrets` on its way into
 * `internal`.
 */
export function classifyPreflightFailure(input: {
  readonly cause: unknown;
  readonly nowMs: number;
  /** The env var to blame, e.g. `GITHUB_REPO`. */
  readonly location: string;
  /** Developer-authored, e.g. `preflight.repo`. Never user text. */
  readonly operation: string;
  /** What a 404 means for THIS probe, as a finished imperative. */
  readonly notFoundNextStep: string;
  /**
   * Whether a 404 on THIS probe is proof enough to refuse the boot.
   *
   * True for the repository and the workflow file: both are answered by permissions the bot
   * already cannot work without (Metadata is mandatory on every fine-grained PAT, and Actions
   * read is what the poller uses on every build), so a 404 there really does mean the value is
   * wrong.
   *
   * FALSE FOR THE REF, and that asymmetry is the whole reason this flag exists. Resolving a ref
   * needs the **Contents** permission, which nothing else in this bot requires - a dispatch
   * needs Actions write, not Contents. So a token that works perfectly today can 404 here, and
   * making that fatal would refuse to start a bot that has been running fine. An ambiguous
   * answer earns a loud warning, not a refusal.
   */
  readonly notFoundIsFatal: boolean;
}): { readonly fatal: AppError } | { readonly warning: string } {
  // An App uninstalled between the auth check and this probe: already a finished sentence, and
  // fatal for the same reason an installation 404 at boot is (RFC-001 6.5).
  if (input.cause instanceof GithubAuthFailure) return { fatal: input.cause.appError };
  const failure = readGithubFailure(input.cause, input.nowMs);
  const internal = redactSecrets(
    `${input.operation}: ${failure.name} status=${failure.status}${failure.codes.length > 0 ? ` codes=${failure.codes.join(',')}` : ''}`,
  );

  if (failure.status === 401) {
    return {
      fatal: errors.config(
        'GITHUB_TOKEN',
        `${internal} - GitHub rejected the credential`,
        'GITHUB_TOKEN is expired, revoked, or malformed. Issue a new token with repository access to contents, issues, actions and environments, set it, and restart.',
      ),
    };
  }
  if (failure.status === 404) {
    return input.notFoundIsFatal
      ? { fatal: errors.config(input.location, internal, input.notFoundNextStep) }
      : { warning: `${input.location}: ${input.notFoundNextStep}` };
  }
  if (failure.status === 0) {
    return {
      warning: `could not reach GitHub during the boot preflight (${input.operation}); the bot is starting anyway, but no build can run until GitHub is reachable`,
    };
  }
  return {
    warning: `GitHub answered ${failure.status} during the boot preflight (${input.operation}); the bot is starting anyway, but this is unverified. If builds fail, check GITHUB_TOKEN's repository permissions.`,
  };
}

/** Anything but `active` means `workflow_dispatch` is refused, with a 403 that says nothing. */
export function workflowStateWarning(state: string, workflowFile: string): string | null {
  if (state === 'active') return null;
  return `the workflow ${workflowFile} is "${state}", not "active", so GitHub will refuse every dispatch. Re-enable it on the repository's Actions tab; no restart is needed once you have.`;
}

// ---------------------------------------------------------------------------------------
// The preflight itself
// ---------------------------------------------------------------------------------------

/**
 * Three reads: the repository, the workflow file, and the ref that will be dispatched.
 *
 * WHY THE REF IS CHECKED TOO, when the obvious pair is repo + workflow: `GITHUB_REF` is the
 * third value that silently breaks every dispatch and is invisible until somebody approves
 * one. `GET /repos/{owner}/{repo}/commits/{ref}` resolves a branch, a tag or a SHA - exactly
 * the set `workflow_dispatch` itself accepts - so this probe answers the same question the
 * dispatch will, hours earlier, for one request.
 *
 * The calls are SEQUENTIAL and stop at the first fatal answer. Running them together would
 * report three failures for one cause (an expired token 401s on all three) and would spend
 * three requests to say one thing.
 */
export async function preflightGithub(
  input: GithubPreflightInput,
): Promise<Result<GithubPreflightReport, AppError>> {
  const { octokit, nowMs } = input;
  const { owner, repo } = input.repo;
  const warnings: string[] = [];
  /** WHY a box and not a `let`: it is written from inside a closure, and a `let` written that
   *  way reads back with the narrowing it had at its declaration. */
  const expiry: { value: number | null } = { value: null };

  /** Read the fine-grained-PAT expiry off whichever response arrived first. */
  const noteExpiry = (headers: Readonly<Record<string, unknown>>): void => {
    if (expiry.value !== null) return;
    const raw = headers[TOKEN_EXPIRY_HEADER];
    expiry.value = parseTokenExpiry(typeof raw === 'string' ? raw : null);
  };

  // --- 1. the repository ------------------------------------------------------------------
  let fullName = `${owner}/${repo}`;
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    noteExpiry(res.headers);
    const parsed = RepoPayload.safeParse(res.data);
    if (parsed.success) {
      fullName = parsed.data.full_name;
      // A NOTICE, NOT A FAULT. GitHub's REST paths are case-insensitive, so a mis-cased `.env`
      // has always worked - but the approval token now signs the repository name, and the
      // verifier reads `$GITHUB_REPOSITORY` in GitHub's own case. The adapter signs with THIS
      // value rather than the configured pair, which is why this is only worth a line.
      if (fullName !== `${owner}/${repo}` && fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase()) {
        warnings.push(
          `GITHUB_OWNER/GITHUB_REPO is spelled ${owner}/${repo} but GitHub spells it ${fullName}. Approval tokens are signed with GitHub's spelling, so nothing is broken; fixing .env removes this notice.`,
        );
      }
      if (parsed.data.has_issues === false) {
        warnings.push(
          `Issues are disabled on ${fullName}, so /request cannot file one. Enable Issues in the repository settings.`,
        );
      }
      if (parsed.data.archived === true) {
        warnings.push(`${fullName} is archived, so no build can push a branch or open a pull request.`);
      }
    }
  } catch (cause: unknown) {
    const verdict = classifyPreflightFailure({
      cause,
      nowMs,
      location: 'GITHUB_OWNER/GITHUB_REPO',
      operation: 'preflight.repo',
      notFoundNextStep: `GitHub cannot see a repository called ${owner}/${repo}. On a private repository that usually means GITHUB_TOKEN has no access to it rather than that it is missing: check GITHUB_OWNER, GITHUB_REPO, and the token's repository access, then restart.`,
      // Metadata read is mandatory on every fine-grained PAT, so a 404 here is unambiguous:
      // either the name is wrong or the token cannot see the repository. Both are fatal.
      notFoundIsFatal: true,
    });
    if ('fatal' in verdict) return Err(verdict.fatal);
    warnings.push(verdict.warning);
    // The repository probe is the one every later probe depends on. If it could not be
    // answered for a transient reason, the other two would only repeat the same story.
    return Ok({ fullName, workflowState: 'unknown', tokenExpiresAtMs: expiry.value, warnings: [...warnings] });
  }

  // --- 2. the workflow file ---------------------------------------------------------------
  let workflowState = 'unknown';
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', {
      owner,
      repo,
      workflow_id: input.workflowFile,
    });
    noteExpiry(res.headers);
    const parsed = WorkflowPayload.safeParse(res.data);
    if (parsed.success) {
      workflowState = parsed.data.state;
      const stateWarning = workflowStateWarning(parsed.data.state, input.workflowFile);
      if (stateWarning !== null) warnings.push(stateWarning);
    }
  } catch (cause: unknown) {
    const verdict = classifyPreflightFailure({
      cause,
      nowMs,
      location: 'GITHUB_WORKFLOW_FILE',
      operation: 'preflight.workflow',
      notFoundNextStep: `${owner}/${repo} has no workflow file called ${input.workflowFile} on its default branch. Set GITHUB_WORKFLOW_FILE to a file that exists under .github/workflows/ and restart. If the file IS there, GITHUB_TOKEN is missing the repository Actions permission - which the build poller needs on every build anyway.`,
      // The poller reads GET /actions/runs on every single build, so a token that cannot answer
      // this cannot run one either. Refusing to start is the honest answer.
      notFoundIsFatal: true,
    });
    if ('fatal' in verdict) return Err(verdict.fatal);
    warnings.push(verdict.warning);
  }

  // --- 3. the ref that every dispatch will name -------------------------------------------
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      owner,
      repo,
      ref: input.ref,
    });
    noteExpiry(res.headers);
  } catch (cause: unknown) {
    const verdict = classifyPreflightFailure({
      cause,
      nowMs,
      location: 'GITHUB_REF',
      operation: 'preflight.ref',
      notFoundNextStep: `GitHub could not resolve "${input.ref}" in ${owner}/${repo}. Either GITHUB_REF names a branch or tag that no longer exists - every workflow dispatch is sent against it, so no build can start - or GITHUB_TOKEN lacks the repository Contents permission, which is the only thing in this bot that needs it. Check both.`,
      // NOT FATAL, and the asymmetry is deliberate. This probe cannot tell a wrong ref from a
      // token without Contents read, and nothing ELSE in the bot needs Contents: a dispatch
      // needs Actions write. Refusing to boot on an ambiguous answer would stop a bot that has
      // been working for months. Six hours earlier and loud beats confidently wrong.
      notFoundIsFatal: false,
    });
    if ('fatal' in verdict) return Err(verdict.fatal);
    warnings.push(verdict.warning);
  }

  const expiryWarning = tokenExpiryWarning(expiry.value, nowMs);
  if (expiryWarning !== null) warnings.push(expiryWarning);

  return Ok({ fullName, workflowState, tokenExpiresAtMs: expiry.value, warnings: [...warnings] });
}

/**
 * Log a report's warnings.
 *
 * WHY IT IS A FUNCTION AND NOT THREE LINES AT THE CALL SITE: a warning that only reaches the
 * structured log is a warning nobody reads at 3am, and `main.ts` already prints its loud
 * findings to BOTH channels for that reason (see the quarantine block). Keeping the decision
 * here means it cannot drift.
 */
export function logPreflightWarnings(
  report: GithubPreflightReport,
  logger: LoggerPort,
  say: (line: string) => void,
): void {
  for (const warning of report.warnings) {
    logger.warn('github preflight warning', { detail: warning });
    say(`  warning: ${warning}`);
  }
}
