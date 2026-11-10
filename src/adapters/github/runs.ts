/**
 * The rest of `BuildsPort`: run correlation, run polling, and finding the pull request.
 *
 * `dispatch` itself lives in `dispatch.ts` and is delegated to unchanged - it is the one call
 * whose octokit types are known-stale, and re-deriving that workaround in a second place is
 * how the two copies drift.
 *
 * THE THREE JOBS, AND WHY EACH IS SHAPED THE WAY IT IS:
 *
 *  1. `findRunByName` - the fallback for a BLIND dispatch. `DispatchOutcome` is a union with a
 *     `blind` arm precisely so this cannot be forgotten; the arm carries the `run-name` token
 *     the workflow stamps onto its run, and correlation is "list dispatch-triggered runs
 *     created since we asked, keep the ones whose name carries the token".
 *
 *  2. `runStatus` - the poll. Called only from a durable job (a 30-minute poll inside an
 *     interaction handler would answer a token that died at 15 minutes), so it is a plain read.
 *
 *  3. `findPrForBranch` - how the bot learns the PR URL, and therefore the payoff of the whole
 *     product. It is deliberately generous: the precise `head=owner:branch` filter first, then
 *     a client-side exact match over recent pull requests, because "the build worked and the
 *     link never arrived" is the worst failure this system has.
 *
 * Every decision that can be made without the network is a pure exported function below, and
 * every one of them is unit-tested against fixtures. Nothing here touches the live API in a
 * test.
 */

import { createHmac } from 'node:crypto';
import type { Octokit } from 'octokit';
import { z } from 'zod';
import { Err, Ok, type Result } from '#core/result';
import type { Secret } from '#core/config';
import { errors, type AppError } from '#core/errors';
import {
  actionsToken,
  isBuildEnvironmentName,
  parseHttpsUrl,
  renderActionsToken,
  type ActionsToken,
} from '#core/text';
import type { HttpsUrl } from '#core/text';
import type {
  BuildCredentialName,
  BuildsPort,
  CancelOutcome,
  ClockPort,
  DispatchOutcome,
  EnvironmentCredentials,
  LoggerPort,
  PrRef,
  RepositoryVariable,
  RunRef,
  RunReport,
  RunStatus,
  GitRef,
  WorkflowFile,
} from '#core/ports';
// The variable name rule and the "is this a number the workflow would accept?" reading both
// live in core, so this adapter, the fake and any future caller cannot drift apart on them -
// exactly why `isBuildEnvironmentName` lives there too.
import { isRepositoryVariableName, toRepositoryVariable } from '#core/ports';
import { dispatchWorkflow } from '#adapters/github/dispatch';
import { mapGithubError, readGithubFailure, type GithubRepo } from '#adapters/github/client';
// WHY THIS FILE IMPORTS THE SECRETS ADAPTER'S TRANSLATOR: `environmentCredentials` reads an
// ENVIRONMENT endpoint, and environment endpoints are governed by the fine-grained permission
// named **Environments**. The generic 403 sentence names contents, issues and actions - the
// three permissions that are NOT the problem - so an operator who follows it changes three
// settings and gets the same 403 back. One environment-shaped question deserves one answer, so
// both callers share `mapSecretsError` instead of each inventing wording. There is no cycle:
// `secrets.ts` imports `client.ts` and never this file.
import { mapSecretsError } from '#adapters/github/secrets';

// ---------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------

/** How many runs the correlation scan reads. One page is ~an hour of a busy repo. */
export const RUN_SCAN_PAGE_SIZE = 100;
/** How many pull requests the fallback branch scan reads. */
export const PR_SCAN_PAGE_SIZE = 100;
/** How many environment secret NAMES are read. There are only ever a handful. */
export const ENVIRONMENT_SECRET_PAGE_SIZE = 30;

/** A workflow run, reduced to the fields any decision here is allowed to depend on. */
export interface RunSummary {
  readonly id: number;
  /** The workflow's `run-name`. Empty when GitHub sent `null`. */
  readonly name: string;
  readonly htmlUrl: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly event: string;
  /** `created_at` as epoch ms, or 0 when it did not parse. */
  readonly createdAtMs: number;
}

/** A pull request, likewise reduced. */
export interface PullSummary {
  readonly number: number;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly state: string;
  readonly createdAtMs: number;
  /**
   * GitHub's `draft` flag - the agent's "I could not finish, here is what I got" ending.
   *
   * WHY IT DEFAULTS TO `false` WHEN ABSENT rather than to `null`: a missing flag means the
   * payload predates the field or came from a fixture, and treating an unknown as "draft"
   * would label finished work unfinished. Under-claiming is the safe direction here, because
   * the draft card tells a reviewer NOT to merge.
   */
  readonly isDraft: boolean;
}

