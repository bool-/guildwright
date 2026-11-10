/**
 * THE FLAGSHIP MODULE, end to end, compiling against the final contracts.
 *
 * `/request new` -> modal -> validate/redact/rate-limit -> GitHub issue -> Approve/Reject card
 * gated to approvers -> on approve, workflow_dispatch -> poll -> post the PR link back, at
 * minute 20, after a restart, without an interaction token.
 *
 * ONE STRUCTURAL DECISION WORTH READING: `approve` does NOT dispatch. It compare-and-sets the
 * row to `dispatching` and hands back a job; the job dispatches on its first attempt and polls
 * on the rest. That is what makes "dispatched implies a poller exists" atomic - `dispatch()`
 * is async while `enqueue` is synchronous, so the two can never be bracketed in one
 * transaction, and a crash in between would otherwise execute a paid run nothing ever polls.
 * `reconcile()` sweeps rows whose job was lost anyway, because belt and braces is cheap here.
 *
 * WHAT THIS ROUND ADDED, AND WHY THE MACHINERY ABOVE WAS NOT ENOUGH. An audit put it in one
 * sentence: *"Twenty minutes of silence, and the outcome is delivered by an edit that notifies
 * nobody."* All of the missing human edges are now here or one file away:
 *
 *   - the approval card SAYS WHAT IT IS APPROVING (title and a bounded excerpt) instead of
 *     asking somebody to authorise a bill on the strength of `#42` - see `cards.ts`;
 *   - every terminal outcome PINGS THE REQUESTER through `View.mentionUserId`, so twenty minutes
 *     of silence ends in a notification rather than an edit to a message that scrolled away;
 *   - `/request list`, `/request cancel` and `/request retry` exist at all - see `history.ts`;
 *   - the DAILY RUN CAP the workflow enforces is checked BEFORE dispatching, so an over-cap
 *     request is queued and explained instead of burning a paid run and arriving as an
 *     unexplained "Build failed".
 *
 * The file is split because it grew a second audience. `rows.ts` owns persistence, `cards.ts`
 * owns every surface, `payer.ts` owns who funds a build (two callers now: the modal and the
 * retry), `history.ts` owns the three management commands. This file owns the manifest, the
 * approval flow and the durable job.
 */

import { z } from 'zod';
import { defineModule, readSurface, type CommandSpec, type JobOutcome, type Outcome } from '#core/module';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { isJsonObject, type JsonObject } from '#core/json';
import {
  SHARED_BUILD_ENVIRONMENT,
  actionsToken,
  agentBranchName,
  buildEnvironmentName,
  buildIssueBody,
  fence,
  md,
  mdInlineCode,
  redactUserSecrets,
  renderPlainName,
  renderSafeMarkdown,
  sanitizeStored,
  toMarkdown,
  toPlainName,
  userTextForTest,
  type HttpsUrl,
  type UserText,
} from '#core/text';
import {
  assertActionRef,
  newApprovalId,
  newCardNonce,
  newFenceNonce,
  newRequestId,
  toApprovalId,
  toCardNonce,
  toRequestId,
  type CardNonce,
  type RequestId,
} from '#core/ids';
import { limit } from '#core/ratelimit';
import {
  toGitRef,
  toWorkflowFile,
  type AuditPort,
  type BuildsPort,
  type ClockPort,
  type DiscordPort,
  type GitRef,
  type LoggerPort,
  type PrRef,
  type WorkflowFile,
} from '#core/ports';
import type { SurfaceRef, View } from '#core/view';

import {
  buildDedupeKey,
  buildRepo,
  isTerminalState,
  msUntilUtcDayEnd,
  startOfUtcDay,
  type BuildRepo,
  type BuildRow,
} from '#modules/builder/rows';
import {
  APPROVE,
  REJECT,
  REQUEST_FORM,
  approvalCard,
  approveButton,
  blockedCard,
  buildingCard,
  cancelledCard,
  capWaitingCard,
  concurrencyError,
  dailyCapExhaustedError,
  draftPrCard,
  expiredCard,
  failedCard,
  listCard,
  openedCard,
  parseSurface,
  pingRequester,
  pingRequesterUnless,
  refusedCard,
  rejectButton,
  rejectedCard,
  retryingCard,
  dispatchExhaustedError,
  storedUrl,
  surfaceOf,
  ttlHours,
  type Mention,
  type RequestExcerpt,
} from '#modules/builder/cards';
import { deliverOutcome } from '#modules/builder/notify';
import { classifyEnding, failureError, noPrError } from '#modules/builder/ending';
import { historyCommands } from '#modules/builder/history';
import { KIND_OPTIONS, REQUEST_KINDS, kindIssueLabel } from '#modules/builder/kinds';
import { requireOwnCredentialsGate, resolveBuildPayer } from '#modules/builder/payer';
import { readAgentDailyRunCap, type DailyCapReading } from '#modules/builder/ports';

/**
 * ONE PUBLIC FACE FOR THE MODULE.
 *
 * Persistence and presentation moved into their own files this round; nobody following
 * `#modules/builder/module` should have to learn three new import paths to find what used to be
 * here, and the tests should not have to be rewritten to prove behaviour that did not change.
 */
export { buildDedupeKey, buildRepo, isTerminalState, msUntilUtcDayEnd, slotsUsed, startOfUtcDay } from '#modules/builder/rows';
export type { ActiveCounts, BuildRepo, BuildRow, BuildState, NewBuildRow, SlotClaim, SlotReopen } from '#modules/builder/rows';
export { concurrencyError, dailyCapExhaustedError, runFailedError, stateLabel, ttlHours } from '#modules/builder/cards';
export type { CancelledBy, CancelledRun } from '#modules/builder/cards';
export {
  readAgentDailyRunCap,
  reopenIssue,
  requestRunCancellation,
} from '#modules/builder/ports';
export type {
  CancelsRuns,
  DailyCapReading,
  IssueReopenReport,
  ReopensIssues,
  RunCancellation,
  RunCancelReport,
} from '#modules/builder/ports';
export { AGENT_DAILY_RUN_CAP } from '#modules/builder/ports';
export {
  CREDENTIALS_NEXT_STEP,
  ownCredentialsRequiredError,
  requireOwnCredentialsGate,
  resolveBuildPayer,
} from '#modules/builder/payer';

// ---------------------------------------------------------------------------------------
// Job payload - JsonObject, because it has to survive a restart
// ---------------------------------------------------------------------------------------

/**
 * NO `approvalId` HERE ANY MORE. It used to ride in the payload and be read by nobody; it now
 * lives on the row (`approval_id`), which is the one place the Approve click, the retry path
 * and the dispatch pass all agree on. A payload written by the previous deploy still carries
 * the key, and zod strips it rather than rejecting the job.
 */
const BuildPayload = z.object({
  requestId: z.string(),
  issueNumber: z.number().int().positive(),
  // Who clicked Approve, so the job can keep "Approved by" when it re-draws the card with the
  // run link. Optional: a job enqueued by the previous deploy, or by `/request retry`, has none.
  approverId: z.string().regex(/^\d{17,20}$/u).optional(),
});

/**
 * WHY the payload is re-parsed rather than trusted: it came back out of SQLite, possibly
 * written by an older deploy. `onUnparseable` is where that lands, and it is a required
 * member of `JobSpec` for exactly this reason.
 */
function readPayload(payload: JsonObject): Result<{ id: RequestId; issueNumber: number; approverId: string | null }, AppError> {
  const parsed = BuildPayload.safeParse(payload);
  if (!parsed.success) {
    return Err(errors.conflict('payload', 'That build is no longer trackable.', 'Open a new request.'));
  }
  const id = toRequestId(parsed.data.requestId);
  if (!id.ok) return id;
  return Ok({ id: id.value, issueNumber: parsed.data.issueNumber, approverId: parsed.data.approverId ?? null });
}

/**
 * A `dispatching` row with no recorded approval. Only a row approved BEFORE migration 0004 and
 * still waiting at the restart can be in this state, and it is refused rather than minted an
 * id on the spot: a signed approval must be traceable to one recorded click or retry, and
 * silently manufacturing one for a row approved under the old rules would be exactly the
 * untraceable spend the id exists to prevent. `/request retry` re-arms it with a fresh id.
 */
function noApprovalIdError(): AppError {
  return errors.conflict('no_approval_id', 'This request has no recorded approval, so it was not built.', 'Run /request retry.');
}

/**
 * How far before the first dispatch attempt the bot looks for an earlier run of the same
 * approval when the workflow reports a replay. Covers clock skew between this host and GitHub;
 * the run it is looking for cannot predate the attempt that created it by more than that.
 */
const REPLAY_ADOPT_SLACK_MS = 300_000;

// ---------------------------------------------------------------------------------------
// How long to wait before the next attempt
// ---------------------------------------------------------------------------------------

/**
 * HONOUR THE WAIT GITHUB ASKED FOR.
 *
 * `mapGithubError` reads `retry-after` and `x-ratelimit-reset` off a 429 or a rate-limited 403
 * and puts the answer on `RateLimitedError.retryAfterMs` - already bounded to 15 minutes, and
 * defaulted to 60s when GitHub limited us without saying for how long. Every retry arm in the
 * build job then threw that away and slept `pollIntervalMs` (15s) instead.
 *
 * WHAT THAT COSTS: a build job may retry for up to six hours. Re-polling a throttled API every
 * 15 seconds for hours does not merely fail to help - each rejected call is itself counted, so
 * the bot holds its own rate limit open, and secondary-limit abuse detection is what GitHub
 * answers next. The one number that would have fixed it was already in the error object.
 *
 * `Math.max` in both directions is deliberate. GitHub's wait is a FLOOR, not a schedule: a 2s
 * `retry-after` must not turn a 15s poll into a 2s hot loop, and a 900s reset must not be
 * shortened to 15s. Whichever is longer is the safe one.
 *
 * `kind === 'rate-limited'` is the only variant carrying the field - `AppError` is a closed
 * union, so this narrowing cannot silently miss a new one; it would stop compiling.
 */
export function retryDelayMs(error: AppError, floorMs: number): number {
  return error.kind === 'rate-limited' ? Math.max(error.retryAfterMs, floorMs) : floorMs;
}

/**
 * The retry arm itself, so a call site cannot forget to consult the error it is holding.
 *
 * WHY A HELPER RATHER THAN AN INLINE `Math.max` AT EACH SITE: there are five arms that hold a
 * failed `Result`, and the defect was that all five wrote the same plausible-looking literal.
 * One function is one place to be right, and `src/modules/builder/retry.test.ts` asserts no arm
 * guarded by a failed result still passes a bare interval.
 */
function retryAfter(error: AppError, floorMs: number, why: string): JobOutcome {
  return { kind: 'retry', afterMs: retryDelayMs(error, floorMs), why };
}

// ---------------------------------------------------------------------------------------
// The daily run cap
// ---------------------------------------------------------------------------------------

/**
 * Exactly what the cap check reaches. `JobContext` is generic over the capability tuple, and
 * naming it here would drag that generic through a helper that only needs four ports - so the
 * shape is written structurally and `jctx` satisfies it.
 */
interface CapContext {
  readonly ports: {
    readonly builds: Pick<BuildsPort, 'runsSince'>;
    readonly clock: ClockPort;
    readonly audit: AuditPort;
    readonly discord: Pick<DiscordPort, 'edit'>;
  };
  readonly logger: LoggerPort;
  readonly deadlineAtMs: number;
}

