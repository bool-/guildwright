/**
 * THE THREE COMMANDS THAT MAKE A REQUEST SOMETHING A HUMAN CAN LIVE WITH.
 *
 * Before these, a `/request` was fire-and-forget in the worst sense. There was **no history**
 * (the card was the only record, and a card scrolls away), **no cancel** (a request you regretted
 * held a concurrency slot for 48 hours and there was nothing you could do about it), **no retry**
 * (a failed build was a dead end - the only move was to type the whole idea again and file a
 * second issue), and **no way for an approver to discover that anything was waiting** - which is
 * the reason requests sat unclicked until the expiry sweep collected them.
 *
 *   /request list          your own recent requests, with state and links
 *   /request list all:true everything waiting for an approver here (needs `builder.approve`)
 *   /request cancel <id>   withdraw your own; an approver may withdraw anybody's
 *   /request retry <id>    re-run a failed build, or put an expired one back in front of an
 *                          approver - without retyping and without a second issue
 *
 * TWO RULES RUN THROUGH ALL OF IT.
 *
 * 1. **A retry is a fresh request for spend purposes.** It re-runs the credential gate and the
 *    concurrency cap, it is rate-limited with the same two buckets as the modal submission, and
 *    it is bounded by `maxRetries`. A retry that skipped those would be a door straight past "no
 *    free builds", reachable by anyone who could get one request approved and then let it fail.
 *
 * 2. **An EXPIRED request has never been approved, so retrying it may not dispatch.** It goes
 *    back to `awaiting_approval` on a brand-new card and a human still has to click Approve.
 *    Sending it to `dispatching` would mean anybody could buy a build by waiting two days.
 */

import type {
  AutocompleteChoice,
  AutocompleteRequest,
  CommandSpec,
  Invocation,
  Outcome,
} from '#core/module';
import { MAX_AUTOCOMPLETE_CHOICES } from '#core/module';
import { Err, Ok, type Result } from '#core/result';
import { errors, type AppError } from '#core/errors';
import { limit } from '#core/ratelimit';
import type { PermissionRef } from '#core/policy';
import {
  md,
  renderPlainName,
  sanitizeStored,
  toPlainName,
  type SafeMarkdown,
  type UserText,
} from '#core/text';
import {
  newApprovalId,
  newCardNonce,
  toCardNonce,
  toChannelId,
  toRequestId,
  type ChannelId,
  type RequestId,
} from '#core/ids';
import type { AccessPort, AuditPort, BuildsPort, ClockPort, DiscordPort, IssuesPort, JobsPort } from '#core/ports';
import type { View } from '#core/view';
import {
  buildDedupeKey,
  isTerminalState,
  type BuildRepo,
  type BuildRow,
  type SlotClaim,
} from '#modules/builder/rows';
import {
  approveButton,
  cancelledCard,
  concurrencyError,
  listCard,
  rejectButton,
  retryingCard,
  approvalCard,
  pingRequesterUnless,
  stateLabel,
  storedUrl,
  surfaceOf,
  ttlHours,
  type CancelledRun,
} from '#modules/builder/cards';
import {
  githubForRow,
  reopenIssue,
  requestRunCancellation,
  type CancelsRuns,
  type GithubScopes,
  type IssueReopenReport,
  type ReopensIssues,
  type RunCancelReport,
} from '#modules/builder/ports';
import { requireOwnCredentialsGate } from '#modules/builder/payer';
import { deliverOutcome } from '#modules/builder/notify';

/**
 * The ports these commands reach, named individually.
 *
 * WHY `Pick` rather than the whole port: this file cancels jobs and runs, closes and reopens
 * issues, and edits cards. It has no business dispatching a workflow, and the narrowest type
 * that compiles is the one that says so - `ctx.ports` is structurally assignable to it, so
 * nothing is lost.
 *
 * `CancelsRuns` and `ReopensIssues` are the two methods this round needs from ports somebody
 * else owns; see `#modules/builder/ports` for why they are declared as optional companions
 * rather than waited for.
 */
export interface HistoryPorts extends GithubScopes<HistoryIssues, HistoryBuilds> {
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly access: AccessPort;
  readonly discord: Pick<DiscordPort, 'post' | 'edit' | 'delete'>;
  readonly jobs: JobsPort;
}

/**
 * What this file needs from ONE repository's ports. They arrive per repository behind
 * `.at(repo)` (RFC-001 PR 2.1), and every command here reaches the row's own repository
 * through `githubForRow`, never "the" repository.
 */
export type HistoryIssues = Pick<IssuesPort, 'close'> & ReopensIssues;
export type HistoryBuilds = Pick<BuildsPort, 'environmentCredentials' | 'verifyGates'> & CancelsRuns;