/**
 * The conclusions we are willing to repeat back.
 *
 * WHY an allow-list rather than interpolating whatever arrived: `detail` travels into an
 * `AppError`'s `internal` field, and "a string off the network ended up in an error string" is
 * the shape of every leak this repo is built to prevent. The vocabulary is closed on GitHub's
 * side anyway, so pinning it costs nothing and makes a surprise visible.
 */
const KNOWN_FAILURE_CONCLUSIONS: readonly string[] = [
  'failure',
  'timed_out',
  'action_required',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
];

/**
 * The run's own page on github.com, or `null`.
 *
 * WHY IT IS PARSED RATHER THAN PASSED THROUGH: `html_url` is a string off the network, and the
 * card that renders it turns it into a Discord link button. `parseHttpsUrl` is the only door
 * to an `HttpsUrl`, so an `http://`, a `javascript:` or a truncated value becomes `null` here
 * instead of becoming a button somewhere far from this file.
 *
 * WHY A FAILURE TO PARSE IS `null` AND NOT AN ERROR: a link is an ADDITION to the answer. The
 * run really is queued, or really did fail, and refusing to report that because the URL looked
 * odd would trade the whole message for the garnish.
 */
function runUrlOf(run: { readonly htmlUrl: string }): HttpsUrl | null {
  const parsed = parseHttpsUrl(run.htmlUrl);
  return parsed.ok ? parsed.value : null;
}

/**
 * Map GitHub's `(status, conclusion)` pair onto core's `RunStatus`.
 *
 * TWO NON-OBVIOUS CASES, BOTH LOAD-BEARING:
 *  - `completed` with a NULL conclusion really happens, for a second or two, while GitHub
 *    settles the run. Reporting it as a failure would tell a user their build broke moments
 *    before the PR link arrives, so it maps to `in-progress` and the poller looks again. The
 *    job's own `deadlineAtMs` is what bounds that, not this function.
 *  - An UNRECOGNISED status maps to `in-progress` for the same reason: a new GitHub status
 *    value must not turn a healthy build into a reported failure. Again, the deadline bounds it.
 *
 * `runUrl` RIDES ALONG ON EVERY ARM, and taking it as a parameter rather than deriving it here
 * is what keeps this function pure and total: the caller has already turned a network string
 * into an `HttpsUrl` or into `null`, and this one cannot fail on a bad URL.
 */
export function toRunStatus(run: {
  readonly status: string;
  readonly conclusion: string | null;
  readonly runUrl: HttpsUrl | null;
}): RunStatus {
  const runUrl = run.runUrl;
  switch (run.status) {
    case 'queued':
    case 'requested':
    case 'waiting':
    case 'pending':
    case 'action_required':
      return { kind: 'queued', runUrl };
    case 'in_progress':
      return { kind: 'in-progress', runUrl };
    case 'completed':
      break;
    default:
      return { kind: 'in-progress', runUrl };
  }

  const conclusion = run.conclusion;
  if (conclusion === 'success') return { kind: 'success', runUrl };
  if (conclusion === 'cancelled') return { kind: 'cancelled', runUrl };
  if (conclusion === null) return { kind: 'in-progress', runUrl };
  return {
    kind: 'failure',
    runUrl,
    detail: KNOWN_FAILURE_CONCLUSIONS.includes(conclusion)
      ? `the workflow run finished with conclusion "${conclusion}"`
      : 'the workflow run finished with an unrecognised conclusion',
  };
}

/**
 * Correlate a blind dispatch by `run-name`.
 *
 * WHY the NEWEST match wins: a retried dispatch produces a second run carrying the same
 * `run-name`, and the one this attempt started is the later one. Ties break on the higher run
 * id, so two callers scanning the same page always agree.
 *
 * WHY `event` is re-checked even though the request already filtered on it: this function is
 * the thing under test, and a filter that only exists in a query string is a filter no test
 * can see.
 */
export function matchRunByName(
  runs: readonly RunSummary[],
  runName: string,
  sinceMs: number,
  excludeRunId: number | null = null,
): RunSummary | null {
  let best: RunSummary | null = null;
  for (const run of runs) {
    if (run.event !== 'workflow_dispatch') continue;
    if (run.id === excludeRunId) continue;
    if (run.createdAtMs < sinceMs) continue;
    if (!run.name.includes(runName)) continue;
    if (best === null || run.createdAtMs > best.createdAtMs || (run.createdAtMs === best.createdAtMs && run.id > best.id)) {
      best = run;
    }
  }
  return best;
}