/**
 * MAY THIS BUILD START RIGHT NOW? Returns `null` for "yes, carry on and dispatch".
 *
 * THE DEFECT THIS CLOSES. `.github/workflows/agent-implement-request.yml` counts today's agent
 * runs and exits 1 over `AGENT_DAILY_RUN_CAP`. The bot knew nothing about that, so an over-cap
 * request was dispatched regardless: it consumed a workflow run, failed at that step, and
 * arrived in Discord as "Build failed. The build ran and failed." with a link to a log whose
 * entire content is `daily agent run cap reached`. The requester had done nothing wrong, the
 * true answer was "wait a few hours", and nothing in the product said either thing.
 *
 * THREE OUTCOMES, and each exists for a different reason:
 *
 *  1. **Under cap** -> `null`. The common case, at the price of one extra REST read per build.
 *  2. **Over cap, reset inside this job's deadline** -> redraw the card as "queued" and `retry`
 *     at the reset. Nothing is spent, the requester is told the truth, and the build starts by
 *     itself. `retry` does not consume an attempt, so waiting costs nothing.
 *  3. **Over cap, reset BEYOND the deadline** -> fail now, saying so and naming the wait. A
 *     `retry` scheduled past the deadline is not a wait, it is a dead-letter with extra steps:
 *     the runner gives up and draws "Build failed", which is the unexplained message this whole
 *     check exists to abolish.
 *
 * AND A FOURTH, DELIBERATELY NOT A REFUSAL: if the count cannot be READ, this degrades to
 * dispatching. A retryable failure retries; a permanent one - in practice a token without
 * `actions: read` - is logged and the build proceeds, because the WORKFLOW enforces the same cap
 * and is the authority. Failing closed here would mean one missing optional permission stops
 * every build in the product, which is the mistake `resolveBuildPayer` already learned once.
 */
async function checkDailyCap(
  jctx: CapContext,
  repo: BuildRepo,
  cfg: { readonly dailyRunCap: number; readonly pollIntervalMs: number },
  input: {
    readonly workflowFile: WorkflowFile;
    readonly row: BuildRow;
    readonly issueNumber: number;
    readonly surface: SurfaceRef;
  },
): Promise<JobOutcome | null> {
  const now = jctx.ports.clock.now();
  // The SAME window the workflow counts: runs created since UTC midnight, for this one workflow
  // file. A different boundary would mean the bot and the runner disagree about what day it is.
  const used = await jctx.ports.builds.runsSince(input.workflowFile, startOfUtcDay(now));
  if (!used.ok) {
    if (used.error.retryable) return retryAfter(used.error, cfg.pollIntervalMs, 'could not read the daily run count');
    jctx.logger.warn('could not read the daily agent run count; dispatching anyway', {
      requestId: input.row.id,
      code: used.error.code,
    });
    return null;
  }
  // `>=`, not `>`: the workflow counts the run it is ALREADY INSIDE, so a repository holding
  // `cap` runs today would see `cap + 1` and refuse. Dispatching at exactly the cap buys nothing
  // but a wasted run.
  if (used.value < cfg.dailyRunCap) return null;

  const waitMs = msUntilUtcDayEnd(now);
  jctx.ports.audit.record({
    action: 'builder.daily_cap',
    actorId: input.row.requesterId,
    guildId: input.row.guildId,
    detail: { requestId: input.row.id, issueNumber: input.issueNumber, used: used.value, cap: cfg.dailyRunCap, waitMs },
  });

  // `>=`, matching the runner EXACTLY: `settleRequeue` dead-letters a retry whose landing time is
  // `>= deadlineAtMs`, and a request that lands one millisecond short of the boundary would be
  // handed to `onDead` and drawn as "Build failed" - the message this check exists to replace.
  if (now + waitMs >= jctx.deadlineAtMs) {
    repo.finish(input.row.id, 'failed', now);
    return { kind: 'failed', error: dailyCapExhaustedError(used.value, cfg.dailyRunCap, waitMs) };
  }

  await jctx.ports.discord.edit(
    input.surface,
    capWaitingCard({
      issueNumber: input.issueNumber,
      used: used.value,
      cap: cfg.dailyRunCap,
      waitMs,
      issueUrl: storedUrl(input.row.issueUrl),
    }),
  );
  return { kind: 'retry', afterMs: waitMs, why: 'the daily agent run cap is full; waiting for the UTC reset' };
}

// ---------------------------------------------------------------------------------------
// The two daily caps, and whether they agree
// ---------------------------------------------------------------------------------------

/**
 * THE NUMBER THE WORKFLOW USES WHEN THE REPOSITORY VARIABLE IS NOT SET.
 *
 * `.github/workflows/agent-implement-request.yml` reads `vars.AGENT_DAILY_RUN_CAP || '4'`. An
 * unset variable is therefore not "no cap" - it is this cap, and comparing the bot's setting
 * against nothing would miss the drift that matters most on a fresh install, where the variable
 * has never been set and somebody has raised `modules.builder.dailyRunCap` in config.
 */
export const WORKFLOW_DEFAULT_DAILY_RUN_CAP = 4;

/**
 * WHETHER THE BOT'S CAP AND THE REPOSITORY'S AGREE - and which direction the disagreement runs,
 * because only one direction hurts.
 *
 * THE ENTRY THIS CLOSES, from `docs/KNOWN-ISSUES.md`: *"The daily cap is now two numbers with
 * nothing reconciling them. Setting the bot's higher is the bad direction - the bot dispatches,
 * the workflow refuses, and the requester is back to the confusing failure this round set out to
 * remove."* The two numbers still exist and still both matter: the workflow's copy is the one
 * that does not trust the bot, and removing it would make a replayed approval unbounded. What
 * was missing was anything that NOTICED they had drifted apart.
 */
export type CapAgreement =
  /** Nothing has been read yet - the boot check has not run, or this build cannot ask. */
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'agrees'; readonly cap: number; readonly source: CapSource }
  /** The bad direction: the bot will dispatch builds the workflow then refuses. */
  | { readonly kind: 'bot-higher'; readonly bot: number; readonly repository: number; readonly source: CapSource }
  /** The harmless direction: the bot queues builds the workflow would have accepted. */
  | { readonly kind: 'bot-lower'; readonly bot: number; readonly repository: number; readonly source: CapSource }
  /**
   * THE VARIABLE IS SET TO SOMETHING THE WORKFLOW WILL REJECT, and this is the loudest arm.
   *
   * It is not a disagreement about a number - it is the absence of a usable number where the
   * workflow demands one. `.github/workflows/agent-implement-request.yml` guards with
   * `case "$DAILY_CAP" in ''|*[!0-9]*) ... exit 1`, so ` 4 `, `4.0`, `+4`, `-1` and `four` all
   * mean EVERY build dispatched from now on dies in its first seconds, with the reason visible
   * only in an Actions log. Nothing else in this union describes a repository where no build
   * can succeed, which is why it could not be folded into `unknown`.
   *
   * It arrived with the integration: the bridge this module first shipped asked the port for
   * `number | null`, which cannot express it.
   */
  | { readonly kind: 'repository-cap-unusable' }
  /** We asked and could not find out. Never a refusal - see `checkDailyCap` for the same rule. */
  | { readonly kind: 'unknown'; readonly why: string };

/** Where the repository's number came from. An unset variable is a real, ordinary answer. */
export type CapSource = 'variable' | 'workflow-default';

/**
 * Compare the two caps. PURE, so the interesting arms are reachable in a test without GitHub.
 *
 * IT IS NEVER FATAL, and that is deliberate rather than lenient. The workflow enforces its own
 * cap and is the authority; a bot that refused to run because it could not read a repository
 * variable would be a bot stopped by an optional token permission, which is the mistake
 * `resolveBuildPayer` and `checkDailyCap` have each already learned once.
 */
export function compareDailyRunCap(reading: DailyCapReading, botCap: number): CapAgreement {
  switch (reading.kind) {
    case 'failed':
      return { kind: 'unknown', why: reading.error.code };
    case 'not-a-number':
      return { kind: 'repository-cap-unusable' };
    case 'unset':
      return classifyCaps(botCap, WORKFLOW_DEFAULT_DAILY_RUN_CAP, 'workflow-default');
    case 'set':
      return classifyCaps(botCap, reading.cap, 'variable');
    default: {
      const exhaustive: never = reading;
      void exhaustive;
      return { kind: 'unchecked' };
    }
  }
}

function classifyCaps(bot: number, repository: number, source: CapSource): CapAgreement {
  if (bot === repository) return { kind: 'agrees', cap: bot, source };
  return bot > repository ? { kind: 'bot-higher', bot, repository, source } : { kind: 'bot-lower', bot, repository, source };
}

/**
 * The sentence `/status` shows an operator.
 *
 * WHY HEALTH AND NOT A LOG LINE ALONE: a warning logged once at boot is a warning nobody reads.
 * The drift is a CONFIGURATION fact that stays true until somebody changes one of the two
 * numbers, so it belongs where an operator goes to ask whether the bot is set up correctly -
 * and it must name both numbers and the lever, because "the caps disagree" is not actionable.
 */
export function capAgreementDetail(agreement: CapAgreement): string {
  switch (agreement.kind) {
    case 'unchecked':
      return 'the repository cap has not been read';
    case 'agrees':
      return agreement.source === 'variable'
        ? 'AGENT_DAILY_RUN_CAP agrees'
        : 'AGENT_DAILY_RUN_CAP is unset and the workflow default agrees';
    case 'bot-higher':
      return (
        `WARNING: this bot allows ${String(agreement.bot)} but the workflow allows ${String(agreement.repository)}` +
        `${agreement.source === 'variable' ? '' : ' (AGENT_DAILY_RUN_CAP is unset, so the workflow default applies)'}` +
        ` - builds past ${String(agreement.repository)} will dispatch and then fail at the workflow's cap step. ` +
        `Raise AGENT_DAILY_RUN_CAP or lower modules.builder.dailyRunCap`
      );
    case 'bot-lower':
      return (
        `this bot allows ${String(agreement.bot)} but the workflow allows ${String(agreement.repository)}` +
        ` - nothing overspends, it only costs throughput`
      );
    case 'repository-cap-unusable':
      return (
        `WARNING: the AGENT_DAILY_RUN_CAP repository variable is not a whole number, so the workflow's own ` +
        `cap step rejects it and EVERY build will fail seconds after it starts. ` +
        `Set AGENT_DAILY_RUN_CAP to a plain number such as 4, or delete it to use the workflow default`
      );
    case 'unknown':
      return `the repository cap could not be read (${agreement.why})`;
    default: {
      const exhaustive: never = agreement;
      void exhaustive;
      return 'the repository cap is unknown';
    }
  }
}

// ---------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------