/** Exactly the config these commands read. Kept explicit so the manifest is the only defaults. */
export interface HistoryConfig {
  readonly historyLimit: number;
  readonly maxRetries: number;
  readonly maxConcurrentPerGuild: number;
  readonly approvalTtlMs: number;
  readonly buildDeadlineMs: number;
  readonly requireOwnCredentials: boolean;
}

export interface HistoryDeps {
  readonly repo: BuildRepo;
  readonly ports: HistoryPorts;
  readonly perms: Readonly<Record<'request' | 'approve', PermissionRef>>;
  readonly cfg: HistoryConfig;
}

/** The option every id-taking command declares. Autocompleted, because a ULID is 26 characters. */
const ID_OPTION = {
  name: 'id',
  description: 'The request id from /request list - start typing and pick one',
  type: 'text',
  required: true,
  autocomplete: true,
  maxLength: 32,
} as const;

export function historyCommands(deps: HistoryDeps): readonly CommandSpec[] {
  return [listCommand(deps), cancelCommand(deps), retryCommand(deps)];
}

// ---------------------------------------------------------------------------------------
// /request list
// ---------------------------------------------------------------------------------------

function listCommand(deps: HistoryDeps): CommandSpec {
  return {
    name: 'request list',
    description: 'Show your build requests, or everything waiting for an approver',
    surface: 'guild',
    options: [
      {
        name: 'all',
        description: 'Show every request waiting for an approver (needs builder.approve)',
        type: 'boolean',
        required: false,
      },
    ],
    // The command is a READ. It is gated on `request`, not `approve`, because a requester must
    // be able to look up their own work; the `all:true` branch re-asks for `approve` INSIDE the
    // handler, since one command cannot carry two permission refs.
    permission: deps.perms.request,
    limit: [limit.perUser(20, 60_000)],
    needs: ['SendMessages'],
    ack: 'defer-ephemeral',
    async handle(inv): Promise<Outcome> {
      const guildId = inv.space.guildId;
      if (guildId === null) return { kind: 'silent' };
      const ttl = ttlHours(deps.cfg.approvalTtlMs);

      if (inv.args.bool('all') === true) {
        if (!isApprover(deps, inv)) {
          return {
            kind: 'fail',
            // The GRANT INSTRUCTION goes in `nextStep`, not in `grantableBy`: `userMessage`
            // renders `userDetail` and `nextStep` and nothing else, so a next step that names
            // only the fallback would reach the reader as "you do not have permission", full
            // stop - the dead end `AppError.nextStep` exists to make impossible.
            error: errors.forbidden(
              'builder.approve',
              'a server admin',
              'Ask an admin to run /access grant builder.approve for you, or run /request list without `all` to see your own requests.',
            ),
          };
        }
        return {
          kind: 'view',
          view: listCard(deps.repo.waitingInGuild(guildId, deps.cfg.historyLimit), 'waiting', ttl),
        };
      }

      return {
        kind: 'view',
        view: listCard(deps.repo.recentForRequester(guildId, inv.actor.userId, deps.cfg.historyLimit), 'mine', ttl),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// /request cancel
// ---------------------------------------------------------------------------------------

function cancelCommand(deps: HistoryDeps): CommandSpec {
  return {
    name: 'request cancel',
    description: 'Withdraw a build request you opened (approvers can withdraw any)',
    surface: 'guild',
    options: [ID_OPTION],
    permission: deps.perms.request,
    limit: [limit.perUser(10, 60_000)],
    needs: ['SendMessages'],
    ack: 'defer-ephemeral',
    async handle(inv): Promise<Outcome> {
      const found = await loadForAction(deps, inv);
      if (!found.ok) return { kind: 'fail', error: found.error };
      const row = found.value;

      if (isTerminalState(row.state)) {
        return {
          kind: 'fail',
          error: errors.conflict(
            'already_resolved',
            `That request is already "${stateLabel(row.state)}", so there is nothing to cancel.`,
            'Run /request list to see where each of yours got to.',
            row.state,
          ),
        };
      }

      // WHAT CANCELLING CAN AND CANNOT REACH, decided BEFORE the state changes, because
      // afterwards the row no longer remembers whether a run was in flight - and that is the
      // one fact the user has to be told honestly.
      const wasRunning = row.state === 'dispatching' || row.state === 'running';

      // COMPARE-AND-SET, not a blind UPDATE: an approver may be clicking Approve in this exact
      // second, and losing that race must be a refusal rather than a cancelled build that
      // dispatched anyway.
      if (!deps.repo.compareAndSet(row.id, row.version, 'cancelled', inv.at)) {
        return {
          kind: 'fail',
          error: errors.conflict('cas', 'Someone else resolved that request a moment before you did.', 'Run /request list to see what happened to it.'),
        };
      }

      // STOP THE BOT POLLING. `retry` outcomes do not consume attempts, so a poller left alive
      // on a cancelled row would keep asking GitHub about a run nobody is waiting for until the
      // six-hour deadline. The build job ALSO checks for a terminal row on every pass, so this
      // is belt and braces - the job's own guard is what protects against the race where the
      // cancel lands while an attempt is already in flight.
      let stoppedPolling = false;
      if (wasRunning) {
        const jobId = deps.ports.jobs.findByDedupeKey(buildDedupeKey(row.id, row.retryCount));
        if (jobId !== undefined) {
          const cancelled = deps.ports.jobs.cancel(jobId);
          stoppedPolling = cancelled.ok && cancelled.value;
        }
      }

      // AND STOP THE RUN ITSELF, which is the thing cancelling always claimed to do and never
      // did. Until now `/request cancel` freed the slot and left the Actions run spending the
      // REQUESTER'S OWN credentials on a result nobody would ever look at - the card said so
      // honestly, which made it an honest description of the wrong behaviour.
      const cancelReport = await stopTheRun(deps, row, wasRunning);
      const run = describeCancelledRun(wasRunning, row.runId !== null, cancelReport);

      const issueClosed = await closeIssue(deps, row);
      const byRequester = row.requesterId === inv.actor.userId;

      const surface = surfaceOf(row);
      if (surface !== null) {
        const nonce = toCardNonce(row.nonce);
        const view = cancelledCard({
          issueNumber: row.issueNumber,
          issueUrl: storedUrl(row.issueUrl),
          runUrl: storedUrl(row.runUrl),
          run,
          issueClosed,
          by: byRequester ? 'requester' : 'approver',
          // No buttons: an ending card carries links only, like every other ending.
          buttons: [],
          // Tell the person who has been waiting, unless they are the person who just acted.
          mention: pingRequesterUnless(row.requesterId, inv.actor.userId),
        });
        // Edited in place when the requester withdrew it themselves; posted with a ping (and the
        // stale card deleted) when somebody else did. Discord failures are swallowed: the state
        // change is what matters and it has already committed.
        const moved = await deliverOutcome(deps.ports.discord, surface, view);
        if (moved.messageId !== surface.messageId) deps.repo.recordSurface(row.id, moved, inv.at);
      }

      deps.ports.audit.record({
        action: 'builder.cancel',
        actorId: inv.actor.userId,
        guildId: row.guildId,
        detail: {
          requestId: row.id,
          issueNumber: row.issueNumber,
          requesterId: row.requesterId,
          fromState: row.state,
          wasRunning,
          stoppedPolling,
          // WHAT ACTUALLY HAPPENED TO THE PAID RUN, recorded rather than inferred. `/admin audit`
          // is the only place an operator can later establish whether a cancellation reached
          // GitHub at all, and "we asked and it 409'd" is a different fact from "we never asked".
          runCancel: cancelReport.kind,
          issueClosed,
          byApprover: !byRequester,
        },
      });

      return { kind: 'view', view: cancelledReceipt(run, issueClosed) };
    },
    async autocomplete(req): Promise<readonly AutocompleteChoice[]> {
      return suggest(deps, req, (row) => !isTerminalState(row.state));
    },
  };
}

/**
 * ASK GITHUB TO STOP THE RUN, if there is one and the port can.
 *
 * WHY IT IS ATTEMPTED AFTER the compare-and-set and not before: the CAS is what decides this
 * request is ours to cancel. Asking GitHub first would mean a cancel that LOST the race - to an
 * approver clicking Approve in the same second - had already killed the run that approval just
 * bought.
 *
 * A row in `dispatching` has no `runId` yet: the workflow may or may not have been created, and
 * there is nothing to name in a cancel call. That is `still-running`, not `never-started` - the
 * honest answer is that we could not stop it, which is exactly what the old wording said and the
 * one case where it was right.
 */
async function stopTheRun(deps: HistoryDeps, row: BuildRow, wasRunning: boolean): Promise<RunCancelReport> {
  if (!wasRunning || row.runId === null) return { kind: 'unavailable' };
  const target = githubForRow(deps.ports, row);
  if (!target.ok) return { kind: 'refused', error: target.error };
  return requestRunCancellation(target.value.builds, row.runId);
}

/** Turn what GitHub said into the one sentence the card and the receipt both render. */
function describeCancelledRun(wasRunning: boolean, hasRun: boolean, report: RunCancelReport): CancelledRun {
  if (!wasRunning) return { kind: 'never-started' };
  // Approved, but no run recorded - usually a dispatch GitHub kept refusing. "The run keeps
  // going" here described a run that, in every case seen so far, never existed.
  if (!hasRun) return { kind: 'no-run' };
  switch (report.kind) {
    case 'requested':
      return { kind: 'stop-requested' };
    case 'already-finished':
      return { kind: 'already-finished' };
    // BOTH FAILURES READ THE SAME TO A USER, and deliberately so: whether the bot could not ask
    // or asked and was refused, the actionable fact is identical - the run is still going and
    // the Actions tab is the only thing that can stop it. The DIFFERENCE is recorded in the
    // audit row, where an operator can act on it.
    case 'unavailable':
    case 'refused':
      return { kind: 'still-running' };
    default: {
      const exhaustive: never = report;
      void exhaustive;
      return { kind: 'still-running' };
    }
  }
}

/** What the person who typed the command sees, privately. The CARD is what the channel sees. */
function cancelledReceipt(run: CancelledRun, issueClosed: boolean): View {
  return {
    accent: 'ok',
    ephemeral: true,
    nodes: [
      { kind: 'text', md: receiptLine(run) },
      ...(issueClosed ? [] : [{ kind: 'text' as const, md: md`The GitHub issue could not be closed - close it by hand.` }]),
    ],
  };
}

function receiptLine(run: CancelledRun): SafeMarkdown {
  switch (run.kind) {
    case 'never-started':
      return md`Cancelled. Nothing was built and nothing was charged.`;
    case 'no-run':
      return md`Cancelled. The bot hadn't found a GitHub run for it yet - if one shows up in the Actions tab, cancel it there.`;
    case 'stop-requested':
      return md`Cancelled. GitHub is stopping the run - give it a minute.`;
    case 'already-finished':
      return md`Cancelled, but the run had already finished. Check the run log - it may have opened a pull request.`;
    case 'still-running':
      return md`Cancelled, but **the bot could not stop the run**. Cancel it in the Actions tab to save the minutes.`;
    case 'stopped-in-github':
      // Unreachable from this command - the run job draws that arm - but the switch is
      // exhaustive so a new arm cannot silently inherit somebody else's sentence.
      return md`Cancelled. The run had already been stopped in GitHub.`;
    default: {
      const exhaustive: never = run;
      void exhaustive;
      return md`Cancelled.`;
    }
  }
}

// ---------------------------------------------------------------------------------------
// /request retry
// ---------------------------------------------------------------------------------------

function retryCommand(deps: HistoryDeps): CommandSpec {
  return {
    name: 'request retry',
    description: 'Run a failed build again, or put an expired request back in front of an approver',
    surface: 'guild',
    options: [ID_OPTION],
    permission: deps.perms.request,
    // THE SAME TWO BUCKETS AS THE MODAL SUBMISSION, deliberately. A retry files no issue, but it
    // dispatches a paid workflow run, which is the thing SC-9's numbers are actually about.
    limit: [limit.perUser(3, 3_600_000), limit.perGuild(20, 86_400_000)],
    needs: ['SendMessages'],
    ack: 'defer-ephemeral',
    async handle(inv): Promise<Outcome> {
      const guildId = inv.space.guildId;
      if (guildId === null) return { kind: 'silent' };
      const found = await loadForAction(deps, inv);
      if (!found.ok) return { kind: 'fail', error: found.error };
      const row = found.value;

      const retryable = retryableState(row);
      if (!retryable.ok) return { kind: 'fail', error: retryable.error };

      if (row.retryCount >= deps.cfg.maxRetries) {
        return {
          kind: 'fail',
          error: errors.conflict(
            'retry_exhausted',
            `That request has already been retried ${String(row.retryCount)} times, which is the limit.`,
            'Read the run log to find out what is actually wrong, then open a fresh request with /request new.',
            'exhausted',
          ),
        };
      }
      const issueNumber = row.issueNumber;
      if (issueNumber === null) {
        return {
          kind: 'fail',
          error: errors.conflict('no_issue', 'That request never got as far as a GitHub issue.', 'Open a new one with /request new.'),
        };
      }

      // BUILDS DISABLED, ON THE RETRY PATH TOO (RFC-001 5.4). The dispatch pass would refuse a
      // drifted gate anyway; refusing here says so to the person asking instead of re-arming a
      // row only to fail it again a moment later.
      // THE ROW'S OWN REPOSITORY, which is where a retry builds (RFC-001 7.3).
      const target = githubForRow(deps.ports, row);
      if (!target.ok) return { kind: 'fail', error: target.error };
      const gated = await target.value.builds.verifyGates();
      if (!gated.ok) return { kind: 'fail', error: gated.error };

      // NO FREE BUILDS, ON THE RETRY PATH TOO. This is the check that makes a retry a fresh
      // request rather than a way around the gate: without it, one approved build that failed
      // would be re-runnable forever by somebody who has since cleared their credentials.
      //
      // It asks about the ROW's requester, not the caller, because they are who pays - an
      // approver retrying somebody else's build does not put it on their own key.
      if (deps.cfg.requireOwnCredentials) {
        const gate = await requireOwnCredentialsGate(target.value.builds, row.requesterId);
        if (!gate.ok) {
          const mine = row.requesterId === inv.actor.userId;
          return {
            kind: 'fail',
            error: mine
              ? gate.error
              : errors.conflict(
                  'requester_credentials',
                  'The person who asked for this has no build credentials stored, so nothing would pay for the retry.',
                  'Ask them to run /credentials set, then retry it.',
                  'requester',
                ),
          };
        }
      }

      // THE SLOT IS NOT CHECKED HERE ANY MORE, and its absence is the fix.
      //
      // A retry re-enters the active set, so it faces the same cap a fresh submission does - but
      // reading the count here and re-arming the row several awaits later is precisely the
      // check-then-act shape that made the cap advisory. The claim now happens INSIDE the
      // guarded UPDATE that re-arms the row (`reopenForDispatch` / `reopenForApproval`), so the
      // count and the write are one statement and a loser is refused rather than admitted.
      return row.state === 'failed'
        ? redispatch(deps, inv, row, issueNumber)
        : reArmForApproval(deps, inv, row, issueNumber);
    },
    async autocomplete(req): Promise<readonly AutocompleteChoice[]> {
      return suggest(deps, req, (row) => row.state === 'failed' || row.state === 'expired');
    },
  };
}

/**
 * Which terminal states may be retried, and - the part that matters - a DIFFERENT sentence for
 * each state that may not.
 *
 * WHY EACH ARM IS SPELLED OUT: "you cannot retry that" is the same dead end this command exists
 * to remove. A refused build must say that retrying ends the same way, because the agent
 * declined on purpose and the explanation is on the issue. A live one must say it is still
 * running. A rejected one must point at `/request new`, because an approver said no to this one.
 */
function retryableState(row: BuildRow): Result<void, AppError> {
  switch (row.state) {
    case 'failed':
    case 'expired':
      return Ok(undefined);
    case 'done':
      return Err(
        errors.conflict(
          'refused',
          'The agent finished that run cleanly and deliberately made no changes - it refused the request.',
          'Read its comment on the GitHub issue. Retrying an identical request ends the same way; change what you are asking for and open a new one with /request new.',
          'done',
        ),
      );
    case 'pr_open':
      return Err(
        errors.conflict('already_open', 'That request already opened a pull request.', 'Open the pull request from the card, or start something new with /request new.', 'pr_open'),
      );
    case 'rejected':
      return Err(
        errors.conflict('rejected', 'An approver rejected that request.', 'Ask them why, then open a new request with /request new.', 'rejected'),
      );
    case 'cancelled':
      return Err(
        errors.conflict('cancelled', 'That request was cancelled.', 'Open a new one with /request new.', 'cancelled'),
      );
    default:
      return Err(
        errors.conflict(
          'not_finished',
          `That request is "${stateLabel(row.state)}", so there is nothing to retry yet.`,
          'Wait for it to finish, or withdraw it with /request cancel.',
          row.state,
        ),
      );
  }
}

/**
 * A FAILED build, run again against the same issue and the same branch.
 *
 * ORDER MATTERS AND IT IS DELIBERATE: state first, card second, job last.
 *
 * The compare-and-set is what claims the right to spend, so it goes first - if two people retry
 * at once, exactly one wins and the loser is told. Everything after it is recoverable: a card
 * the bot cannot draw costs a message, and a job that fails to enqueue leaves a `dispatching`
 * row that `reconcile()` re-adopts on the next boot or within `RECONCILE_STALE_MS`. The reverse
 * order - enqueue, then CAS - is the one that cannot be recovered, because it starts a paid run
 * for a row that then refuses to move.
 */
async function redispatch(
  deps: HistoryDeps,
  inv: Invocation,
  row: BuildRow,
  issueNumber: number,
): Promise<Outcome> {
  const claimed = deps.repo.reopenForDispatch({
    id: row.id,
    expectVersion: row.version,
    guildId: row.guildId,
    at: inv.at,
    maxConcurrent: deps.cfg.maxConcurrentPerGuild,
    // A FRESH APPROVAL. The workflow consumed the previous id (or refused it), so a retry that
    // re-sent it would be refused as a replay. A retry is a new spend and gets a new id,
    // written inside the same guarded UPDATE that re-arms the row.
    approvalId: newApprovalId(),
  });
  if (claimed !== 'claimed') {
    return { kind: 'fail', error: claimRefusal(deps, row.guildId, claimed, 'how it is getting on') };
  }
  const attempt = row.retryCount + 1;
  const surface = await placeCard(deps, inv, row, retryingCard(issueNumber, attempt, storedUrl(row.issueUrl)));
  if (surface === null) {
    // No card means nowhere to deliver the outcome, and a build whose result cannot be reported
    // is worse than one that never started. Put the row back rather than spend.
    deps.repo.finish(row.id, 'failed', inv.at);
    return {
      kind: 'fail',
      error: errors.unavailable('discord', 'Check that the bot can still post in this channel, then try again.'),
    };
  }
  deps.repo.recordSurface(row.id, surface, inv.at);

  const enqueued = deps.ports.jobs.enqueue({
    type: 'build',
    payload: { requestId: row.id, issueNumber, surface },
    runAfterMs: inv.at,
    deadlineAtMs: inv.at + deps.cfg.buildDeadlineMs,
    // `retryCount + 1` because the row has already been bumped. The dead job from the previous
    // attempt may still be in `core_jobs` under the old key, and one live job per (module,
    // dedupeKey) would otherwise drop this enqueue on the floor.
    dedupeKey: buildDedupeKey(row.id, attempt),
  });
  if (!enqueued.ok) return { kind: 'fail', error: enqueued.error };

  deps.ports.audit.record({
    action: 'builder.retry',
    actorId: inv.actor.userId,
    guildId: row.guildId,
    detail: { requestId: row.id, issueNumber, requesterId: row.requesterId, attempt, mode: 'redispatch' },
  });

  return {
    kind: 'view',
    view: {
      accent: 'ok',
      ephemeral: true,
      nodes: [
        {
          kind: 'text',
          md: md`Re-dispatched against the same issue - nothing had to be retyped. The card in the channel is tracking it, and you will be pinged there when it finishes.`,
        },
      ],
    },
  };
}

/**
 * An EXPIRED request, put back in front of an approver.
 *
 * READ THE STATE IT GOES TO: `awaiting_approval`, not `dispatching`. An expired request is one
 * NOBODY EVER APPROVED, so re-running it directly would mean the spend gate could be walked
 * around by anybody willing to wait out `approvalTtlMs`. A human still clicks Approve.
 *
 * The nonce is fresh, which is what makes the dead card's buttons inert: a click carrying the
 * old nonce fails the staleness fence in the approve handler.
 */
async function reArmForApproval(
  deps: HistoryDeps,
  inv: Invocation,
  row: BuildRow,
  issueNumber: number,
): Promise<Outcome> {
  const nonce = newCardNonce();
  const claimed = deps.repo.reopenForApproval({
    id: row.id,
    expectVersion: row.version,
    guildId: row.guildId,
    at: inv.at,
    maxConcurrent: deps.cfg.maxConcurrentPerGuild,
    nonce,
  });
  if (claimed !== 'claimed') {
    return { kind: 'fail', error: claimRefusal(deps, row.guildId, claimed, 'where it is') };
  }

  // REOPEN THE ISSUE, because expiry CLOSED it `not_planned`.
  //
  // THE DEFECT THIS CLOSES. Re-arming an expired request drew a fresh Approve/Reject card that
  // linked to a closed issue, and asked somebody to authorise spend against it - so the product
  // said "this is waiting for a decision" while GitHub said "not planned", and the approver's
  // one way to check what they were funding contradicted the card asking them to fund it. If it
  // had then been approved, the agent would have been pointed at a closed issue too.
  //
  // AFTER the compare-and-set, never before: reopening an issue for a retry that then LOSES the
  // race would leave a live issue for a request that stayed expired.
  const target = githubForRow(deps.ports, row);
  const reopened = target.ok ? await reopenIssue(target.value.issues, issueNumber) : { kind: 'failed' as const, error: target.error };
  if (reopened.kind === 'failed') {
    // Not fatal. The row is `awaiting_approval` and that is the state governing spend; the worst
    // case is a closed issue, and the receipt below says so rather than claiming otherwise.
    deps.ports.audit.record({
      action: 'builder.retry.reopen_failed',
      actorId: inv.actor.userId,
      guildId: row.guildId,
      detail: { requestId: row.id, issueNumber, reason: reopened.error.kind },
    });
  }

  const view = approvalCard({
    id: row.id,
    nonce,
    // The stored title, re-scrubbed. It was sanitised before it was written; a column is a plain
    // string, so the round trip validates rather than launders.
    title: row.title === null ? md`_(no title recorded)_` : sanitizeStored(row.title),
    // The body was never persisted - it lives in the GitHub issue, fenced. An approver reads it
    // there, which is why the issue link is on the card.
    excerpt: null,
    // Neither is persisted on the row; both are in the issue (the kind as a label).
    kind: null,
    success: null,
    requesterId: row.requesterId,
    issueNumber,
    issueUrl: storedUrl(row.issueUrl),
    retryCount: row.retryCount + 1,
  });

  const surface = await placeCard(deps, inv, row, view, { forceNew: true });
  if (surface === null) {
    deps.repo.finish(row.id, 'expired', inv.at);
    return {
      kind: 'fail',
      error: errors.unavailable('discord', 'Check that the bot can still post in this channel, then try again.'),
    };
  }
  deps.repo.recordSurface(row.id, surface, inv.at);

  deps.ports.audit.record({
    action: 'builder.retry',
    actorId: inv.actor.userId,
    guildId: row.guildId,
    detail: {
      requestId: row.id,
      issueNumber,
      requesterId: row.requesterId,
      attempt: row.retryCount + 1,
      mode: 're-approval',
      issueReopened: reopened.kind,
    },
  });

  return {
    kind: 'view',
    view: {
      accent: 'ok',
      ephemeral: true,
      nodes: [
        {
          kind: 'text',
          md: md`Put back in front of the approvers on a new card - nothing had to be retyped. Nothing is built until somebody clicks Approve.`,
        },
        { kind: 'text', md: reopenedIssueLine(reopened) },
      ],
    },
  };
}

/**
 * WHAT THE ISSUE'S STATE ACTUALLY IS, said plainly.
 *
 * The previous wording - "The GitHub issue was closed when this expired; it is still readable,
 * and approving still works" - was an accurate description of a broken thing. It is gone
 * entirely: `IssuesPort.reopen` is required, so "this build cannot reopen" stopped being a state
 * that can occur, and an arm for an impossible state reads to the next maintainer like a case
 * somebody handled. What is left is the two real answers - it reopened, or the call was refused
 * and an operator has a token scope to fix.
 */
function reopenedIssueLine(reopened: IssueReopenReport): SafeMarkdown {
  switch (reopened.kind) {
    case 'reopened':
      return md`The GitHub issue was reopened, so an approver reading it sees an open request rather than one GitHub has marked "not planned".`;
    case 'failed':
      return md`The GitHub issue could not be reopened, so it still reads as closed on GitHub - reopen it by hand before approving, or the approver is being asked to fund something the repository says nobody planned to do.`;
    default: {
      const exhaustive: never = reopened;
      void exhaustive;
      return md`The GitHub issue's state is unknown - open it from the card before approving.`;
    }
  }
}

/**
 * The refusal for a slot claim that did not land, with the RIGHT sentence for each reason.
 *
 * `full` and `lost` used to be indistinguishable, because the guard was a boolean: every failed
 * re-arm said "someone else retried that a moment before you did", including the ones where
 * nobody had and the guild was simply at its cap. Sending somebody to look for a retry that did
 * not happen is the same shape of dead end as the concurrency message this codebase already
 * rewrote once.
 */
function claimRefusal(deps: HistoryDeps, guildId: string, claim: SlotClaim, look: string): AppError {
  return claim === 'full'
    ? concurrencyError(deps.repo.activeCounts(guildId), deps.cfg.approvalTtlMs)
    : errors.conflict(
        'cas',
        'Someone else retried that a moment before you did.',
        `Run /request list to see ${look}.`,
        'cas',
      );
}

// ---------------------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------------------

/**
 * Draw the card this request's outcome will be delivered to, and return the durable handle.
 *
 * Editing the existing message keeps one request in one place in the scrollback. `forceNew`
 * exists because a re-approval must NOT rewrite the resolved "Expired" card: that card is a
 * historical fact, and a fresh decision deserves a fresh message an approver will actually see
 * arrive. Either way, an editable card that turns out not to be editable (deleted message, lost
 * channel) falls back to posting a new one, because the alternative is a build whose result has
 * nowhere to go.
 */
async function placeCard(
  deps: HistoryDeps,
  inv: Invocation,
  row: BuildRow,
  view: View,
  opts: { readonly forceNew?: boolean } = {},
): Promise<{ readonly guildId: string | null; readonly channelId: string; readonly messageId: string } | null> {
  const previous = surfaceOf(row);
  if (previous !== null && opts.forceNew !== true) {
    const edited = await deps.ports.discord.edit(previous, view);
    if (edited.ok) return edited.value;
  }
  const posted = await deps.ports.discord.post(cardChannel(previous?.channelId ?? null, inv.space.channelId), view);
  return posted.ok ? posted.value : null;
}

/**
 * Where a replacement card goes.
 *
 * The ORIGINAL channel wins, because `requestChannelIds` may confine requests to one place and a
 * retry must not smuggle an approval card into a channel the operator kept them out of. The
 * invoking channel is the fallback for a row whose surface was never recorded.
 */
function cardChannel(previousChannelId: string | null, fallback: ChannelId): ChannelId {
  if (previousChannelId === null) return fallback;
  const parsed = toChannelId(previousChannelId);
  return parsed.ok ? parsed.value : fallback;
}

/** Close the issue, and report whether it worked. A failure is never fatal: the ROW is what
 *  governs spend and the slot, so the worst case is a stale open issue the card admits to. */
async function closeIssue(deps: HistoryDeps, row: BuildRow): Promise<boolean> {
  if (row.issueNumber === null) return true;
  const target = githubForRow(deps.ports, row);
  if (!target.ok) return false;
  const closed = await target.value.issues.close(row.issueNumber, 'not_planned');
  return closed.ok;
}

/**
 * Load the row an id-taking command was pointed at, having proved the caller may touch it.
 *
 * THE GUILD CHECK IS NOT COSMETIC: a request id is a ULID and therefore guessable in bulk, and
 * without this a member of one server could cancel a build in another. It answers `notFound`
 * rather than `forbidden` for the same reason - the absence of a row and the absence of
 * permission must look identical, or the command becomes an oracle for ids that exist.
 */
async function loadForAction(deps: HistoryDeps, inv: Invocation): Promise<Result<BuildRow, AppError>> {
  const guildId = inv.space.guildId;
  if (guildId === null) return Err(errors.notFound('request', 'Run this in the server the request was opened in.'));

  const id = readRequestId(inv.args.textRequired('id'));
  if (!id.ok) return id;

  const row = deps.repo.get(id.value);
  if (row === undefined || row.guildId !== guildId) {
    return Err(errors.notFound('request', 'Run /request list to see your requests and their ids.'));
  }

  // A requester owns their own request; an approver - the person already trusted to spend money
  // on it - may act on anybody's. Nobody else may.
  if (row.requesterId !== inv.actor.userId && !isApprover(deps, inv)) {
    return Err(
      errors.forbidden(
        'builder.approve',
        'a server admin',
        'You can only act on requests you opened. Run /request list to see them, or ask an admin for /access grant builder.approve.',
      ),
    );
  }
  return Ok(row);
}

/**
 * Turn a typed id into a `RequestId`.
 *
 * WHY IT GOES THROUGH `toPlainName` FIRST: the value arrives as `UserText`, and there is
 * deliberately no accessor anywhere that hands a module a raw `string`. `toPlainName` is the
 * named door - NFKC, invisibles stripped, collapsed to one line - and `toRequestId` then proves
 * the ULID shape, so a pasted id with a smart quote or a zero-width space around it is repaired
 * rather than refused.
 */
function readRequestId(raw: UserText): Result<RequestId, AppError> {
  const name = toPlainName(raw, { maxLength: 32 });
  if (!name.ok) return name;
  return toRequestId(renderPlainName(name.value).trim());
}

/** Is this caller an approver here? The same decision the router makes for the Approve button. */
function isApprover(deps: HistoryDeps, inv: Invocation): boolean {
  return deps.ports.access.check(inv.space.guildId, deps.perms.approve, {
    userId: inv.actor.userId,
    roleIds: inv.actor.roleIds,
    memberPermissions: inv.actor.memberPermissions,
    isAppOwner: inv.actor.isAppOwner,
  }).allowed;
}

/**
 * Autocomplete over the caller's OWN recent requests.
 *
 * WHY ONLY THEIR OWN, when an approver may act on anybody's: an autocomplete that enumerated
 * every request in the guild would leak the titles of other people's ideas to anybody who could
 * type the command, and the permission check that would prevent it is an allow-list read the
 * three-second autocomplete deadline cannot afford. An approver working from
 * `/request list all` pastes the id, which the handler accepts identically.
 */
async function suggest(
  deps: HistoryDeps,
  req: AutocompleteRequest,
  keep: (row: BuildRow) => boolean,
): Promise<readonly AutocompleteChoice[]> {
  const guildId = req.space.guildId;
  if (guildId === null) return [];

  const typed = toPlainName(req.partial, { maxLength: 64 });
  const needle = typed.ok ? renderPlainName(typed.value).toLowerCase() : '';

  return deps.repo
    .recentForRequester(guildId, req.actor.userId, MAX_AUTOCOMPLETE_CHOICES * 2)
    .filter((row) => keep(row) && matches(row, needle))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((row) => ({ name: choiceLabel(row), value: row.id }));
}

function matches(row: BuildRow, needle: string): boolean {
  if (needle.length === 0) return true;
  return row.id.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle);
}

/** Discord caps a choice name at 100 characters and rejects the whole response if one is over. */
const CHOICE_NAME_MAX = 100;

function choiceLabel(row: BuildRow): string {
  const issue = row.issueNumber === null ? 'no issue' : `#${String(row.issueNumber)}`;
  const label = `${issue} ${stateLabel(row.state)} - ${row.title ?? row.id}`;
  const points = [...label];
  return points.length <= CHOICE_NAME_MAX ? label : `${points.slice(0, CHOICE_NAME_MAX - 1).join('')}…`;
}