/**
 * Pick the pull request for a branch.
 *
 * EXACT match on `head.ref`, never a prefix: `bot/issue-1` must not adopt `bot/issue-19`, and
 * GitHub's `head=` query filter is not itself an exact matcher on every path.
 *
 * An OPEN pull request beats a closed one, because a branch reused after an earlier build was
 * abandoned still carries that older, closed PR. Among equals the highest number wins - the
 * most recently opened.
 */
export function matchPrForBranch(prs: readonly PullSummary[], branch: string): PullSummary | null {
  let best: PullSummary | null = null;
  for (const pr of prs) {
    if (pr.headRef !== branch) continue;
    if (best === null || rankPr(pr) > rankPr(best)) best = pr;
  }
  return best;
}

function rankPr(pr: PullSummary): number {
  // Open beats everything; then the newest number. Numbers are far below 2^40, so the shift
  // cannot collide with the open/closed bit.
  return (pr.state === 'open' ? 1 : 0) * 2 ** 40 + pr.number;
}

/**
 * The secret names that make a build payable, in a fixed order so the result is stable.
 *
 * WHY AN ALLOW-LIST AND NOT "does the environment have any secrets": `ai-agent` always holds
 * `APPROVAL_HMAC_KEY`, so "has secrets" is true for the one environment most likely to be
 * unable to pay for anything. Counting the wrong secret would report the exact fresh-install
 * misconfiguration this check exists to catch as healthy.
 */
export const PAYING_CREDENTIAL_NAMES: readonly BuildCredentialName[] = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Reduce the names GitHub listed to the ones that can pay for a build.
 *
 * Pure, so the "an environment with only APPROVAL_HMAC_KEY cannot pay" rule is a unit test
 * rather than something you find out during someone's build.
 */
export function toBuildCredentials(names: readonly string[]): readonly BuildCredentialName[] {
  return PAYING_CREDENTIAL_NAMES.filter((known) => names.includes(known));
}

/** GitHub's `created` filter for run listing: `>=` plus a full ISO-8601 instant. */
export function createdSinceFilter(sinceMs: number): string {
  const clamped = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;
  return `>=${new Date(clamped).toISOString()}`;
}

/** GitHub's `head` filter for pull listing. Same-repo branches only, which is what we push. */
export function headFilter(owner: string, branch: string): string {
  return `${owner}:${branch}`;
}

// ---------------------------------------------------------------------------------------
// Wire schemas. Same posture as dispatch.ts: nothing off the network is trusted.
// ---------------------------------------------------------------------------------------

const RunPayload = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  html_url: z.url(),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  event: z.string().nullable().optional(),
  created_at: z.string().optional(),
});

const RunListPayload = z.object({ workflow_runs: z.array(RunPayload) });

/**
 * The same listing response, read for its COUNT rather than its rows.
 *
 * WHY `total_count` and not `workflow_runs.length`: the array is one page. A cap check that
 * counted the page would silently stop counting at `per_page` and report "under the limit"
 * for a repo that is well over it - which is the one failure mode a spend cap cannot have.
 * GitHub applies the `created` filter server-side, so `total_count` is already the number of
 * runs in the window.
 *
 * `workflow_runs` is still required in the schema even though nothing here reads it: its
 * presence is what distinguishes this response from some other JSON object that happens to
 * carry a `total_count`, and an unrecognised shape must be an error rather than a zero. A zero
 * would read as "no runs today" and open the gate.
 */
const RunCountPayload = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.unknown()),
});

const PullPayload = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  state: z.string(),
  created_at: z.string().optional(),
  head: z.object({ ref: z.string() }),
  // OPTIONAL in the schema even though GitHub always sends it: a shape mismatch here would
  // make `findPrForBranch` answer "no pull request", and "the build worked and the link never
  // arrived" is the worst failure this system has. A missing flag degrades to `false` in
  // `toPullSummary`; it never costs the caller the URL.
  draft: z.boolean().optional(),
});

const PullListPayload = z.array(PullPayload);

/** Only the workflow's own token posts as this login; nothing the agent holds can. */
const REPORT_AUTHOR = 'github-actions[bot]';
const REPORT_MARKER = /<!-- agent-report:v1 (\{[\s\S]*?\}) -->/u;
const REPORT_TEXT_MAX = 400;

const IssueCommentListPayload = z.array(z.object({ body: z.string().nullable().optional(), user: z.object({ login: z.string() }).nullable() }));