export default defineModule({
  id: 'builder',
  summary: 'Turn a /request into a reviewed pull request.',
  /**
   * The whole blast radius. `issues` and `builds` are separate words on purpose: filing an
   * issue is cheap and reversible; dispatching a workflow spends money and writes to the repo.
   *
   * `access` IS NEW THIS ROUND, and it is the one line here that deserves an argument.
   * `/request cancel` and `/request list all` both turn on a question this module could not
   * previously ask: **is the person typing an approver?** A requester may cancel their own
   * request; an approver may cancel anybody's and may see the whole pending queue. Without the
   * port the only expressible alternatives were both wrong - let everyone see and cancel
   * everything, or gate the commands on `builder.approve` and lock requesters out of their own
   * work. `AccessPort.check` is a READ of the same allow-list the router consults for the
   * Approve button, so this widens what the module can ASK, not what it can grant: minting or
   * revoking another module's key is impossible from here by construction (`PermissionRef`
   * carries a module-private symbol), and `checkTableOwnership` still refuses `core_access` to
   * the `db` port.
   */
  capabilities: ['db', 'audit', 'clock', 'jobs', 'discord', 'issues', 'builds', 'access'],
  config: z.object({
    workflowFile: z.string().default('agent-implement-request.yml'),
    ref: z.string().default('main'),
    allowSelfApproval: z.boolean().default(false),
    /**
     * NO FREE BUILDS: every requester must supply their own Anthropic credential.
     *
     * DEFAULT TRUE, and the default is the product decision. A build spends real money, and
     * with this off the operator subsidises anyone who can type `/request new` in a server the
     * bot is in. On, the shared `ai-agent` environment is unreachable from a user request: the
     * front door refuses a submission from someone with no credential, `/request retry` refuses
     * for the same reason, and `resolveBuildPayer` refuses again at dispatch, so a credential
     * cleared in between still cannot reach the operator's wallet.
     *
     * THE CONSEQUENCE, stated because it surprises people: the OPERATOR must run
     * `/credentials set` too. There is no owner bypass, on purpose - "no free builds" with a
     * silent exemption for whoever holds the token is not the rule it claims to be, and the
     * exemption would be discovered by accident, in a bill.
     *
     * Set it to `false` to fund a private server yourself; the fallback behaviour is preserved
     * exactly, not merely approximated. See `resolveBuildPayer`.
     */
    requireOwnCredentials: z.boolean().default(true),
    maxConcurrentPerGuild: z.coerce.number().int().positive().default(2),
    /**
     * HOW LONG AN UNAPPROVED REQUEST HOLDS A CONCURRENCY SLOT. Default 48 hours.
     *
     * WHY THIS NUMBER HAS TO EXIST AT ALL, and it is the worst bug this module has had: a
     * request nobody clicks sits in `awaiting_approval` forever, and `activeCounts` counts it.
     * With `maxConcurrentPerGuild` at its default of 2, TWO unclicked requests permanently
     * exhausted a guild. The hourly `expire` job below is what makes this a timeout instead of a
     * leak; `/request list all` is what stops an approver from never learning they were being
     * waited on in the first place; `/request cancel` is the requester's own way out.
     *
     * WHY 48 HOURS and not 2: an approver is a human in another timezone, and expiring a
     * legitimate request before anybody has seen it is its own failure.
     */
    approvalTtlMs: z.coerce.number().int().positive().default(48 * 3_600_000),
    maxDispatchAttempts: z.coerce.number().int().positive().default(3),
    /**
     * HOW MANY TIMES ONE REQUEST MAY BE RE-RUN BY `/request retry`.
     *
     * WHY A CEILING AT ALL: retrying without retyping is exactly the convenience that turns a
     * flaky build into a spend loop. Two is enough to get past a transient GitHub failure or a
     * credential the requester has since fixed, and few enough that a genuinely broken request
     * stops costing money and starts costing somebody a minute of reading the run log.
     *
     * It bounds RE-SPEND, not API flailing: `maxDispatchAttempts` is the ceiling on one
     * dispatch's attempts, and a retry resets that counter because it IS a new dispatch.
     */
    maxRetries: z.coerce.number().int().nonnegative().default(2),
    /**
     * HOW MANY AGENT RUNS THIS REPOSITORY ALLOWS PER UTC DAY - the bot's copy of a number the
     * WORKFLOW already enforces, so the bot can stop burning runs against it.
     *
     * DEFAULT 4, WHICH MUST TRACK `AGENT_DAILY_RUN_CAP`. The workflow reads
     * `vars.AGENT_DAILY_RUN_CAP || '4'`, and the arithmetic behind 4 is in that file: a Free
     * personal account gets 2,000 private Actions minutes a month and this job's ceiling is
     * `timeout-minutes: 30`. An operator who raises the repository variable must raise this too,
     * or the bot queues builds the runner would happily have accepted.
     *
     * NEITHER DIRECTION OF DRIFT CAN OVERSPEND, which is why this duplication is acceptable:
     * set higher than the workflow's, the runner still refuses; set lower, it only costs
     * throughput. The bot's copy is an optimisation, never the authority.
     */
    dailyRunCap: z.coerce.number().int().positive().default(4),
    /**
     * HOW LONG "there is no pull request" MEANS "not yet" RATHER THAN "there never will be".
     *
     * The agent has three legitimate endings and one of them - a deliberate refusal - produces a
     * successful run and NO pull request. Without a bound, that ending was retried as "PR not
     * open yet" until the six-hour deadline turned it into "Build failed", which is the exact
     * opposite of what happened: nothing broke, and the agent explained itself on the issue.
     */
    prGraceMs: z.coerce.number().int().positive().default(120_000),
    pollIntervalMs: z.coerce.number().int().positive().default(15_000),
    buildDeadlineMs: z.coerce.number().int().positive().default(6 * 3_600_000),
    issueFieldMaxLength: z.coerce.number().int().positive().default(4000),
    /**
     * HOW MUCH OF THE REQUEST THE APPROVAL CARD QUOTES.
     *
     * The card used to show an issue number and nothing else, so approving was a decision to
     * spend money on `#42`. Discord caps an embed field value at 1024 characters and the excerpt
     * is one field, so this stays under it; the full text is one click away on the issue, and
     * the card says when it has been shortened rather than presenting half a sentence as the
     * whole idea.
     */
    requestExcerptLength: z.coerce.number().int().positive().max(900).default(700),
    /** How many rows `/request list` shows. Discord allows 25 embed fields; leave headroom. */
    historyLimit: z.coerce.number().int().positive().max(20).default(10),
    /**
     * Channel ids where `/request new` is honoured. EMPTY MEANS EVERYWHERE.
     *
     * WHY empty is permissive here, when `channelAllowsRequests` in the settings adapter is
     * documented fail-closed: `/request new` only FILES AN ISSUE. The thing that spends Actions
     * minutes and Anthropic tokens is `approve`, whose permission fallback is `nobody` — it must
     * be granted explicitly and is never inherited. So the spend gate is already closed, and
     * making the front door closed-by-default too would mean a fresh install where the flagship
     * command silently does nothing with no way to discover why.
     */
    requestChannelIds: z.array(z.string().regex(/^\d{17,20}$/u)).default([]),
  }),
  permissions: {
    // SC-8: two separate keys with separate allow-lists. `approve` spends money, so its
    // fallback is `nobody` - it must be granted, never inherited.
    request: { summary: 'Open a build request', fallback: 'everyone' },
    approve: { summary: 'Approve a build request (spends CI credits)', fallback: 'nobody' },
  },
  publishes: {
    'builder.request_approved': z.object({ requestId: z.string(), issueNumber: z.number(), approverId: z.string() }),
    'builder.pr_opened': z.object({ requestId: z.string(), issueNumber: z.number(), prUrl: z.string() }),
  },
  migrations: true,

  setup(ctx) {
    const repo = buildRepo(ctx.ports.db);
    const cfg = ctx.config;

    /**
     * WHAT THE BOOT CHECK FOUND OUT ABOUT THE REPOSITORY'S OWN CAP.
     *
     * WHY A CLOSURE VARIABLE AND NOT A READ INSIDE `health()`: `/status` is cheap and can be run
     * repeatedly, and this answer is a piece of CONFIGURATION - it changes when an operator
     * edits a repository variable, not between two health checks. Reading it once per boot costs
     * one REST call in the process's lifetime; reading it per health check would put a GitHub
     * round trip inside a command whose whole point is to answer instantly.
     */
    let capAgreement: CapAgreement = { kind: 'unchecked' };

    /**
     * STEP 1 - `/request new` opens a modal.
     *
     * WHY IT IS `request new` AND NOT `request`, which is what it was: Discord forbids a command
     * that is both a leaf and a subcommand container, and `buildCommandPayloads` refuses that
     * shape at deploy time. This round gives `request` three siblings a human genuinely needs -
     * `list`, `cancel`, `retry` - so the bare verb had to move. Naming the management commands
     * something else (`/requests list`, next to `/request`) would be a worse thing to have to
     * remember than one extra word on the command everybody already knows.
     *
     * WHY A SLASH COMMAND AND A MODAL, and not the `$request` prefix this started as:
     *
     *  1. A prefix command needs the MESSAGE CONTENT privileged intent, which was the single
     *     most common setup failure - the bot connects happily, `content` arrives EMPTY, and
     *     the flagship command silently does nothing while every health check says fine.
     *  2. With that intent the bot receives the content of EVERY message in every channel it
     *     can see. This bot forwards text into a GitHub issue and then into an AI agent, so
     *     that is a privacy and attack surface bought for nothing.
     *  3. A modal is a better input than either. A slash STRING OPTION renders as a single-line
     *     box in the client; a `paragraph` field is a real textarea.
     *
     * The command is deliberately cheap: opening a modal spends nothing, so the real rate limit
     * lives on the SUBMIT handler below, which is what files an issue.
     */
    const commands: readonly CommandSpec[] = [
      {
        name: 'request new',
        description: 'Ask for a feature to be built',
        surface: 'guild',
        options: [],
        permission: ctx.perms.request,
        limit: [limit.perUser(10, 60_000)],
        needs: ['SendMessages'],
        // MUST be 'form', and this handler MUST NOT await before returning: Discord forbids
        // defer-then-modal, so one await here is a 100% reproducible production failure that
        // no unit test would see.
        ack: 'form',
        async handle(inv): Promise<Outcome> {
          if (inv.space.guildId === null) return { kind: 'silent' };
          if (cfg.requestChannelIds.length > 0 && !cfg.requestChannelIds.includes(inv.space.channelId)) {
            return {
              kind: 'fail',
              error: errors.forbidden('channel', 'an admin', 'Requests are not accepted in this channel.'),
            };
          }
          return {
            kind: 'form',
            form: {
              customId: assertActionRef({
                moduleId: 'builder',
                action: REQUEST_FORM,
                entityId: newRequestId(inv.at),
                nonce: newCardNonce(),
              }),
              title: 'Request a feature',
              // Exactly Discord's five-component budget: this intro plus four fields.
              intro: 'An approver reviews this before anything is built, and nothing is charged until they approve it.',
              fields: [
                {
                  kind: 'text',
                  name: 'title',
                  label: 'Title',
                  description: 'A short name for it.',
                  style: 'short',
                  required: true,
                  maxLength: 120,
                  placeholder: 'dark mode for the dashboard',
                },
                {
                  kind: 'select',
                  name: 'kind',
                  label: 'Kind of request',
                  description: null,
                  required: true,
                  placeholder: 'Pick one',
                  options: KIND_OPTIONS,
                },
                {
                  kind: 'text',
                  name: 'detail',
                  label: 'What should it do?',
                  description: 'Who needs it and what should happen.',
                  style: 'paragraph',
                  required: true,
                  // Discord's hard cap on a modal text input.
                  maxLength: 4000,
                  placeholder: 'Mods need a way to see who joined this week, newest first.',
                },
                {
                  kind: 'text',
                  name: 'success',
                  label: 'How will we know it worked?',
                  description: 'Optional, but it is what the build is checked against.',
                  style: 'paragraph',
                  required: false,
                  maxLength: 1000,
                  placeholder: 'Running /joined shows the last 7 days of joins, newest first.',
                },
              ],
            },
          };
        },
      },
      // `/request list`, `/request cancel`, `/request retry`. They live in their own file
      // because looking after a request is a different job from approving one - see `history.ts`.
      ...historyCommands({
        repo,
        ports: ctx.ports,
        perms: ctx.perms,
        cfg: {
          historyLimit: cfg.historyLimit,
          maxRetries: cfg.maxRetries,
          maxConcurrentPerGuild: cfg.maxConcurrentPerGuild,
          approvalTtlMs: cfg.approvalTtlMs,
          buildDeadlineMs: cfg.buildDeadlineMs,
          requireOwnCredentials: cfg.requireOwnCredentials,
        },
      }),
    ];

    return {
      commands,

      // ---------------------------------------------------------------------------------
      // STEP 1b - the modal comes back. THIS is what spends, so this is what is limited.
      // ---------------------------------------------------------------------------------
      forms: [
        {
          name: REQUEST_FORM,
          permission: ctx.perms.request,
          // SC-9 verbatim: 3/user/hour AND 20/guild/day. One bucket could not say this.
          limit: [limit.perUser(3, 3_600_000), limit.perGuild(20, 86_400_000)],
          needs: ['SendMessages'],
          // Ephemeral: a validation failure is the submitter's business, not the channel's.
          ack: 'defer-ephemeral',
          idempotency: { kind: 'nonce-and-cas', staleMessage: 'That form was already submitted.' },
          fields: ['title', 'kind', 'detail', 'success'],
          async handle(sub): Promise<Outcome> {
            const guildId = sub.space.guildId;
            if (guildId === null) return { kind: 'silent' };

            // NO FREE BUILDS, REFUSED BEFORE ANYTHING IS FILED.
            //
            // WHY HERE and not at approve time: everything below this line files a GitHub issue
            // and posts an Approve/Reject card. Refusing later would leave a permanent issue in
            // the repository and a card demanding an approver's attention, both for a build that
            // could never have run - litter that somebody has to clean up by hand.
            if (cfg.requireOwnCredentials) {
              const gate = await requireOwnCredentialsGate(ctx.ports.builds, sub.actor.userId);
              if (!gate.ok) return { kind: 'fail', error: gate.error };
            }

            // Redact THEIR secrets before the text reaches an issue, a log or an audit row.
            const rawTitle = redactUserSecrets(sub.fields.textRequired('title'));
            const body = redactUserSecrets(sub.fields.textRequired('detail'));
            const title = toPlainName(rawTitle, { maxLength: 120 });
            if (!title.ok) return { kind: 'fail', error: title.error };
            // Optional, and the one field a build is checked against. Blank means "not given".
            const successRaw = sub.fields.text('success');
            const success = successRaw === undefined ? undefined : redactUserSecrets(successRaw);
            const successGiven =
              success !== undefined && renderSafeMarkdown(toMarkdown(success, { maxLength: 1000 }).md).trim().length > 0
                ? success
                : undefined;
            // Re-validated against the allow-list: the client echoes this value back.
            const kind = sub.fields.choice('kind', REQUEST_KINDS);
            if (!kind.ok) return { kind: 'fail', error: kind.error };

            // WHAT IS BEING APPROVED, quoted for the approver.
            //
            // `toMarkdown` is one of the named doors out of `UserText` - NFKC, invisibles
            // stripped, mentions defanged, HTML comments and code fences neutralised, then cut
            // on CODE POINTS. It is the same wall `fence` puts around the issue body, used for a
            // different sink; nothing here invents a new door, and nothing here writes an issue.
            const quoted = toMarkdown(body, { maxLength: cfg.requestExcerptLength });
            const excerpt: RequestExcerpt = { md: quoted.md, truncated: quoted.truncated };

            // The id inside the modal's custom_id is NOT reused: it was minted before anyone
            // typed anything, and a modal can be opened and abandoned. Minting here means one
            // row per actual submission.
            const id = newRequestId(sub.at);
            const cardNonce = newCardNonce();
            const fenceNonce = newFenceNonce();

            // CLAIM THE SLOT AND WRITE THE ROW IN ONE STATEMENT - the check-then-act race,
            // closed.
            //
            // THE OLD SHAPE, and why it read as correct for several rounds: `activeCounts` was
            // consulted a few lines up, `insertDraft` ran here, and everything between them was
            // synchronous - so it LOOKED atomic. It was not, because the row was inserted in
            // `draft`, a state `activeCounts` did not count, and it only became countable at
            // `recordIssue` below - AFTER two network round trips. Every submission that arrived
            // during those seconds read a count that could not see the ones already in flight,
            // so a guild capped at 2 could run 5. `/request retry` was a third entrance to it.
            //
            // `claimSlot` counts `draft` and inserts under the same predicate, so the row is
            // visible to the next reader's count in the same statement that admitted it.
            if (!repo.claimSlot(
              {
                id,
                state: 'draft',
                version: 1,
                guildId,
                requesterId: sub.actor.userId,
                nonce: cardNonce,
                fenceNonce,
                // PERSISTED THIS ROUND. The title was rendered once and dropped, so `/request
                // list` would have had nothing but issue numbers to show - and a list of
                // integers is not something anybody can act on.
                title: renderPlainName(title.value),
                issueNumber: null,
                issueUrl: null,
                runId: null,
                runUrl: null,
                dispatchAttempts: 0,
                succeededAt: null,
                surfaceJson: null,
              },
              sub.at,
              cfg.maxConcurrentPerGuild,
            )) {
              // THE REFUSAL THAT USED TO BE A LIE. "Too many builds are already in flight here."
              // was said to everybody - including guilds whose slots were held entirely by
              // requests nobody had clicked, where waiting was the one thing that never worked.
              return { kind: 'fail', error: concurrencyError(repo.activeCounts(guildId), cfg.approvalTtlMs) };
            }

            // SC-3 layer 4, as a type: the ONLY producer of an `IssueBody` is `buildIssueBody`,
            // and the only producer of a `FencedField` is `fence`. There is no parameter here
            // through which unfenced user text could enter.
            const issue = await ctx.ports.issues.create({
              title: title.value,
              body: buildIssueBody({
                nonce: fenceNonce,
                title: title.value,
                fields: [
                  fence('Idea', body, fenceNonce, { maxLength: cfg.issueFieldMaxLength }),
                  // Fenced like the idea: it is the requester's text, so it is DATA to the agent.
                  ...(successGiven === undefined
                    ? []
                    : [fence('How we will know it worked', successGiven, fenceNonce, { maxLength: cfg.issueFieldMaxLength })]),
                ],
                meta: { requestId: actionsToken.ulid(id) },
              }),
              // The kind is a fixed allow-list value, so it travels as a label, never as text.
              labels: kind.value === undefined ? ['bot:request'] : ['bot:request', kindIssueLabel(kind.value)],
            });
            // EVERY FAILURE PATH FROM HERE ON MUST HAND THE SLOT BACK. The claim is now real -
            // it occupies a slot the moment it commits - so a submission that dies before it
            // files an issue would otherwise take a slot away from the guild permanently, which
            // is the bug the cap exists to prevent, caused by the fix for it.
            if (!issue.ok) {
              repo.releaseDraft(id);
              return { kind: 'fail', error: issue.error };
            }

            // WHY the module posts the card itself rather than returning `{kind:'view'}`: it
            // needs the durable `SurfaceRef` to persist, and an ephemeral modal acknowledgement
            // is not a card an approver could ever click.
            const posted = await ctx.ports.discord.post(
              sub.space.channelId,
              approvalCard({
                id,
                nonce: cardNonce,
                title: sanitizeStored(renderPlainName(title.value)),
                excerpt,
                kind: kind.value ?? null,
                success: successGiven === undefined ? null : toMarkdown(successGiven, { maxLength: cfg.requestExcerptLength }).md,
                requesterId: sub.actor.userId,
                issueNumber: issue.value.number,
                issueUrl: issue.value.url,
                retryCount: 0,
              }),
            );
            if (!posted.ok) {
              repo.releaseDraft(id);
              // AND CLOSE THE ISSUE WE JUST FILED. Without a card there is no approver, no
              // outcome and now no row either, so an open issue here is a request that exists
              // only on GitHub and can never be acted on from the product - exactly the litter
              // Reject and the expiry sweep both close. Best-effort: the submission has already
              // failed and a second failure must not change what the user is told.
              await ctx.ports.issues.close(issue.value.number, 'not_planned');
              return { kind: 'fail', error: posted.error };
            }

            repo.recordIssue(id, issue.value.number, issue.value.url, posted.value, sub.at);
            ctx.ports.audit.record({
              action: 'builder.request',
              actorId: sub.actor.userId,
              guildId,
              detail: { requestId: id, issueNumber: issue.value.number },
            });
            return {
              kind: 'view',
              view: {
                accent: 'ok',
                ephemeral: true,
                nodes: [
                  {
                    kind: 'text',
                    md: md`Filed as issue ${mdInlineCode('#' + String(issue.value.number))}. An approver must approve it before anything is built, and you will be pinged on the card whichever way it goes. ${mdInlineCode('/request list')} shows where it got to.`,
                  },
                ],
              },
            };
          },
        },
      ],

      // ---------------------------------------------------------------------------------
      // STEP 2 - the Approve button. All four SC-10 checks, in order.
      // ---------------------------------------------------------------------------------
      actions: [
        {
          name: APPROVE,
          permission: ctx.perms.approve,
          limit: [limit.perUser(30, 60_000)],
          needs: ['SendMessages'],
          ack: 'defer-update',
          idempotency: {
            kind: 'nonce-and-cas',
            staleMessage: 'Someone approved this a moment before you did.',
          },
          async handle(click): Promise<Outcome> {
            // (1) load the entity and assert an actionable state.
            const id = toRequestId(click.ref.entityId);
            if (!id.ok) return { kind: 'fail', error: id.error };
            const row = repo.get(id.value);
            if (row === undefined) return { kind: 'fail', error: errors.notFound('request', 'Open a new request.') };
            if (row.state !== 'awaiting_approval') {
              return { kind: 'fail', error: errors.conflict('state', 'That request is not waiting for approval.', 'Open a new request.', row.state) };
            }
            // (2) authorization already re-ran against the CLICKER, in the router.
            // (3) compare the stored nonce to the one in the custom_id. This is also what makes
            //     a card superseded by `/request retry` inert: re-arming mints a new nonce, so a
            //     click on the old "Expired" card's buttons cannot approve the live request.
            const stored = toCardNonce(row.nonce);
            if (!stored.ok) return { kind: 'fail', error: stored.error };
            if (stored.value !== click.ref.nonce) {
              return { kind: 'fail', error: errors.conflict('stale_card', 'That card has been superseded.', 'Scroll down to the current card.') };
            }
            // SC-8: separation of duty, IN ADDITION to the permission check.
            if (!cfg.allowSelfApproval && row.requesterId === click.actor.userId) {
              return { kind: 'fail', error: errors.forbiddenSelfApproval('builder.approve') };
            }
            const issueNumber = row.issueNumber;
            if (issueNumber === null) {
              return { kind: 'fail', error: errors.conflict('no_issue', 'That request has no issue yet.', 'Open a new request.') };
            }
            // (4) compare-and-set. `changes === 0` means someone else won; never retried.
            //
            // THE APPROVAL ID IS MINTED FIRST AND WRITTEN IN THE SAME STATEMENT. It is what the
            // workflow consumes once and refuses twice, so exactly one row may ever hold it,
            // and the row that holds it must be the one whose click won. Writing it after the
            // CAS would let the loser stamp its id over the winner's row.
            const approvalId = newApprovalId();
            if (!repo.compareAndSet(id.value, row.version, 'dispatching', click.at, { approvalId })) {
              return { kind: 'fail', error: errors.conflict('cas', 'Someone approved this a moment before you did.', 'Nothing more to do.') };
            }

            ctx.ports.audit.record({
              action: 'builder.approve',
              actorId: click.actor.userId,
              guildId: click.space.guildId,
              detail: { requestId: id.value, issueNumber, approvalId },
              decisionLayer: 'L1-allowlist',
            });
            ctx.emit('builder.request_approved', { requestId: id.value, issueNumber, approverId: click.actor.userId });

            // THE 15-MINUTE ANSWER. The card is posted now, inside the token window; the job
            // describes the 5-30 minutes of work that will update it later. The router injects
            // this card's SurfaceRef into the payload and commits the enqueue in the same
            // transaction, so there is no window in which a dispatch outlives its poller.
            return {
              kind: 'handoff',
              view: buildingCard({
                issueNumber,
                issueUrl: storedUrl(row.issueUrl),
                runUrl: null,
                title: row.title,
                approverId: click.actor.userId,
              }),
              job: {
                type: 'build',
                payload: { requestId: id.value, issueNumber, approverId: click.actor.userId },
                runAfterMs: click.at,
                deadlineAtMs: click.at + cfg.buildDeadlineMs,
                // The row's own retry counter, so a re-armed request's poller cannot be dropped
                // as a duplicate of the dead job it replaces. See `buildDedupeKey`.
                dedupeKey: buildDedupeKey(id.value, row.retryCount),
              },
            };
          },
        },
        {
          name: REJECT,
          permission: ctx.perms.approve,
          limit: [limit.perUser(30, 60_000)],
          needs: ['SendMessages'],
          ack: 'defer-update',
          idempotency: { kind: 'nonce-and-cas', staleMessage: 'Already resolved.' },
          async handle(click): Promise<Outcome> {
            const id = toRequestId(click.ref.entityId);
            if (!id.ok) return { kind: 'fail', error: id.error };
            const row = repo.get(id.value);
            if (row === undefined || row.state !== 'awaiting_approval') {
              return { kind: 'fail', error: errors.conflict('state', 'That request is already resolved.', 'Nothing more to do.') };
            }
            if (!repo.compareAndSet(id.value, row.version, 'rejected', click.at)) {
              return { kind: 'fail', error: errors.conflict('cas', 'Already resolved.', 'Nothing more to do.') };
            }

            // Close the issue too. Without this a rejected request left an open issue behind
            // forever, and the next reader had no way to tell "not built yet" from "refused".
            // `not_planned` rather than `completed` so it does not read as shipped.
            //
            // A failure here is deliberately NOT fatal: the row is already `rejected`, which is
            // the state that governs spend, so the worst case is a stale open issue rather than
            // a build nobody approved. We tell the approver instead of pretending it worked.
            let issueClosed = true;
            if (row.issueNumber !== null) {
              const closed = await ctx.ports.issues.close(row.issueNumber, 'not_planned');
              issueClosed = closed.ok;
              if (!closed.ok) {
                ctx.ports.audit.record({
                  action: 'builder.reject.close_failed',
                  actorId: click.actor.userId,
                  guildId: click.space.guildId,
                  detail: { requestId: id.value, issueNumber: row.issueNumber, reason: closed.error.kind },
                });
              }
            }
            // A REJECTION IS A TERMINAL OUTCOME, so it pings like every other one. It used to be
            // an unannounced edit to a card in a channel, which meant the one person who needed
            // to know found out by going back and looking - if they ever did.
            //
            // The returned view REPLACES the card (this is `defer-update`), which is also what
            // removes the Approve/Reject pair: an edit replaces every component, so a separate
            // `disableComponents` round trip could only fail.
            const tell: Mention = pingRequesterUnless(row.requesterId, click.actor.userId);
            const card = rejectedCard(issueClosed, tell);
            // The requester pressed Reject themselves: nobody to tell, so replace the card in place.
            if (tell.mentionUserId === undefined) return { kind: 'view', view: card };
            // Otherwise the rejection is POSTED (a replaced message notifies nobody) and the
            // stale card deleted, so the click itself has nothing left to edit.
            const moved = await deliverOutcome(ctx.ports.discord, click.surface, card);
            if (moved.messageId !== click.surface.messageId) repo.recordSurface(id.value, moved, click.at);
            return { kind: 'silent' };
          },
        },
      ],

      // ---------------------------------------------------------------------------------
      // STEP 3 - the durable job. Dispatches, then polls, then posts the PR link.
      // ---------------------------------------------------------------------------------
      jobs: [
        {
          type: 'build',
          maxAttempts: 240,
          deadlineMs: cfg.buildDeadlineMs,
          backoff: { initialMs: cfg.pollIntervalMs, factor: 1.5, maxMs: 60_000, jitter: 0.2 },
          needs: ['SendMessages'],
          async run(jctx, payload) {
            const p = readPayload(payload);
            if (!p.ok) return { kind: 'failed', error: p.error };
            const surface = readSurface(payload);
            if (!surface.ok) return { kind: 'failed', error: surface.error };

            const row = repo.get(p.value.id);
            if (row === undefined) {
              return { kind: 'failed', error: errors.notFound('request', 'Open a new request.') };
            }

            // THE RUN LINK, THE MOMENT IT EXISTS. The Approve click drew this card before any
            // run did; re-draw it as soon as the run is known so the person waiting can watch.
            // Best-effort: a failed edit costs a link, never the build, so it is logged and
            // the job carries on.
            const showRunLink = async (runUrl: HttpsUrl): Promise<void> => {
              const edited = await jctx.ports.discord.edit(
                surface.value,
                buildingCard({
                  issueNumber: p.value.issueNumber,
                  issueUrl: storedUrl(row.issueUrl),
                  runUrl,
                  title: row.title,
                  approverId: p.value.approverId,
                }),
              );
              if (!edited.ok) {
                jctx.logger.warn('could not add the run link to the card', { requestId: p.value.id, code: edited.error.code });
              }
            };

            // SOMEBODY ALREADY SETTLED THIS - which, before `/request cancel` existed, could not
            // happen and so was not checked.
            //
            // WHY IT IS NOT ENOUGH TO CANCEL THE JOB: `jobs.cancel` cannot reach an attempt the
            // runner has already leased, and it reports `false` for one it cannot stop. Without
            // this guard a request cancelled a second before its first attempt walked straight
            // into the dispatch branch below and SPENT - the one outcome cancelling must never
            // produce.
            //
            // `done`, not `failed`: the row is terminal because a human decided it should be,
            // and its card already says so. Reporting a failure would draw over that.
            if (isTerminalState(row.state)) {
              jctx.logger.info('build job stopping: the request is already resolved', {
                requestId: p.value.id,
                state: row.state,
              });
              return { kind: 'done' };
            }

            // First pass: dispatch. `dispatch` returns a union, so the 204/blind case cannot be
            // forgotten - the caller MUST write the run-name fallback.
            if (row.runId === null) {
              if (row.dispatchAttempts >= cfg.maxDispatchAttempts) {
                // TERMINAL, like a failed run: finish the row so `/request retry` accepts it and
                // the concurrency slot is released, and return a non-retryable error so the job
                // dead-letters now instead of retrying "out of attempts" until the deadline.
                repo.finish(p.value.id, 'failed', jctx.ports.clock.now());
                return { kind: 'failed', error: dispatchExhaustedError() };
              }
              // WHICH APPROVAL THIS SPENDS. Read off the row, never the payload, and refused
              // when absent - see `noApprovalIdError`. Finished `failed` first so the slot is
              // released and `/request retry` accepts the row.
              if (row.approvalId === null) {
                repo.finish(p.value.id, 'failed', jctx.ports.clock.now());
                return { kind: 'failed', error: noApprovalIdError() };
              }
              const approvalId = toApprovalId(row.approvalId);
              if (!approvalId.ok) {
                repo.finish(p.value.id, 'failed', jctx.ports.clock.now());
                return { kind: 'failed', error: approvalId.error };
              }
              // WHY re-validated here: `WorkflowFile` is branded, so a free-text config value
              // cannot reach `dispatch` without passing this.
              const wf: Result<WorkflowFile, AppError> = toWorkflowFile(cfg.workflowFile);
              if (!wf.ok) return { kind: 'failed', error: wf.error };
              const gitRef: Result<GitRef, AppError> = toGitRef(cfg.ref);
              if (!gitRef.ok) return { kind: 'failed', error: gitRef.error };

              // IS THERE A RUN LEFT TODAY? Asked BEFORE anything is spent and BEFORE a dispatch
              // attempt is counted, because being over cap is not this request's fault and must
              // not consume its ceiling.
              const capped = await checkDailyCap(jctx, repo, cfg, {
                workflowFile: wf.value,
                row,
                issueNumber: p.value.issueNumber,
                surface: surface.value,
              });
              if (capped !== null) return capped;

              // WHOSE CREDENTIALS PAY, decided before a single Actions minute is spent. This
              // also fails the build here, with a sentence naming the cause, in the two cases
              // that would otherwise surface as an opaque auth error half an hour into a run:
              // the requester's environment has been emptied, or nothing anywhere can pay.
              //
              // AND IT IS THE SECOND CREDENTIAL CHECK, DELIBERATELY. `/request new` already
              // refused anyone without a credential, but that was minutes to days ago; a user
              // can run `/credentials clear`, or have a key revoked, between being filed and
              // being approved.
              const payer = await resolveBuildPayer(jctx.ports.builds, row.requesterId, cfg.requireOwnCredentials);
              if (!payer.ok) {
                // A GitHub blip must not burn the request; only a real "no credentials" answer
                // is terminal, and those two AppErrors are not retryable.
                return payer.error.retryable
                  ? retryAfter(payer.error, cfg.pollIntervalMs, 'could not read the build credentials')
                  : { kind: 'failed', error: payer.error };
              }
              // ONE derivation, used by both the MAC and the dispatch input below. They must be
              // byte-identical or the workflow's approval gate rejects every attempt.
              const environmentName = buildEnvironmentName(payer.value);
              // Billing attribution, written before the spend rather than inferred afterwards.
              jctx.ports.audit.record({
                action: 'builder.dispatch.environment',
                actorId: row.requesterId,
                guildId: row.guildId,
                detail: { requestId: p.value.id, environmentName, byo: payer.value !== null, approvalId: approvalId.value },
              });

              // The approval MAC binds this dispatch to THIS issue body AND to the environment
              // that pays for it, and the workflow refuses to spend anything without it. The
              // digest must be of the body as GitHub returns it, so we read it back rather than
              // hashing what we sent - see BuildsPort.signApproval.
              const bodySha = await jctx.ports.issues.bodySha256(p.value.issueNumber);
              if (!bodySha.ok) {
                return retryAfter(bodySha.error, cfg.pollIntervalMs, 'could not read the issue body digest');
              }
              // SIGNED NOW, NOT AT THE CLICK. The workflow refuses a token issued more than
              // APPROVAL_MAX_AGE_SECONDS before the run was created, and a request can wait
              // behind the daily cap or a GitHub outage for hours between Approve and here. One
              // instant, read once: the row remembers it, the token signs it, and the dispatch
              // input carries it, so the three cannot disagree. Seconds on the wire because the
              // verifier compares it to the run's `created_at` in seconds.
              const issuedAtMs = jctx.ports.clock.now();
              const issuedAtSec = Math.floor(issuedAtMs / 1000);
              const approvalToken = jctx.ports.builds.signApproval({
                requestId: p.value.id,
                approvalId: approvalId.value,
                issueNumber: p.value.issueNumber,
                bodySha256: bodySha.value,
                // MUST be the identical string sent as `environment_name` below. Signing one
                // value and dispatching another is rejected by the workflow's gate on every
                // attempt.
                environmentName,
                issuedAtSec,
              });

              // MUST appear in the workflow's `run-name`, which is
              // `agent <request_id> -> issue #<issue_number> approval <approval_id>`.
              // Correlation is a substring match.
              const runName = actionsToken.ulid(p.value.id);

              // COUNT THIS ATTEMPT, BEFORE THE NETWORK CALL.
              //
              // BEFORE, not after, and that ordering is the whole point: a crash, a SIGTERM or a
              // lease expiry between here and the response leaves a run that may well have been
              // created and paid for. Counting afterwards makes exactly that case free, which is
              // the one case a ceiling exists to bound. The same call stamps `approval_issued_at`
              // with the instant the token above was signed with.
              repo.countDispatchAttempt(p.value.id, issuedAtMs);

              const out = await jctx.ports.builds.dispatch({
                workflowFile: wf.value,
                ref: gitRef.value,
                // SC-1: `ActionsInput = number | boolean | ActionsToken`. A string here is
                // TS2322, so there is nothing for `${{ }}` to interpolate.
                inputs: {
                  request_id: actionsToken.ulid(p.value.id),
                  issue_number: p.value.issueNumber,
                  branch: actionsToken.agentBranch(p.value.id),
                  approval_token: approvalToken,
                  // Both signed into `approval_token` above. The workflow consumes `approval_id`
                  // once (a second run carrying it is refused) and bounds the age of
                  // `approval_issued_at` against the run's own creation time.
                  approval_id: actionsToken.uuid(approvalId.value),
                  approval_issued_at: issuedAtSec,
                  // NON-SECRET on purpose: GitHub masks `secrets.*` and never masks `inputs.*`,
                  // so this is readable in the run title, the REST API and the job log. It names
                  // an environment; it is not a credential. What makes it unforgeable is that
                  // `approval_token` above signs it.
                  environment_name: actionsToken.buildEnvironment(payer.value),
                },
                runName,
              });
              if (!out.ok) {
                // A failed dispatch is a `retry`, which the job runner never logs - so this is the only trace.
                jctx.logger.warn('dispatch failed', { requestId: p.value.id, code: out.error.code, internal: out.error.internal });
                return retryAfter(out.error, cfg.pollIntervalMs, 'dispatch failed; will retry');
              }

              // `clock.now()`, not `jctx.deadlineAtMs`: this argument is `updated_at`, and
              // stamping it hours into the future told the reconciler that a row it may need to
              // re-adopt had just been touched.
              if (out.value.kind === 'adopted') {
                repo.recordRun(p.value.id, out.value.run.runId, out.value.run.runUrl, jctx.ports.clock.now());
                const adoptedUrl = storedUrl(out.value.run.runUrl);
                if (adoptedUrl !== null) await showRunLink(adoptedUrl);
                return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'dispatched; polling' };
              }
              // Blind dispatch (HTTP 204, empty body): correlate by run-name instead.
              const found = await jctx.ports.builds.findRunByName(out.value.correlateBy, 0);
              if (found.ok && found.value !== null) {
                repo.recordRun(p.value.id, found.value.runId, found.value.runUrl, jctx.ports.clock.now());
                const foundUrl = storedUrl(found.value.runUrl);
                if (foundUrl !== null) await showRunLink(foundUrl);
              }
              return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'dispatched blind; correlating' };
            }

            // Subsequent passes: poll. `retry` does NOT consume an attempt, so a 30-minute
            // build cannot exhaust `maxAttempts` and tell the user it failed while the PR is
            // open - which is what happened when "still running" was expressed as an error.
            const status = await jctx.ports.builds.runStatus(row.runId);
            if (!status.ok) return retryAfter(status.error, cfg.pollIntervalMs, 'poll failed');

            // KEEP THE RUN LOG URL THE MOMENT ANYTHING REPORTS IT, finished or not: the frame
            // that renders the failure card is `onDead`, which holds no `RunStatus` at all.
            const seenRunUrl = status.value.runUrl;
            if (row.runUrl === null && seenRunUrl !== null) {
              repo.recordRunUrl(p.value.id, seenRunUrl, jctx.ports.clock.now());
              // Only while it is still running: an ending below draws its own card.
              const seenUrl = storedUrl(seenRunUrl);
              if (seenUrl !== null && (status.value.kind === 'queued' || status.value.kind === 'in-progress')) {
                await showRunLink(seenUrl);
              }
            }
            const issueLink = storedUrl(row.issueUrl);
            // THE PING. Every arm below is an ENDING, and an ending that notifies nobody is the
            // defect this round exists to close: the requester waited twenty minutes and the
            // answer arrived as a silent edit to a message that had scrolled away.
            // `pingRequester` reads the persisted snowflake and proves it before mentioning it.
            const tell: Mention = pingRequester(row.requesterId);

            switch (status.value.kind) {
              case 'queued':
              case 'in-progress':
                return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'still building' };
              case 'success':
              case 'failure': {
                // THE CONCLUSION IS NOT THE ANSWER. A red run can have opened a perfectly good
                // pull request (the turn limit ends it as a failure), and a green run with no PR
                // can be a blocked push rather than a refusal. `classifyEnding` reads the PR and
                // the workflow's own report instead - see `ending.ts`.
                const pr = await jctx.ports.builds.findPrForBranch(agentBranchName(p.value.id));
                if (!pr.ok) return retryAfter(pr.error, cfg.pollIntervalMs, 'looking for the PR');
                const report = await jctx.ports.builds.findRunReport(p.value.issueNumber, row.runId);
                if (!report.ok) return retryAfter(report.error, cfg.pollIntervalMs, 'reading the run report');

                // A REPLAY REFUSAL IS USUALLY OUR OWN EARLIER RUN. The workflow consumes each
                // approval id once; if this run was refused because the id had already been
                // used, the honest case is a dispatch whose answer this process never saw (a
                // crash after the POST) followed by a re-dispatch of the same approval. The
                // build the requester paid for is the EARLIER run, so the poller follows it
                // instead of drawing a failure card over a build that is going fine. The search
                // excludes this refused run (its name carries the same id) and starts from the
                // first attempt, not the latest, because attempts can be hours apart. Finding
                // nothing means the earlier run was not ours - the hostile-replay case - and
                // `classifyEnding` draws the refusal.
                if (report.value?.failedStep === 'approval_replayed' && row.approvalId !== null) {
                  const earlierId = toApprovalId(row.approvalId);
                  if (earlierId.ok) {
                    const since = (row.firstDispatchAt ?? row.createdAt) - REPLAY_ADOPT_SLACK_MS;
                    const earlier = await jctx.ports.builds.findRunByName(actionsToken.uuid(earlierId.value), since, row.runId);
                    if (!earlier.ok) return retryAfter(earlier.error, cfg.pollIntervalMs, 'looking for the run this approval already started');
                    if (earlier.value !== null) {
                      const adoptedAt = jctx.ports.clock.now();
                      repo.adoptRun(p.value.id, earlier.value.runId, earlier.value.runUrl, adoptedAt);
                      jctx.logger.warn('adopted the earlier run of a replayed approval', {
                        requestId: p.value.id,
                        refusedRunId: row.runId,
                        adoptedRunId: earlier.value.runId,
                      });
                      jctx.ports.audit.record({
                        action: 'builder.run_adopted',
                        actorId: row.requesterId,
                        guildId: row.guildId,
                        detail: { requestId: p.value.id, issueNumber: p.value.issueNumber, refusedRunId: row.runId, adoptedRunId: earlier.value.runId, approvalId: earlierId.value },
                      });
                      return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'adopted the earlier run of this approval; polling' };
                    }
                  }
                }

                const ending = classifyEnding({ runSucceeded: status.value.kind === 'success', pr: pr.value, report: report.value });
                const now = jctx.ports.clock.now();
                const runLink = seenRunUrl ?? storedUrl(row.runUrl);
                // One message per request: an ending that pings is posted as the final card and
                // the stale one deleted, so the row must follow it to the new message.
                const finishCard = async (card: View): Promise<void> => {
                  const moved = await deliverOutcome(jctx.ports.discord, surface.value, card);
                  if (moved.messageId !== surface.value.messageId) repo.recordSurface(p.value.id, moved, now);
                };

                switch (ending.kind) {
                  case 'no-pr-yet': {
                    // A clean run from a workflow that posts no report: the PR may be a second
                    // away, so wait `prGraceMs` before calling it.
                    const since = row.succeededAt ?? now;
                    if (row.succeededAt === null) repo.noteRunSucceeded(p.value.id, now);
                    if (now - since < cfg.prGraceMs) {
                      return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'PR not open yet' };
                    }
                    repo.finish(p.value.id, 'failed', now);
                    return { kind: 'failed', error: noPrError() };
                  }
                  case 'refused': {
                    await finishCard(refusedCard(p.value.issueNumber, issueLink, tell, ending.reason));
                    jctx.ports.audit.record({
                      action: 'builder.refused',
                      actorId: row.requesterId,
                      guildId: row.guildId,
                      detail: { requestId: p.value.id, issueNumber: p.value.issueNumber, runId: row.runId },
                    });
                    // TERMINAL, and deliberately not `failed`: the run did what it was asked to do.
                    repo.finish(p.value.id, 'done', now);
                    return { kind: 'done' };
                  }
                  case 'blocked': {
                    await finishCard(blockedCard(ending.pr?.url ?? null, issueLink, runLink, tell));
                    jctx.ports.audit.record({
                      action: 'builder.run_failed',
                      actorId: row.requesterId,
                      guildId: row.guildId,
                      detail: { requestId: p.value.id, issueNumber: p.value.issueNumber, runId: row.runId, conclusion: 'forbidden_path' },
                    });
                    repo.finish(p.value.id, 'failed', now);
                    return { kind: 'done' };
                  }
                  case 'failed': {
                    // WHY THE ERROR MUST BE NON-RETRYABLE: the runner retries a `failed` outcome
                    // whose error `isRetryable`, so a run that had ALREADY finished was re-polled
                    // for hours. Every `failureError` is a settled `conflict`. `onDead` draws it.
                    jctx.ports.audit.record({
                      action: 'builder.run_failed',
                      actorId: row.requesterId,
                      guildId: row.guildId,
                      detail: { requestId: p.value.id, issueNumber: p.value.issueNumber, runId: row.runId, conclusion: ending.error.code },
                    });
                    repo.finish(p.value.id, 'failed', now);
                    return { kind: 'failed', error: ending.error };
                  }
                  case 'pr-ready':
                  case 'pr-unfinished': {
                    // THE MOMENT THE WHOLE PRODUCT IS FOR - a fresh REST call keyed on ids we
                    // persisted, with no interaction or token anywhere in this frame.
                    const prUrl = ending.pr.url;
                    await finishCard(
                      ending.kind === 'pr-ready'
                        ? openedCard(prUrl, issueLink, tell, ending.summary)
                        : draftPrCard(prUrl, issueLink, tell, ending.why, ending.remaining),
                    );
                    // KEEP THE PULL REQUEST URL, or `/request list` shows a finished build with
                    // nothing to open.
                    repo.recordPrUrl(p.value.id, prUrl, now);
                    // TERMINAL for the ROW too, or `activeCounts` keeps counting it forever.
                    repo.finish(p.value.id, 'pr_open', now);
                    jctx.emit('builder.pr_opened', { requestId: p.value.id, issueNumber: p.value.issueNumber, prUrl });
                    return { kind: 'done' };
                  }
                  default: {
                    const exhaustive: never = ending;
                    void exhaustive;
                    return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'unknown ending' };
                  }
                }
              }
              case 'cancelled': {
                // THE RUN was cancelled inside GitHub, which is NOT the same event as
                // `/request cancel` and must not be reported as though a human here did it.
                // Either way it is an ENDING, so it draws a card and pings, instead of
                // dead-lettering into "Build failed" as it used to.
                const cancelRunUrl = seenRunUrl ?? storedUrl(row.runUrl);
                const moved = await deliverOutcome(
                  jctx.ports.discord,
                  surface.value,
                  cancelledCard({
                    issueNumber: p.value.issueNumber,
                    issueUrl: issueLink,
                    runUrl: cancelRunUrl,
                    // NOT `wasRunning: true` any more, and the change is a correction. That
                    // boolean selected the sentence "the GitHub Actions run itself keeps going",
                    // which is the one thing that is definitely false about a run GitHub has
                    // just reported as CANCELLED - and it attributed the cancellation to "an
                    // approver", who did not do it either.
                    run: { kind: 'stopped-in-github' },
                    issueClosed: false,
                    by: 'github',
                    buttons: [],
                    mention: tell,
                  }),
                );
                if (moved.messageId !== surface.value.messageId) repo.recordSurface(p.value.id, moved, jctx.ports.clock.now());
                repo.finish(p.value.id, 'cancelled', jctx.ports.clock.now());
                return { kind: 'done' };
              }
              default: {
                const exhaustive: never = status.value;
                void exhaustive;
                return { kind: 'retry', afterMs: cfg.pollIntervalMs, why: 'unknown status' };
              }
            }
          },

          /** REQUIRED. Without it, a failed build looks exactly like a bot that hung. */
          async onDead(jctx, payload, last) {
            const surface = readSurface(payload);
            if (!surface.ok) {
              jctx.logger.error('build died with no surface', { code: last.code });
              return;
            }
            // WHY THE ROW IS RE-READ HERE: this frame has an error and a surface and nothing
            // else, and "Open the run log from the issue" was the entire diagnosis instruction.
            const dead = readPayload(payload);
            const row = dead.ok ? repo.get(dead.value.id) : undefined;
            // The one message a requester most needs, and was least likely to see.
            const tell: Mention = row === undefined ? {} : pingRequester(row.requesterId);
            const failRunUrl = storedUrl(row?.runUrl ?? null);
            // The failed card carries only link buttons, so no `disableComponents` call: it would
            // strip the Run log link, and the Approve/Reject pair went with the earlier edit.
            const moved = await deliverOutcome(
              jctx.ports.discord,
              surface.value,
              failedCard(last, storedUrl(row?.issueUrl ?? null), failRunUrl, tell),
            );
            if (!dead.ok) return;
            const now = jctx.ports.clock.now();
            if (moved.messageId !== surface.value.messageId) repo.recordSurface(dead.value.id, moved, now);
            // The job is dead, so nothing else will ever move this row. Finish it here or the
            // slot leaks exactly as it would on success.
            repo.finish(dead.value.id, 'failed', now);
          },

          /** REQUIRED. A payload written by an older deploy is a real event, not a crash. */
          async onUnparseable(jctx, payload) {
            jctx.logger.warn('build payload from an older version; dropping', {
              keys: Object.keys(payload).join(','),
            });
          },
        },

        // ---------------------------------------------------------------------------------
        // STEP 4 - THE RELEASE VALVE. Nobody clicked, so the request lets go of the slot.
        // ---------------------------------------------------------------------------------
        {
          /**
           * THE JOB THAT UNBRICKS A GUILD.
           *
           * `expired` was declared in three places - the `BuildState` union, the SQL CHECK
           * constraint, and the terminal list `finish` guards on - and written by nothing. So
           * `awaiting_approval` was, in practice, a permanent state, and TWO requests nobody
           * clicked refused every later `/request` in that guild forever.
           *
           * IT DOES THE SAME THREE THINGS REJECT DOES, on purpose - and now a fourth: it PINGS
           * the requester. Expiry is the one ending nobody chose, so it is also the one nobody
           * would ever have gone back to look for. The card now points at `/request retry`,
           * which puts it back in front of an approver without retyping it.
           */
          type: 'expire',
          maxAttempts: 3,
          deadlineMs: APPROVAL_SWEEP_DEADLINE_MS,
          backoff: { initialMs: 60_000, factor: 2, maxMs: 600_000, jitter: 0.2 },
          needs: ['SendMessages'],
          schedule: { everyMs: APPROVAL_SWEEP_EVERY_MS },
          async run(jctx): Promise<JobOutcome> {
            const now = jctx.ports.clock.now();
            const hours = ttlHours(cfg.approvalTtlMs);
            let expired = 0;

            // FIRST, the slots nobody is waiting on at all: submissions that claimed a slot and
            // never filed an issue. `reconcile()` clears these at boot; this is the arm for a
            // bot that does not restart, where a hung GitHub call would otherwise cost a guild a
            // slot for as long as the process lives.
            const abandoned = repo.releaseStaleDrafts(now - DRAFT_STALE_MS, EXPIRY_BATCH);
            if (abandoned > 0) jctx.logger.warn('released build slots abandoned mid-submission', { abandoned });

            for (const row of repo.expiring(now - cfg.approvalTtlMs, EXPIRY_BATCH)) {
              // COMPARE-AND-SET, not a blind UPDATE. An approver clicking Approve in this exact
              // second is racing this sweep, and the human must win: their click already
              // dispatched a build, and expiring the row underneath it would leave a paid run
              // whose card says nobody ever approved it.
              if (!repo.compareAndSet(row.id, row.version, 'expired', now)) continue;
              expired += 1;

              // Close the issue exactly as Reject does. A failure here is deliberately NOT
              // fatal: the row is already `expired`, which is the state that governs spend.
              let issueClosed = true;
              if (row.issueNumber !== null) {
                const closed = await jctx.ports.issues.close(row.issueNumber, 'not_planned');
                issueClosed = closed.ok;
              }

              const surface = surfaceOf(row);
              if (surface !== null) {
                // Expiry is the ending NOBODY CHOSE, so it is the one nobody would ever go back
                // and look for - which is why it is posted with a ping rather than edited.
                // `deliverOutcome` swallows Discord failures: the state change has committed,
                // and a card the bot can no longer reach must not stop the sweep.
                const moved = await deliverOutcome(
                  jctx.ports.discord,
                  surface,
                  expiredCard({
                    issueNumber: row.issueNumber,
                    issueUrl: storedUrl(row.issueUrl),
                    ttlHours: hours,
                    issueClosed,
                    buttons: [],
                    mention: pingRequester(row.requesterId),
                  }),
                );
                if (moved.messageId !== surface.messageId) repo.recordSurface(row.id, moved, jctx.ports.clock.now());
              }

              jctx.ports.audit.record({
                action: 'builder.expire',
                // WHY NOT THE REQUESTER: nobody performed this. Attributing it to the person who
                // asked would read, in an audit query, as though they withdrew it.
                actorId: SYSTEM_ACTOR,
                guildId: row.guildId,
                detail: { requestId: row.id, issueNumber: row.issueNumber, requesterId: row.requesterId, issueClosed, ttlHours: hours },
              });
            }

            if (expired > 0) jctx.logger.info('expired unapproved build requests', { expired });
            // ALWAYS `done`, even having logged failures: this is a sweep, and a per-row problem
            // is handled per row.
            return { kind: 'done' };
          },

          /** REQUIRED. A sweep that dies silently is a guild that quietly re-bricks itself. */
          async onDead(jctx): Promise<void> {
            jctx.logger.error('the approval expiry sweep dead-lettered; unapproved requests will hold their slots');
          },

          /** REQUIRED. The scheduled payload is `{}`, so this is only reachable via an old row. */
          async onUnparseable(jctx): Promise<void> {
            jctx.logger.warn('expiry sweep payload from an older version; dropping');
          },
        },
      ],

      /**
       * Runs once after migrations on EVERY boot. This is the answer to the one window the
       * types cannot close: a crash between `dispatch()` returning and the enqueue committing.
       */
      async reconcile() {
        const now = ctx.ports.clock.now();

        // HAND BACK SLOTS A CRASH TOOK. `claimSlot` commits and the handler then awaits GitHub;
        // a process that died in that window left a `draft` row holding a slot that no later
        // frame will ever release. This is the same crash-window sweep the loop below performs
        // one state further on, and without it the fix for the concurrency race would introduce
        // a slower version of the leak it closes.
        const abandoned = repo.releaseStaleDrafts(now - DRAFT_STALE_MS, EXPIRY_BATCH);
        if (abandoned > 0) ctx.logger.warn('released build slots abandoned mid-submission', { abandoned });

        for (const row of repo.stuck(now - RECONCILE_STALE_MS, 50)) {
          const surface = row.surfaceJson === null ? null : parseSurface(row.surfaceJson);
          if (surface === null || row.issueNumber === null) continue;
          const r = ctx.ports.jobs.enqueue({
            type: 'build',
            payload: { requestId: row.id, issueNumber: row.issueNumber, surface },
            runAfterMs: now,
            deadlineAtMs: now + cfg.buildDeadlineMs,
            // RECOMPUTED FROM THE ROW, not hardcoded as `build-<id>`. A retried request's live
            // poller runs under `build-<id>-r<n>`, so the old literal would have enqueued a
            // SECOND poller for the same build instead of finding the existing one.
            dedupeKey: buildDedupeKey(row.id, row.retryCount),
          });
          // `created: false` means a poller already exists - the normal case, not an error.
          if (r.ok && r.value.created) {
            ctx.logger.warn('re-adopted an orphaned build', { requestId: row.id });
          }
        }

        // DO THE TWO CAPS AGREE? Asked once, at boot, where an operator can still act on the
        // answer - rather than discovered by a requester whose approved build dispatched, ran for
        // ten seconds and exited 1 at a cap step whose log they usually cannot open.
        //
        // LAST, AND THE ORDER IS THE POINT. `main.ts` runs `reconcile()` inside a try/catch and
        // logs a throw, so anything that throws costs everything AFTER it. Recovering rows a
        // crash orphaned is what this hook exists for; a diagnostic read of a repository variable
        // is a nice-to-have that reaches the network, and a nice-to-have must never be positioned
        // where it can cost the durability work.
        capAgreement = compareDailyRunCap(await readAgentDailyRunCap(ctx.ports.builds), cfg.dailyRunCap);
        reportCapAgreement(ctx.logger, ctx.ports.audit, capAgreement);
      },

      // EVERY card, not the three that happened to exist. These run through the real renderer
      // at boot, which is what turns "a card a user is looking at throws" into a failed deploy -
      // and the endings nobody could otherwise reach without a six-hour build or a two-day wait
      // (draft, refused, expired, cancelled, capped) are exactly the ones that need it.
      previews: previewCards(),

      async health() {
        // THREE NUMBERS, ALL OTHERWISE INVISIBLE. "Who is paying" is the first thing an operator
        // wants confirmed after flipping `requireOwnCredentials`. The TTL is the setting that
        // silently decides whether `/request new` works at all. And the daily cap is the one
        // that decides whether an approved build actually starts today - until the bot knew it,
        // being over cap surfaced as an unexplained "Build failed" half an hour later.
        const funding = cfg.requireOwnCredentials
          ? 'every requester funds their own build'
          : `builds fall back to the shared ${SHARED_BUILD_ENVIRONMENT} environment`;
        return {
          status: 'ok',
          detail:
            `ready; ${funding}; unapproved requests expire after ${String(ttlHours(cfg.approvalTtlMs))}h; ` +
            // THE FOURTH NUMBER, AND WHETHER IT IS THE SAME NUMBER THE REPOSITORY BELIEVES.
            // Reporting the bot's cap alone was a half-truth: the workflow enforces its own, and
            // when the two drifted the product's answer to "how many runs a day?" was confidently
            // wrong in a way only a failed build would reveal.
            `up to ${String(cfg.dailyRunCap)} agent runs per UTC day (${capAgreementDetail(capAgreement)})`,
        };
      },
    };
  },
});

// ---------------------------------------------------------------------------------------
// Small helpers kept below the manifest so the manifest reads top to bottom
// ---------------------------------------------------------------------------------------

/** WHY exported: the reconciler test asserts the number a stuck row is compared against. */
export const RECONCILE_STALE_MS = 5 * 60_000;

/** How often the expiry sweep runs. An hour, against a TTL measured in days. */
export const APPROVAL_SWEEP_EVERY_MS = 3_600_000;

/** A sweep that has not finished in ten minutes is stuck, not slow. */
const APPROVAL_SWEEP_DEADLINE_MS = 10 * 60_000;

/** Rows per sweep. Bounded so one pass cannot hold a lease while it edits a thousand cards. */
const EXPIRY_BATCH = 50;

/**
 * HOW LONG A CLAIMED-BUT-UNFILED SUBMISSION IS STILL PLAUSIBLY IN FLIGHT.
 *
 * A `draft` row lives from `claimSlot` to `recordIssue` - one issue creation and one message
 * post, which is a second or two. Five minutes is generous by two orders of magnitude, and it is
 * deliberately not tight: releasing a slot out from under a submission that is merely slow would
 * let a burst past the cap through a different door, which is the bug being closed.
 *
 * WHY EXPORTED: two sweeps use it and a test pins the number rather than trusting it.
 */