const agentText = z.string().transform((s) => s.slice(0, REPORT_TEXT_MAX));
const RunReportPayload = z.object({
  run_id: z.number().int().positive(),
  failed_step: z
    .enum(['approval', 'approval_expired', 'approval_replayed', 'credentials', 'daily_cap', 'setup', 'agent', 'forbidden_path'])
    .nullable(),
  stop: z.string().max(64).nullable(),
  turns: z.number().int().nonnegative().nullable(),
  // `.catch(null)`: a malformed agent half must not cost the facts the workflow computed.
  agent: z
    .object({ status: z.enum(['done', 'partial', 'refused']), summary: agentText, remaining: agentText })
    .nullable()
    .catch(null),
});

/**
 * Pull the report for run `runId` out of one comment body, or null. Exported for its test.
 * The JSON sits in an HTML comment the workflow writes with every `>` escaped, so a model-written
 * string cannot close the comment early.
 */
export function parseRunReport(body: string, runId: number): RunReport | null {
  const m = REPORT_MARKER.exec(body);
  if (m?.[1] === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const parsed = RunReportPayload.safeParse(raw);
  if (!parsed.success || parsed.data.run_id !== runId) return null;
  const { failed_step, stop, turns, agent } = parsed.data;
  return { failedStep: failed_step, stop, turns, agent };
}

/**
 * `GET /repos/{owner}/{repo}/environments/{environment_name}/secrets`.
 *
 * NOTE WHAT IS NOT HERE: a value. GitHub's response carries `name`, `created_at` and
 * `updated_at` and nothing else, because environment secrets are write-only - which is the
 * property the whole bring-your-own-credentials design rests on.
 */
const EnvironmentSecretsPayload = z.object({
  secrets: z.array(z.object({ name: z.string() })),
});

/**
 * `GET /repos/{owner}/{repo}/actions/variables/{name}`.
 *
 * `value` IS A STRING even for a variable everybody thinks of as a number - GitHub stores
 * Actions variables as text and interpolates them into shell. That is exactly why the port
 * hands back a parsed `RepositoryVariable` rather than this: the string is the thing the
 * workflow's guard rejects, and the number is the thing a caller can compare.
 */
const VariablePayload = z.object({
  name: z.string(),
  value: z.string(),
});

function toEpochMs(iso: string | undefined): number {
  if (iso === undefined) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function toRunSummary(raw: z.infer<typeof RunPayload>): RunSummary {
  return {
    id: raw.id,
    name: raw.name ?? '',
    htmlUrl: raw.html_url,
    status: raw.status ?? 'unknown',
    conclusion: raw.conclusion ?? null,
    event: raw.event ?? 'unknown',
    createdAtMs: toEpochMs(raw.created_at),
  };
}

function toPullSummary(raw: z.infer<typeof PullPayload>): PullSummary {
  return {
    number: raw.number,
    htmlUrl: raw.html_url,
    headRef: raw.head.ref,
    state: raw.state,
    createdAtMs: toEpochMs(raw.created_at),
    isDraft: raw.draft ?? false,
  };
}

// ---------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------

/**
 * Everything on `BuildsPort` except the containment gate, which `index.ts` composes on top
 * (`verifyGates`, `readiness`, and the refusal wrapped around `dispatch`), because the gate needs
 * the boot preflight's state and this file is built before the preflight runs.
 */
export type GithubBuildsCore = Omit<BuildsPort, 'verifyGates' | 'readiness'>;

export function createGithubBuilds(input: {
  readonly octokit: Octokit;
  readonly repo: GithubRepo;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /**
   * The approval MAC key. Shared with the repository's `ai-agent` environment secret
   * APPROVAL_HMAC_KEY; if the two differ, every dispatch is rejected by
   * `.github/scripts/verify_approval.py` and no build ever starts.
   */
  readonly approvalHmacKey: Secret;
  /**
   * `owner/name` AS GITHUB SPELLS IT, read at call time.
   *
   * WHY A FUNCTION: the authoritative spelling is `full_name` from the preflight's
   * `GET /repos/{o}/{r}`, which runs after this port is built. `GITHUB_OWNER`/`GITHUB_REPO`
   * admit any case and GitHub's REST paths are case-insensitive, so a mis-cased `.env` works
   * everywhere except inside the approval token, where `$GITHUB_REPOSITORY` on the runner
   * carries GitHub's stored case. Defaults to the configured pair until the preflight answers.
   */
  readonly repositoryName?: () => string;
  /**
   * `GITHUB_WORKFLOW_FILE` and `GITHUB_REF`, bound here rather than passed per call (RFC-001
   * 5.4): the dispatch runs, and the daily cap counts, exactly the workflow at exactly the ref the
   * preflight and the gate-file check verify. Branded at config load, so never free text.
   */
  readonly workflowFile: WorkflowFile;
  readonly ref: GitRef;
}): GithubBuildsCore {
  const { octokit, clock } = input;
  const { owner, repo } = input.repo;
  const repositoryName = input.repositoryName ?? ((): string => `${owner}/${repo}`);
  const log = input.logger.child({ component: 'github.builds' });

  const fail = (cause: unknown, operation: string): AppError => mapGithubError(cause, operation, clock.now());

  const shapeError = (operation: string, status: number): AppError =>
    errors.upstream('github', status, 'Ask an admin to check the GitHub API version pin.', `${operation}: unrecognised response shape`);

  async function listPulls(params: Readonly<Record<string, string | number>>): Promise<Result<readonly PullSummary[], AppError>> {
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: PR_SCAN_PAGE_SIZE,
        ...params,
      });
      const parsed = PullListPayload.safeParse(res.data);
      if (!parsed.success) return Err(shapeError('builds.findPrForBranch', res.status));
      return Ok(parsed.data.map(toPullSummary));
    } catch (cause: unknown) {
      return Err(fail(cause, 'builds.findPrForBranch'));
    }
  }

  return {
    /**
     * HMAC-SHA256, hex, over
     * `v2.<requestId>.<approvalId>.<issueNumber>.<bodySha256>.<environmentName>.<issuedAtSec>.<repository>`.
     *
     * The exact string and digest must match `.github/scripts/verify_approval.py`. If you
     * change either side, change both — a mismatch does not fail loudly at boot, it fails on
     * every dispatch at the moment a human is watching an approval card. `runs.test.ts` runs
     * the real Python verifier against a token this function produced, which is the only thing
     * that actually proves the two agree.
     *
     * `environmentName` IS THE BILLING BINDING. `environment_name` selects whose Anthropic
     * credentials pay for the run, it is a non-secret dispatch input, and GitHub prints
     * non-secret inputs in the run title, the REST API and the job log. So an attacker with
     * repo write can see a valid approval token and re-dispatch it; binding the environment
     * name is what stops them re-pointing that dispatch at another user's environment and
     * spending that user's money under an approval nobody gave.
     *
     * `approvalId` AND `issuedAtSec` ARE THE REPLAY BINDING. The same printed token could be
     * re-dispatched as-is until the daily cap stopped it. The workflow now consumes each
     * approval id once and refuses a token issued more than APPROVAL_MAX_AGE_SECONDS before
     * the run was created, so a token read out of a log is worth one build, briefly, and then
     * nothing.
     *
     * THE `v2.` PREFIX means a token produced by the previous tuple cannot verify against the
     * current script even if a field happened to collide, and gives the next change a place
     * to go. `repository` is last because a repository name may contain a dot and every field
     * before it has a fixed shape, so the serialisation stays unambiguous.
     *
     * Returned as an `ActionsToken` via `actionsToken.sha`, which enforces 40/64 hex. That is
     * what lets it be a `workflow_dispatch` input at all: `ActionsInput` excludes plain
     * strings, so there is nothing here for `${{ }}` to interpolate (SC-1).
     */
    signApproval(sign): ActionsToken {
      if (!Number.isInteger(sign.issuedAtSec) || sign.issuedAtSec < 0) {
        throw new TypeError('signApproval: issuedAtSec must be a non-negative integer of Unix seconds');
      }
      const message = [
        'v2',
        sign.requestId,
        sign.approvalId,
        String(sign.issueNumber),
        sign.bodySha256,
        sign.environmentName,
        String(sign.issuedAtSec),
        repositoryName(),
      ].join('.');
      const mac = createHmac('sha256', input.approvalHmacKey.reveal()).update(message, 'utf8').digest('hex');
      return actionsToken.sha(mac);
    },

    /**
     * Which paying secrets an environment holds, so a build that cannot possibly authenticate
     * fails in a second instead of thirty minutes in, inside the agent step.
     *
     * THREE THINGS WORTH KNOWING:
     *
     *  1. A 404 is NOT an error here. GitHub returns 404 for an environment that does not
     *     exist, and "this user has not configured credentials" is an ordinary answer, not a
     *     failure. What the CALLER does with it depends on
     *     `modules.builder.requireOwnCredentials`: with the switch off it selects the shared
     *     environment, and with it on - the default - the request is refused with an
     *     instruction to run `/credentials set`. Mapping it to an `AppError` would make an
     *     ordinary answer look like a failure, and would also swallow the distinction from
     *     "exists but empty", which is a revoked credential rather than an absent one.
     *  2. The name is re-validated before it becomes a path segment. It arrives as a plain
     *     string, and `isBuildEnvironmentName` is the same definition core mints names with and
     *     the workflow re-checks in shell, so all three cannot drift.
     *  3. Nothing here can return a secret VALUE, because GitHub does not expose one. The
     *     response is names and timestamps.
     */
    async environmentCredentials(environmentName: string): Promise<Result<EnvironmentCredentials, AppError>> {
      if (!isBuildEnvironmentName(environmentName)) {
        return Err(
          errors.validation(
            'environmentName',
            'That is not a build environment.',
            'Report this to an admin; the bot asked GitHub about an environment it could not have built.',
          ),
        );
      }
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/environments/{environment_name}/secrets', {
          owner,
          repo,
          environment_name: environmentName,
          per_page: ENVIRONMENT_SECRET_PAGE_SIZE,
        });
        const parsed = EnvironmentSecretsPayload.safeParse(res.data);
        if (!parsed.success) return Err(shapeError('builds.environmentCredentials', res.status));
        return Ok({
          environmentName,
          exists: true,
          credentials: toBuildCredentials(parsed.data.secrets.map((s) => s.name)),
        });
      } catch (cause: unknown) {
        if (readGithubFailure(cause, clock.now()).status === 404) {
          return Ok({ environmentName, exists: false, credentials: [] });
        }
        // `mapSecretsError`, NOT the generic `fail`. This is the pre-flight that runs before
        // EVERY build, so a token missing the Environments permission produced a 403 here and
        // the build then died holding the sentence "check the token repository permissions
        // (contents, issues and actions)" - which names nothing the operator can usefully
        // change. The environment-specific sentence names **Environments** and warns that the
        // permission called "Secrets" is a different one.
        const error = mapSecretsError(cause, 'builds.environmentCredentials', clock.now());
        // A NON-RETRYABLE failure here is load-bearing for the caller, and WHICH way depends on
        // `modules.builder.requireOwnCredentials`:
        //
        //   switch OFF - `resolveBuildPayer` DEGRADES. It stops trying to find out whether this
        //     user brought their own credential and lets the build run on the operator's
        //     environment, because a missing optional permission must cost the optional feature
        //     rather than every build in the product. That moves who pays.
        //   switch ON (the default) - degrading would mean "the operator pays", which is the one
        //     outcome the gate exists to forbid, so the caller FAILS CLOSED instead: `/request`
        //     is refused with a config error naming the **Environments** permission.
        //
        // Either way the operator needs this line. In the first case it is the only record that
        // somebody's own key was silently not used; in the second it is what explains why the
        // flagship command started refusing everyone. The environment NAME is not a secret.
        if (!error.retryable) {
          log.warn('cannot read environment credentials; who pays for this build is now decided without them', {
            environment: environmentName,
            code: error.code,
          });
        }
        return Err(error);
      }
    },

    async dispatch(request): Promise<Result<DispatchOutcome, AppError>> {
      // WHY the try/catch is HERE and not inside `dispatchWorkflow`: that function is the
      // documented workaround for octokit's stale dispatch types and stays about exactly that.
      // Turning a throw into an `AppError` is this file's job, and it uses the same mapper as
      // every other call so a 404 reads the same way whichever endpoint produced it.
      try {
        return await dispatchWorkflow(octokit, owner, repo, { ...request, workflowFile: input.workflowFile, ref: input.ref });
      } catch (cause: unknown) {
        return Err(fail(cause, 'builds.dispatch'));
      }
    },

    async findRunByName(runName: ActionsToken, sinceMs: number, excludeRunId?: number): Promise<Result<RunRef | null, AppError>> {
      // `renderActionsToken` is an adapter-only unwrapper; upstream of it the value could not
      // have been free text in the first place (SC-1).
      const needle = renderActionsToken(runName);
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
          owner,
          repo,
          event: 'workflow_dispatch',
          created: createdSinceFilter(sinceMs),
          per_page: RUN_SCAN_PAGE_SIZE,
          exclude_pull_requests: true,
        });
        const parsed = RunListPayload.safeParse(res.data);
        if (!parsed.success) return Err(shapeError('builds.findRunByName', res.status));

        const match = matchRunByName(parsed.data.workflow_runs.map(toRunSummary), needle, sinceMs, excludeRunId ?? null);
        if (match === null) return Ok(null);

        const url = parseHttpsUrl(match.htmlUrl);
        if (!url.ok) return Err(shapeError('builds.findRunByName', res.status));
        log.info('correlated a blind dispatch by run-name', { runId: match.id });
        return Ok({ runId: match.id, runUrl: url.value });
      } catch (cause: unknown) {
        return Err(fail(cause, 'builds.findRunByName'));
      }
    },

    /**
     * How many runs of `workflowFile` GitHub recorded since `sinceMs`.
     *
     * THE ENDPOINT IS THE PER-WORKFLOW ONE, `/actions/workflows/{workflow_id}/runs`, and that
     * choice is load-bearing in two ways. GitHub accepts the workflow FILE NAME as
     * `workflow_id`, which is exactly what `WorkflowFile` is - already proven by
     * `toWorkflowFile` at config load to match `[A-Za-z0-9._-]{1,80}\.ya?ml`, so it is a safe
     * path segment and not free text. And scoping the count to one workflow means an unrelated
     * CI run in the same repository does not eat somebody's build budget.
     *
     * NOTE WHAT IS DELIBERATELY NOT FILTERED: the trigger. `findRunByName` pins
     * `event=workflow_dispatch` because it is looking for a run this bot started. A CAP must
     * count every run of that workflow, including one a human kicked off from the Actions tab,
     * because those spend the same minutes and the same Anthropic credits.
     *
     * `per_page: 1` because only `total_count` is read; there is no reason to move a hundred
     * run objects across the wire to count them.
     */
    async runsSince(sinceMs: number): Promise<Result<number, AppError>> {
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
          owner,
          repo,
          workflow_id: input.workflowFile,
          created: createdSinceFilter(sinceMs),
          per_page: 1,
          exclude_pull_requests: true,
        });
        const parsed = RunCountPayload.safeParse(res.data);
        // An unparseable response is an ERROR, never a zero. A zero here would be read by the
        // caller as "nothing has run today" and would open the gate it exists to close.
        if (!parsed.success) return Err(shapeError('builds.runsSince', res.status));
        return Ok(parsed.data.total_count);
      } catch (cause: unknown) {
        return Err(fail(cause, 'builds.runsSince'));
      }
    },

    async runStatus(runId: number): Promise<Result<RunStatus, AppError>> {
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
          owner,
          repo,
          run_id: runId,
          exclude_pull_requests: true,
        });
        const parsed = RunPayload.safeParse(res.data);
        if (!parsed.success) return Err(shapeError('builds.runStatus', res.status));
        // THE LINE THE RUN URL USED TO DIE ON. `html_url` was parsed into `RunSummary` and then
        // dropped, so a poller holding a failing build had nothing to point a human at. It now
        // rides on every arm of `RunStatus`; see the type's own comment for why even the
        // non-terminal arms carry it.
        const summary = toRunSummary(parsed.data);
        return Ok(
          toRunStatus({ status: summary.status, conclusion: summary.conclusion, runUrl: runUrlOf(summary) }),
        );
      } catch (cause: unknown) {
        return Err(fail(cause, 'builds.runStatus'));
      }
    },

    /**
     * Ask GitHub to stop a run, and tell the caller which of the two successes happened.
     *
     * THE STATUS CODES ARE THE WHOLE FUNCTION:
     *
     *  - **202 Accepted**, not 200. Cancellation is asynchronous on GitHub's side: the answer
     *    means "I have accepted the request", the jobs are torn down over the following
     *    seconds, and a poll immediately after this can still read `in_progress`. Nothing here
     *    waits for that, because a `/request cancel` handler has three seconds and a run has
     *    its own poller already watching it.
     *  - **409 Conflict** for a run that had already finished, and THAT IS NOT A FAILURE. It is
     *    the answer to "cancel my build" from somebody whose build completed a moment before
     *    they clicked, and reporting it as an upstream error would put "GitHub refused that,
     *    ask an admin" in front of a person for whom nothing went wrong. It comes back as
     *    `already-finished`, which is a different sentence from `requested` and must stay one:
     *    the money for that run is already spent, and its result exists.
     *
     * WHY THE 409 IS NOT HAMMERED FIRST: the transport's `doNotRetry` list carries 409 (see
     * `DO_NOT_RETRY` in client.ts). Without it octokit's retry plugin treats any `>= 400` that
     * is not listed as worth another go, so the ROUTINE outcome of this call would have cost
     * four requests and about fourteen seconds of backoff before answering.
     *
     * A 404 is deliberately NOT folded in here. Runs are not deleted, so "no such run" means
     * the id is wrong or the token cannot see the repository - which is the story the shared
     * 404 sentence already tells, and a `Ok(already-finished)` would bury it.
     */
    async cancelRun(runId: number): Promise<Result<CancelOutcome, AppError>> {
      try {
        await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', {
          owner,
          repo,
          run_id: runId,
        });
        log.info('asked GitHub to cancel a run', { runId });
        return Ok({ kind: 'requested' });
      } catch (cause: unknown) {
        if (readGithubFailure(cause, clock.now()).status === 409) {
          // Worth a line: it is the difference between "we stopped the spend" and "the spend had
          // already happened", and the card the user sees says one of those two.
          log.info('nothing left to cancel; the run had already finished', { runId });
          return Ok({ kind: 'already-finished' });
        }
        return Err(fail(cause, 'builds.cancelRun'));
      }
    },

    /**
     * Read one repository Actions variable, so a setting the bot holds a copy of can be checked
     * against the operator's real one instead of assumed to match.
     *
     * A 404 IS AN ANSWER, NOT AN ERROR - the same shape as `environmentCredentials`, and for the
     * same reason. GitHub answers 404 for a variable nobody ever created, and the workflow then
     * uses the literal default written into `vars.AGENT_DAILY_RUN_CAP || '4'`. Mapping that to
     * an `AppError` would report the ORDINARY, correct configuration as a fault; mapping it to
     * zero would report a cap of nothing on a healthy repository. `unset` is the third thing,
     * and the caller has to name it.
     *
     * THE NAME IS THE ONE WE WERE ASKED ABOUT, not the one GitHub echoes. Variable names are
     * case-insensitive on GitHub's side and the response carries the stored casing, so echoing
     * the response would hand a caller comparing names a difference that means nothing.
     *
     * Nothing that comes back is a secret. Actions variables are plaintext by design, printed
     * verbatim in run logs - which is exactly why the daily cap is one and the Anthropic key is
     * not.
     */
    async repositoryVariable(name: string): Promise<Result<RepositoryVariable, AppError>> {
      if (!isRepositoryVariableName(name)) {
        return Err(
          errors.validation(
            'name',
            'That is not a repository variable name.',
            'Report this to an admin; the bot asked GitHub about a variable it could not have named.',
          ),
        );
      }
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/actions/variables/{name}', {
          owner,
          repo,
          name,
        });
        const parsed = VariablePayload.safeParse(res.data);
        if (!parsed.success) return Err(shapeError('builds.repositoryVariable', res.status));
        return Ok(toRepositoryVariable(name, parsed.data.value));
      } catch (cause: unknown) {
        if (readGithubFailure(cause, clock.now()).status === 404) return Ok({ kind: 'unset', name });
        return Err(fail(cause, 'builds.repositoryVariable'));
      }
    },

    async findRunReport(issueNumber: number, runId: number): Promise<Result<RunReport | null, AppError>> {
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
        });
        const parsed = IssueCommentListPayload.safeParse(res.data);
        if (!parsed.success) return Err(shapeError('builds.findRunReport', res.status));
        // Newest first; a retried request reuses its issue, so the run id is what picks the report.
        for (const c of [...parsed.data].reverse()) {
          if (c.user?.login !== REPORT_AUTHOR || typeof c.body !== 'string') continue;
          const report = parseRunReport(c.body, runId);
          if (report !== null) return Ok(report);
        }
        return Ok(null);
      } catch (cause: unknown) {
        return Err(fail(cause, 'builds.findRunReport'));
      }
    },

    async findPrForBranch(branch: string): Promise<Result<PrRef | null, AppError>> {
      // Pass 1: the precise server-side filter.
      const filtered = await listPulls({ head: headFilter(owner, branch) });
      if (!filtered.ok) return filtered;
      let match = matchPrForBranch(filtered.value, branch);

      // Pass 2: the branch existed but the `head` filter did not surface it - a pull request
      // opened from a fork, or an owner-login mismatch. One extra read is a trivial price for
      // not losing the single message this whole product exists to deliver.
      if (match === null) {
        const recent = await listPulls({});
        if (!recent.ok) return recent;
        match = matchPrForBranch(recent.value, branch);
      }
      if (match === null) return Ok(null);

      const url = parseHttpsUrl(match.htmlUrl);
      if (!url.ok) return Err(shapeError('builds.findPrForBranch', 200));
      // `isDraft` is what lets the builder tell "the agent finished" from "the agent ran out of
      // room and pushed what it had". Reporting the second as the first is the one wrong answer
      // of the three, because it invites a merge of work the agent said was incomplete.
      return Ok({ number: match.number, url: url.value, branch, isDraft: match.isDraft });
    },
  };
}