export const DRAFT_STALE_MS = 5 * 60_000;

/**
 * Say what the boot cap check found, ONCE, to the two audiences who can act on it.
 *
 * `bot-higher` is the only WARN, because it is the only arm with a consequence: past the
 * repository's number, this bot dispatches builds the workflow refuses, and the requester gets
 * back the unexplained "Build failed" that `checkDailyCap` was written to abolish. Everything
 * else is information. Nothing here is fatal - see `compareDailyRunCap`.
 */
function reportCapAgreement(logger: LoggerPort, audit: AuditPort, agreement: CapAgreement): void {
  if (agreement.kind === 'bot-higher') {
    logger.warn('the daily agent run caps disagree, and in the direction that wastes runs', {
      bot: agreement.bot,
      repository: agreement.repository,
      source: agreement.source,
      fix: 'raise the AGENT_DAILY_RUN_CAP repository variable, or lower modules.builder.dailyRunCap',
    });
    // AUDITED, not just logged. `/admin audit` is where an operator looks after a build failed
    // for no visible reason, and "the two caps disagreed at boot" is exactly the row that turns
    // that into a five-second diagnosis.
    audit.record({
      action: 'builder.daily_cap_drift',
      actorId: SYSTEM_ACTOR,
      guildId: null,
      detail: { bot: agreement.bot, repository: agreement.repository, source: agreement.source },
    });
    return;
  }
  if (agreement.kind === 'repository-cap-unusable') {
    // WARN AND AUDIT, exactly like `bot-higher`, because the consequence is strictly worse:
    // there is no cap at which builds start succeeding again. The operator gets the same
    // five-second diagnosis from `/admin audit` after the first mystery failure.
    logger.warn('the AGENT_DAILY_RUN_CAP repository variable is not a whole number', {
      fix: 'set AGENT_DAILY_RUN_CAP to a plain number such as 4, or delete it to use the workflow default',
      consequence: "the workflow's cap step exits 1, so every dispatched build fails in its first seconds",
    });
    audit.record({
      action: 'builder.daily_cap_drift',
      actorId: SYSTEM_ACTOR,
      guildId: null,
      detail: { problem: 'repository cap is not a whole number' },
    });
    return;
  }
  if (agreement.kind === 'bot-lower') {
    logger.info('the daily agent run caps disagree, but only throughput is affected', {
      bot: agreement.bot,
      repository: agreement.repository,
      source: agreement.source,
    });
    return;
  }
  if (agreement.kind === 'unknown') {
    // A token without `Variables: read` lands here. It must not look like a failure, because
    // the check is an optimisation and the workflow's own cap is the authority.
    logger.info('could not read the AGENT_DAILY_RUN_CAP repository variable', { why: agreement.why });
  }
}

/**
 * WHO the audit row for an expiry names.
 *
 * Nobody performed it - that is the entire fact being recorded. Naming the requester would read,
 * in an audit query, as though they withdrew their own request.
 */
const SYSTEM_ACTOR = 'system';

/**
 * IS THIS A DRAFT PULL REQUEST? `true`, `false`, or `null` for "the port cannot say".
 *
 * `PrRef` NOW DECLARES `isDraft` - the widening this module asked for was granted - so in
 * production this returns a real boolean and `draftPrCard` is reachable. The tolerant read stays
 * because it costs nothing and it is the branch that runs if a fixture, a replayed row, or some
 * future adapter ever hands back an object without the field. A property missing at RUNTIME is
 * something no type can express, so the only way to keep that branch honest is to keep it.
 */
export function readPrDraft(pr: PrRef): boolean | null {
  const raw: unknown = pr;
  if (!isJsonObject(raw)) return null;
  const flag = raw['isDraft'];
  return typeof flag === 'boolean' ? flag : null;
}

// ---------------------------------------------------------------------------------------
// Previews. They render at BOOT, which is what makes a broken card a failed deploy.
// ---------------------------------------------------------------------------------------

const PREVIEW_ISSUE_URL = 'https://github.com/o/r/issues/42';
const PREVIEW_PR_URL = 'https://github.com/o/r/pull/7';
const PREVIEW_RUN_URL = 'https://github.com/o/r/actions/runs/9';
const PREVIEW_USER = '111111111111111111';

/** WHY it throws: a developer-authored preview URL that fails is a typo, caught at boot. */
function previewUrl(raw: string): HttpsUrl {
  const parsed = storedUrl(raw);
  if (parsed === null) throw new Error(`preview url is not an https url: ${raw}`);
  return parsed;
}

function previewText(): UserText {
  return userTextForTest('Add a /ping command that replies pong, and nothing else.');
}

/** A preview row, so `listCard` is rendered at boot like every other surface. */
function previewRow(state: BuildRow['state'], issueNumber: number): BuildRow {
  return {
    id: newRequestId(0),
    state,
    version: 1,
    guildId: '222222222222222222',
    requesterId: PREVIEW_USER,
    nonce: newCardNonce(),
    fenceNonce: newFenceNonce(),
    title: 'Add a /ping command',
    issueNumber,
    issueUrl: PREVIEW_ISSUE_URL,
    runId: 9,
    runUrl: PREVIEW_RUN_URL,
    prUrl: state === 'pr_open' ? PREVIEW_PR_URL : null,
    dispatchAttempts: 1,
    retryCount: 0,
    succeededAt: null,
    approvalId: null,
    approvalIssuedAt: null,
    firstDispatchAt: null,
    surfaceJson: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function previewCards(): Readonly<Record<string, View>> {
  const id: RequestId = newRequestId(0);
  const nonce: CardNonce = newCardNonce();
  const issue = previewUrl(PREVIEW_ISSUE_URL);
  const pr = previewUrl(PREVIEW_PR_URL);
  const run = previewUrl(PREVIEW_RUN_URL);
  const quoted = toMarkdown(previewText(), { maxLength: 700 });
  const tell: Mention = pingRequester(PREVIEW_USER);
  const inertButtons = [approveButton(id, nonce, true), rejectButton(id, nonce, true)];

  return {
    approval: approvalCard({
      id,
      nonce,
      title: sanitizeStored('Add a /ping command'),
      excerpt: { md: quoted.md, truncated: quoted.truncated },
      kind: 'new-command',
      success: sanitizeStored('Running /ping replies within a second.'),
      requesterId: PREVIEW_USER,
      issueNumber: 42,
      issueUrl: issue,
      retryCount: 0,
    }),
    building: buildingCard({ issueNumber: 42, issueUrl: issue, runUrl: run, title: 'Add a /ping command', approverId: PREVIEW_USER }),
    retrying: retryingCard(42, 1, issue),
    capped: capWaitingCard({ issueNumber: 42, used: 4, cap: 4, waitMs: 5 * 3_600_000, issueUrl: issue }),
    opened: openedCard(pr, issue, tell, 'Added a /remind command that pings you after a delay.'),
    draft: draftPrCard(pr, issue, tell, 'The agent used all 150 of its turns before finishing.', 'Tests for the cancel path.'),
    blocked: blockedCard(pr, issue, issue, tell),
    refused: refusedCard(42, issue, tell, 'The request asked to print the bot token.'),
    rejected: rejectedCard(true, tell),
    expired: expiredCard({
      issueNumber: 42,
      issueUrl: issue,
      ttlHours: 48,
      issueClosed: true,
      buttons: inertButtons,
      mention: tell,
    }),
    // ALL FIVE ENDINGS OF A CANCELLATION, rendered at boot. They are the surfaces nobody can
    // reach without a live run and a stopwatch - "we asked GitHub and it said the run was
    // already over" is not a state a developer will produce by hand - which makes them exactly
    // the ones a preview has to cover, or a broken card is discovered by the person it is
    // apologising to.
    cancelled: cancelledCard({
      issueNumber: 42,
      issueUrl: issue,
      runUrl: run,
      run: { kind: 'stop-requested' },
      issueClosed: true,
      by: 'approver',
      buttons: inertButtons,
      mention: tell,
    }),
    cancelledTooLate: cancelledCard({
      issueNumber: 42,
      issueUrl: issue,
      runUrl: run,
      run: { kind: 'already-finished' },
      issueClosed: true,
      by: 'requester',
      buttons: inertButtons,
      mention: tell,
    }),
    cancelledUnstoppable: cancelledCard({
      issueNumber: 42,
      issueUrl: issue,
      runUrl: run,
      run: { kind: 'still-running' },
      issueClosed: false,
      by: 'requester',
      buttons: inertButtons,
      mention: tell,
    }),
    cancelledBeforeStart: cancelledCard({
      issueNumber: 42,
      issueUrl: issue,
      runUrl: null,
      run: { kind: 'never-started' },
      issueClosed: true,
      by: 'requester',
      buttons: inertButtons,
      mention: tell,
    }),
    cancelledInGitHub: cancelledCard({
      issueNumber: 42,
      issueUrl: issue,
      runUrl: run,
      run: { kind: 'stopped-in-github' },
      issueClosed: false,
      by: 'github',
      buttons: [],
      mention: tell,
    }),
    failed: failedCard(failureError({ failedStep: null, stop: 'error_max_turns', turns: 150, agent: null }), issue, run, tell),
    listMine: listCard([previewRow('pr_open', 42), previewRow('failed', 43)], 'mine', 48),
    listWaiting: listCard([previewRow('awaiting_approval', 44)], 'waiting', 48),
    listEmpty: listCard([], 'mine', 48),
  };
}
