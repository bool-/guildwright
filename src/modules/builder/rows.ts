/**
 * THE ONLY FILE THAT TOUCHES PERSISTENCE, and the state machine it enforces.
 *
 * WHY IT IS ITS OWN FILE NOW: `module.ts` grew a history surface (`/request list`), a
 * withdrawal (`/request cancel`) and a re-dispatch (`/request retry`), and every one of them is
 * a query or a guarded UPDATE. Leaving them inline would have put four new statements a
 * thousand lines away from the three they must agree with - and "the columns are declared in
 * exactly one place" is the invariant that the `SELECT *` defect was paid for.
 */

import type { RequestId } from '#core/ids';
import type { SurfaceRef } from '#core/view';
import { sql, sqlJoin, sqlValues, type Db, type SqlIdent, type SqlQuery } from '#core/ports/db';

// ---------------------------------------------------------------------------------------
// State machine (section 7.4)
// ---------------------------------------------------------------------------------------

/** The ten states. Six are terminal. */
export type BuildState =
  | 'draft'
  | 'awaiting_approval'
  | 'dispatching'
  | 'running'
  | 'pr_open'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/**
 * The states nothing will ever move again, written ONCE.
 *
 * WHY IT IS EXPORTED AND NOT JUST INLINE SQL: the poll job has to ask the same question the
 * `finish` guard asks - "has somebody already settled this?" - and until it did, a build the
 * requester CANCELLED kept polling, and worse, a cancelled row that had not dispatched yet
 * still walked into the dispatch branch and spent money. One list, two readers, no drift.
 */
export const TERMINAL_STATES = ['pr_open', 'done', 'failed', 'rejected', 'expired', 'cancelled'] as const;

export function isTerminalState(state: BuildState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** WHY a row type and not the ORM's: this file is the only one that knows the columns. */
export interface BuildRow {
  readonly id: RequestId;
  readonly state: BuildState;
  readonly version: number;
  readonly guildId: string;
  /**
   * WHICH CONFIGURED REPOSITORY THIS REQUEST LIVES IN (RFC-001 PR 2.2, migration 0005): the key
   * `ReposPort.resolve(guild)` answered when it was submitted. Every later step re-validates it
   * through `ReposPort.byKey` and acts there, so re-linking the guild cannot move a poll, a cancel
   * or a retry - the issue number is only meaningful in the repository it was filed in.
   */
  readonly repoKey: string;
  readonly requesterId: string;
  readonly nonce: string;
  readonly fenceNonce: string;
  /**
   * WHAT WAS ASKED FOR, in the requester's own words, already sanitised.
   *
   * WHY IT IS PERSISTED: `/request list` renders rows the requester filed days ago, and an
   * issue number is not a memory aid - "#42, #47, #51" is not a list anybody can act on. The
   * approval card had the title in hand at submit time and threw it away; now the row keeps it,
   * so every later surface can name the request instead of numbering it.
   */
  readonly title: string | null;
  readonly issueNumber: number | null;
  /** The issue's own URL. Persisted because the card that needs it is rendered by a JOB, half an
   *  hour after the frame that had it. */
  readonly issueUrl: string | null;
  readonly runId: number | null;
  /** The run's log URL, persisted for the same reason: `onDead` holds no `RunStatus`. */
  readonly runUrl: string | null;
  /** The pull request, once there is one - so `/request list` can link the OUTCOME, not the input. */
  readonly prUrl: string | null;
  /** Raised BEFORE each dispatch, so `maxDispatchAttempts` is a ceiling that can be reached. */
  readonly dispatchAttempts: number;
  /**
   * How many times `/request retry` has re-armed this row.
   *
   * WHY IT IS A COLUMN AND NOT A COUNT OF SOMETHING ELSE: it bounds re-spend (`maxRetries`) and
   * it is half of the job dedupe key, so a retry's poller cannot collide with the dead one it
   * replaces - and `reconcile()` has to be able to recompute that key from the row alone.
   */
  readonly retryCount: number;
  /** When the poller FIRST saw this run finish successfully; null until then. It is what
   *  separates "the PR has not appeared yet" from "the agent refused, so there is no PR". */
  readonly succeededAt: number | null;
  /**
   * THE APPROVAL THIS DISPATCH SPENDS. Minted by the Approve click (or by `/request retry`) and
   * written in the same guarded UPDATE that moves the row to `dispatching`, so a lost race can
   * never leave an id on a row it does not own. Signed into the approval token and sent as a
   * dispatch input; the workflow refuses an id it has seen before. Null on a row approved before
   * migration 0004, and on one nobody has approved yet.
   */
  readonly approvalId: string | null;
  /** When the token for the CURRENT attempt was signed, epoch ms. Re-stamped every attempt. */
  readonly approvalIssuedAt: number | null;
  /** When the FIRST attempt for this approval was made, epoch ms. Written once per approval. */
  readonly firstDispatchAt: number | null;
  readonly surfaceJson: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * What `claimSlot` is given.
 *
 * WHY IT IS NOT `BuildRow`: `created_at`/`updated_at` come from the `at` argument, and
 * `pr_url`/`retry_count` are outcomes rather than inputs. Asking a caller to write literals for
 * four columns the INSERT ignores is how a reader learns to stop trusting the type.
 */
export type NewBuildRow = Omit<
  BuildRow,
  'createdAt' | 'updatedAt' | 'prUrl' | 'retryCount' | 'approvalId' | 'approvalIssuedAt' | 'firstDispatchAt'
>;

/**
 * WHAT IS OCCUPYING A GUILD CONCURRENCY SLOT, split by what the reader can DO about it.
 *
 * WHY IT IS NOT ONE NUMBER, which is what it used to be: the two halves need opposite actions
 * from whoever is refused. `running` clears itself in five to thirty minutes and the honest
 * advice is "wait". `waiting` does not clear itself at all until the expiry sweep runs, and the
 * honest advice is "go find an approver" - so collapsing them into "Too many builds are already
 * in flight here. Wait for one to finish." sent every later requester away to wait for a queue
 * that was never moving, about builds that did not exist.
 */
export interface ActiveCounts {
  /** Filed, and nobody has clicked Approve or Reject yet. Spends nothing; occupies a slot. */
  readonly waiting: number;
  /** Approved and genuinely executing: dispatching, or being polled. This is what spends. */
  readonly running: number;
  /**
   * MID-SUBMISSION: the slot is claimed, the GitHub issue is not filed yet.
   *
   * WHY THIS THIRD NUMBER HAD TO EXIST, and it is the whole shape of the concurrency fix. A
   * `draft` row is a submission between `claimSlot` and `recordIssue` - the seconds in which the
   * handler is awaiting GitHub. It occupies a slot, because occupying a slot BEFORE the await is
   * the only thing that makes the cap enforceable rather than advisory.
   *
   * It is reported SEPARATELY rather than folded into `waiting` because the two need different
   * sentences. "Waiting for an approver" is an instruction to go and find one; a draft has no
   * approver to find and clears itself in about a second. Folding them together would have made
   * the refusal message wrong in exactly the way the previous one-number version was wrong.
   */
  readonly filing: number;
}

/**
 * Slots occupied, WRITTEN ONCE.
 *
 * Three call sites compared `waiting + running` against `maxConcurrentPerGuild` and the SQL that
 * has to agree with them was a fourth place to be right. The arithmetic and the predicate are
 * now one function and one fragment, so a state added to one and forgotten in the other is a
 * compile error rather than a cap that quietly stops counting something.
 */
export function slotsUsed(active: ActiveCounts): number {
  return active.waiting + active.running + active.filing;
}

/**
 * THE ANSWER TO A SLOT CLAIM. Three outcomes, and the two failures are NOT the same news.
 *
 * `full` means the guild is at its cap; `lost` means somebody else moved this exact row first.
 * Reporting one as the other sends a reader off to do the wrong thing, which is why the repo
 * answers with a word rather than a boolean.
 */
export type SlotClaim = 'claimed' | 'full' | 'repo-full' | 'lost';

/** What a re-arming command must prove before a terminal row may re-enter the active set. */
export interface SlotReopen {
  readonly id: RequestId;
  readonly expectVersion: number;
  /** The row's own guild. Passed rather than correlated in SQL, so the subquery stays flat. */
  readonly guildId: string;
  readonly at: number;
  readonly maxConcurrent: number;
}

/**
 * THE PER-REPOSITORY HALF OF A CLAIM (RFC-001 7.5, PR 2.4): which repository the row builds in,
 * and how many builds that repository may have dispatched at once.
 *
 * `repoKey` is the ROW's own key, passed for the same reason `guildId` is - so the counting
 * subquery stays flat - and also matched in the outer WHERE, so a claim can never be made against
 * one repository's count for a row that lives in another.
 */
export interface RepoSlot {
  readonly repoKey: string;
  readonly maxConcurrentPerRepo: number;
}

/** What the Approve click must prove to move a row from `awaiting_approval` to `dispatching`. */
export interface DispatchClaim extends RepoSlot {
  readonly id: RequestId;
  readonly expectVersion: number;
  readonly at: number;
  /** Minted by the click and written in the same statement as the state change. */
  readonly approvalId: string;
}

export interface BuildRepo {
  get(id: RequestId): BuildRow | undefined;
  /**
   * CLAIM A GUILD CONCURRENCY SLOT AND WRITE THE ROW IN ONE STATEMENT.
   *
   * THE DEFECT THIS REPLACES, carried in `docs/KNOWN-ISSUES.md` for several rounds. The handler
   * read `activeCounts`, then did seconds of async work - filing a GitHub issue, posting a card
   * - before the row reached a state that count could see. Several `/request` submissions
   * arriving together therefore ALL passed the check before any of them was visible, and a guild
   * capped at 2 could run 5. `/request retry` made it a third entrance to the same hole.
   *
   * `insertDraft` IS GONE RATHER THAN LEFT BESIDE THIS. An unguarded insert left in the repo is
   * an unguarded insert somebody will call; the whole point is that the count and the write are
   * ONE STATEMENT, so the loser of a burst is refused instead of admitted. There is now no way
   * to add a row to this table that does not go through the cap.
   *
   * Returns false when the guild is already full. A caller that claims and then fails to file
   * the issue MUST call `releaseDraft`, or the slot leaks.
   */
  claimSlot(row: NewBuildRow, at: number, maxConcurrent: number): boolean;
  /**
   * Hand back a slot whose submission never got as far as an issue.
   *
   * WHY IT DELETES RATHER THAN MARKING THE ROW TERMINAL: a draft that never filed an issue has
   * no issue, no card, no run and no outcome. Keeping it would put a row in `/request list` that
   * reads "Failed" with nothing to open and nothing to retry - a record of nothing, which is
   * worse than no record. The `state = 'draft'` guard is what makes this incapable of deleting a
   * real request.
   */
  releaseDraft(id: RequestId): boolean;
  /**
   * Sweep claims abandoned by a crash, and report how many.
   *
   * WHY IT IS NEEDED AT ALL: `claimSlot` commits, and then the handler awaits GitHub. A process
   * that dies in that window leaves a row holding a slot no later frame will ever release - the
   * same crash window `reconcile()` exists for, one state earlier. Both the boot reconciler and
   * the hourly sweep call this, because a bot that does not happen to restart must not be short
   * a slot forever.
   */
  releaseStaleDrafts(before: number, limitRows: number): number;
  /**
   * Returns false when someone else won the race. NEVER retried (SC-10 check 4).
   *
   * NOT THE APPROVE CLICK'S DOOR ANY MORE (RFC-001 PR 2.4): an approval moves a row into the
   * states a REPOSITORY dispatch slot counts, so it goes through `approveForDispatch`, which claims
   * that slot in the same statement. This stays for Reject, cancel and expiry, none of which takes
   * a slot.
   */
  compareAndSet(id: RequestId, expectVersion: number, next: BuildState, at: number): boolean;
  /**
   * THE APPROVE CLICK: compare-and-set the row from `awaiting_approval` to `dispatching`, write
   * its approval id, AND CLAIM ONE OF ITS REPOSITORY'S DISPATCH SLOTS - in ONE statement.
   *
   * THE APPROVAL ID IS IN THE SAME STATEMENT for the reason it always was: the workflow refuses
   * an id a second time, so the one row that owns it must be the one row whose CAS won. Writing it
   * afterwards would let the loser of the race stamp its id over the winner's.
   *
   * WHY A REPOSITORY CAP AT ALL (RFC-001 7.5): the workflow's `concurrency: agent-implement` group
   * keeps one running run and ONE pending one, and GitHub silently CANCELS the older pending run
   * when a newer one queues. The per-guild cap never bounded that - two servers on one repository,
   * or one server whose `maxConcurrentPerGuild` was raised, could dispatch a third build into the
   * group and have one cancelled with nobody told why. `maxConcurrentPerRepo` (default 2) is
   * exactly what the group admits.
   *
   * WHY HERE AND NOT AT SUBMISSION: the repository's scarce thing is a DISPATCHED build, not an
   * unclicked card. Counting `draft`/`awaiting_approval` per repository would let one server's
   * unapproved requests stop every other server on that repository from even filing - the
   * guild-bricking bug again, one level up. So the count is over `dispatching`/`running`, and a
   * row enters those states only through this method and `reopenForDispatch`, which both carry it.
   *
   * WHY ONE STATEMENT: the same check-then-act race `claimSlot` closed. Two approvers clicking at
   * once on two servers' cards must not both take the last slot; the count lives inside the
   * UPDATE, so the loser changes zero rows.
   *
   * `lost`: somebody else moved this row first. `repo-full`: the repository is at its cap, and the
   * row is still `awaiting_approval` with its card still live.
   */
  approveForDispatch(claim: DispatchClaim): SlotClaim;
  recordIssue(id: RequestId, issueNumber: number, issueUrl: string, surface: SurfaceRef, at: number): boolean;
  recordRun(id: RequestId, runId: number, runUrl: string | null, at: number): boolean;
  /** Learn the run log URL later than the run id - the blind-dispatch and poll paths. */
  recordRunUrl(id: RequestId, runUrl: string, at: number): boolean;
  /** The pull request, learned by the poller minutes after the card that will show it. */
  recordPrUrl(id: RequestId, prUrl: string, at: number): boolean;
  /**
   * Point a row at a DIFFERENT card.
   *
   * WHY: a retried request is re-approved on a NEW card - the old one is a resolved artefact in
   * the scrollback and editing it would rewrite history. Without this the row still names the
   * dead card, so the expiry sweep would resolve a message nobody is looking at.
   */
  recordSurface(id: RequestId, surface: SurfaceRef, at: number): boolean;
  /**
   * Count one dispatch attempt, and stamp WHEN THIS ATTEMPT'S TOKEN WAS SIGNED.
   *
   * WHY IT EXISTS AT ALL: `dispatch_attempts` was written as a literal 0 by the INSERT, aliased
   * by the SELECT, and compared against `cfg.maxDispatchAttempts` on every pass - and NOTHING
   * EVER RAISED IT. The ceiling was unreachable by construction, so a workflow the repository
   * refuses to dispatch was re-dispatched every fifteen seconds until the six-hour deadline.
   *
   * `at` is also written to `approval_issued_at` (every attempt) and to `first_dispatch_at`
   * (first attempt only, via COALESCE). The caller signs the token with the same instant, so
   * what the row remembers and what the workflow checks against the run's creation time are
   * one number.
   *
   * WHY IT DOES NOT BUMP `version`: this is not a state transition and nobody is holding a
   * version here. The CAS token belongs to Approve/Reject/expire, which race with humans.
   */
  countDispatchAttempt(id: RequestId, at: number): boolean;
  /**
   * Swap the run a `running` row is polling for an EARLIER one of the same approval.
   *
   * WHY: the workflow refuses a second run that carries an approval id it has already seen,
   * and reports `approval_replayed`. The honest case is a dispatch the bot never saw answered
   * (a crash after the POST), followed by a retry with the same id; the refused run is the
   * retry, and the build the user paid for is the earlier one. The poller must follow it.
   * `m_builder_requests_run` is UNIQUE on `run_id`, so the old id is released by the UPDATE.
   */
  adoptRun(id: RequestId, runId: number, runUrl: string | null, at: number): boolean;
  /** Stamp the moment the run first reported success. Idempotent: only the FIRST one sticks. */
  noteRunSucceeded(id: RequestId, at: number): boolean;
  /**
   * Move a row to a TERMINAL state, from wherever it is.
   *
   * WHY IT IS NOT `compareAndSet`: finishing is not a race. The poller that just watched the run
   * complete is the only writer, and it does not hold a version - requiring one would mean a
   * re-read that could itself be stale. The guard is instead "not already terminal", so a second
   * call is a harmless no-op.
   */
  finish(id: RequestId, next: BuildState, at: number): boolean;
  /**
   * RE-ARM A FAILED BUILD FOR ANOTHER DISPATCH, without a new issue and without retyping.
   *
   * The run identity is cleared, not kept: `m_builder_requests_run` is UNIQUE on `run_id`, so a
   * second run could not be recorded against a row still holding the first one's id, and a
   * stale `succeeded_at` would make the PR grace window expire before the new run had started.
   *
   * `dispatch_attempts` goes back to 0 on purpose - the ceiling bounds ONE dispatch's flailing
   * at the GitHub API, and `retry_count` is the thing that bounds re-spend.
   *
   * THE SLOT IS CLAIMED IN THIS STATEMENT, not checked before it. A retry moves a terminal row
   * back into the active set, which is a third entrance to the concurrency cap and raced with
   * the other two in exactly the same way: `activeCounts` said there was room, and by the time
   * the UPDATE ran there was not.
   *
   * BOTH CAPS, ONE STATEMENT (RFC-001 PR 2.4): it goes straight to `dispatching`, so it takes a
   * repository dispatch slot as well as a guild slot - see `approveForDispatch`.
   */
  reopenForDispatch(claim: SlotReopen & RepoSlot & { readonly approvalId: string }): SlotClaim;
  /**
   * RE-ARM AN EXPIRED REQUEST FOR A SECOND LOOK BY AN APPROVER.
   *
   * WHY THIS IS A SEPARATE METHOD FROM THE ONE ABOVE, and it is the important line in this file:
   * an expired request was NEVER APPROVED. Sending it straight back to `dispatching` would let
   * anybody buy a build by waiting two days and then retrying, which is the whole spend gate
   * defeated by a timer. It goes back to `awaiting_approval`, with a fresh card nonce so the
   * dead card's buttons stay inert, and a human still has to click Approve.
   *
   * The slot is claimed in this statement too, for the reason given on `reopenForDispatch`.
   */
  reopenForApproval(claim: SlotReopen & { readonly nonce: string }): SlotClaim;
  /** Rows the reconciler must re-adopt after a crash. */
  stuck(before: number, limitRows: number): readonly BuildRow[];
  /**
   * Every row whose `repo_key` is NOT one of `configuredKeys`, in any state: what the boot
   * adoption (`planRepoKeyAdoption`) inspects. Empty on every boot of a stable configuration,
   * because the index on `(repo_key, state)` answers it without walking the table.
   */
  unconfigured(configuredKeys: readonly string[]): readonly BuildRow[];
  /**
   * Move ONE row to another repository key, guarded on the key it had. Only the boot adoption
   * calls this, and only on evidence the row itself carries.
   *
   * WHY IT TOUCHES NEITHER `version` NOR `updated_at`: it is not a state transition, so it must
   * not make a concurrent Approve lose its compare-and-set; and `updated_at` is the clock the
   * expiry sweep and the reconciler read, so re-keying must not buy an unclicked request a second
   * approval TTL.
   */
  rekey(id: RequestId, from: string, to: string): boolean;
  /** This guild's rows that are not terminal, in any repository - drafts included. */
  inFlightForGuild(guildId: string): number;
  /** Rows that are not terminal, per repository key. A key with none is absent. */
  inFlightByRepo(): ReadonlyMap<string, number>;
  /**
   * Rows holding a repository DISPATCH slot (`dispatching`/`running`), per repository key: the
   * number `maxConcurrentPerRepo` is compared against. A key with none is absent.
   */
  buildingByRepo(): ReadonlyMap<string, number>;
  /**
   * Rows nobody ever clicked: `awaiting_approval` and untouched since `before`.
   *
   * THE GUILD-BRICKING BUG THIS QUERY EXISTS FOR. `expired` was declared in the state union, in
   * the SQL CHECK and in the terminal list `finish` guards on, and nothing anywhere ever wrote
   * it. Two requests nobody clicked therefore occupied both default concurrency slots FOREVER.
   */
  expiring(before: number, limitRows: number): readonly BuildRow[];
  /** One requester's own recent history, newest first. The answer to "what happened to mine?". */
  recentForRequester(guildId: string, requesterId: string, limitRows: number): readonly BuildRow[];
  /**
   * Everything in this guild waiting for a human decision, OLDEST FIRST.
   *
   * WHY OLDEST FIRST, when the requester's own list is newest first: this list exists to be
   * worked through, and the row closest to expiring is the one an approver has least time to
   * act on. A requester is asking "what happened to mine?"; an approver is asking "what is
   * about to be lost?".
   */
  waitingInGuild(guildId: string, limitRows: number): readonly BuildRow[];
  activeCounts(guildId: string): ActiveCounts;
}

/**
 * The column list, aliased to the field names `BuildRow` declares, WRITTEN ONCE.
 *
 * WHY EVERY COLUMN IS SPELLED OUT INSTEAD OF `SELECT *`:
 *
 * SQLite returns columns under their real names - `issue_number`, `run_id`, `surface_json` - so
 * `SELECT *` typed as `BuildRow` produced an object whose every multi-word field was
 * `undefined`. `db.queryOne<BuildRow>(...)` is an UNCHECKED generic: TypeScript takes the
 * caller word for the row shape, so this typechecked perfectly and 255 tests stayed green while
 * `row.issueNumber` was always undefined and no build was ever dispatched.
 */
const selectRow = (t: SqlIdent): SqlQuery => sql`
  SELECT id, state, version,
         guild_id AS guildId, repo_key AS repoKey, requester_id AS requesterId,
         nonce, fence_nonce AS fenceNonce, title,
         issue_number AS issueNumber, issue_url AS issueUrl,
         run_id AS runId, run_url AS runUrl, pr_url AS prUrl,
         dispatch_attempts AS dispatchAttempts, retry_count AS retryCount,
         succeeded_at AS succeededAt,
         approval_id AS approvalId, approval_issued_at AS approvalIssuedAt,
         first_dispatch_at AS firstDispatchAt,
         surface_json AS surfaceJson,
         created_at AS createdAt, updated_at AS updatedAt
  FROM ${t}`;

/** The terminal list as a SQL fragment, so the guard and `TERMINAL_STATES` cannot drift. */
const NOT_TERMINAL = sql`state NOT IN ('pr_open', 'done', 'failed', 'rejected', 'expired', 'cancelled')`;

/**
 * THE STATES THAT OCCUPY A GUILD SLOT, as one fragment.
 *
 * `draft` IS IN THE LIST AND THAT IS THE FIX. It was not, which is why the cap was advisory: a
 * submission became countable only at `recordIssue`, seconds and two network calls after the row
 * existed, so every submission that arrived inside that window read a count that did not include
 * the ones already in flight.
 *
 * It is deliberately UNQUALIFIED so it can be dropped into either an outer WHERE or a counting
 * subquery; in a subquery, `state` binds to the innermost table, which is the one being counted.
 */
const OCCUPIES_A_SLOT = sql`state IN ('draft', 'awaiting_approval', 'dispatching', 'running')`;

/**
 * `(SELECT count(*) ...)` for one guild, as an expression a statement can compare in its WHERE.
 *
 * WHY IT IS A FRAGMENT AND NOT A SEPARATE READ: the entire defect being fixed is that the count
 * and the write were two statements with an `await` between them. Splicing the count INTO the
 * write is what makes "is there room" and "take the room" the same decision, in the same
 * statement, under the same lock - so the loser of a burst changes zero rows and is refused.
 */
const slotsHeldBy = (t: SqlIdent, guildId: string): SqlQuery =>
  sqlJoin([sql`(SELECT count(*) FROM ${t} WHERE guild_id = ${guildId} AND`, OCCUPIES_A_SLOT, sql`)`]);

/**
 * THE STATES THAT OCCUPY A REPOSITORY DISPATCH SLOT (RFC-001 7.5): approved and not finished.
 * Narrower than `OCCUPIES_A_SLOT` on purpose - see `BuildRepo.approveForDispatch`. Unqualified
 * for the same reason, and answered by the `(repo_key, state)` index migration 0005 created.
 */
const HOLDS_A_DISPATCH_SLOT = sql`state IN ('dispatching', 'running')`;

/** `(SELECT count(*) ...)` of one repository's dispatched builds, for a statement's WHERE. */
const dispatchSlotsHeldIn = (t: SqlIdent, repoKey: string): SqlQuery =>
  sqlJoin([sql`(SELECT count(*) FROM ${t} WHERE repo_key = ${repoKey} AND`, HOLDS_A_DISPATCH_SLOT, sql`)`]);

export const buildRepo = (db: Db): BuildRepo => {
  const t = db.table('requests');

  /** One repository's dispatched builds: what `maxConcurrentPerRepo` is compared against. */
  const building = (repoKey: string): number =>
    db.queryOne<{ readonly n: number }>(
      sqlJoin([sql`SELECT count(*) AS n FROM ${t} WHERE repo_key = ${repoKey} AND`, HOLDS_A_DISPATCH_SLOT]),
    )?.n ?? 0;

  /**
   * Shared by every claiming UPDATE: run it, then name the reason it failed.
   *
   * The write already failed, so these reads cannot change the decision - only the WORDING. A
   * caller told "someone else got there first" when the truth is "your server is full" goes off
   * and does the wrong thing about it. The guild is named first when both are full: it is the
   * limit the reader's own server holds.
   */
  const settle = (statement: SqlQuery, guild: SlotReopen | null, repoSlot: RepoSlot | null): SlotClaim => {
    if (db.execute(statement).changes === 1) return 'claimed';
    if (guild !== null && slotsUsed(counts(guild.guildId)) >= guild.maxConcurrent) return 'full';
    if (repoSlot !== null && building(repoSlot.repoKey) >= repoSlot.maxConcurrentPerRepo) return 'repo-full';
    return 'lost';
  };

  const counts = (guildId: string): ActiveCounts =>
    // `coalesce` because `sum()` over zero rows is NULL, and a NULL arriving as `waiting` would
    // read as "no slots used" by accident rather than by decision.
    db.queryOne<ActiveCounts>(
      sqlJoin([
        sql`SELECT coalesce(sum(CASE WHEN state = 'awaiting_approval' THEN 1 ELSE 0 END), 0) AS waiting,
                   coalesce(sum(CASE WHEN state IN ('dispatching', 'running') THEN 1 ELSE 0 END), 0) AS running,
                   coalesce(sum(CASE WHEN state = 'draft' THEN 1 ELSE 0 END), 0) AS filing
            FROM ${t}
            WHERE guild_id = ${guildId} AND`,
        OCCUPIES_A_SLOT,
      ]),
    ) ?? { waiting: 0, running: 0, filing: 0 };

  return {
    get: (id) => db.queryOne<BuildRow>(sqlJoin([selectRow(t), sql`WHERE id = ${id}`])),
    claimSlot: (row, at, maxConcurrent) =>
      // ONE STATEMENT. `INSERT ... SELECT ... WHERE` is what makes the row visible to the next
      // reader's count in the same breath as the count that admitted it. `VALUES` cannot carry a
      // predicate, which is precisely why the previous version had to check separately.
      db.execute(
        sqlJoin([
          sql`INSERT INTO ${t} (id, state, version, guild_id, repo_key, requester_id, nonce, fence_nonce, title,
                                dispatch_attempts, retry_count, created_at, updated_at)
              SELECT ${row.id}, ${row.state}, 1, ${row.guildId}, ${row.repoKey}, ${row.requesterId}, ${row.nonce},
                     ${row.fenceNonce}, ${row.title}, 0, 0, ${at}, ${at}
              WHERE`,
          slotsHeldBy(t, row.guildId),
          sql`< ${maxConcurrent}`,
        ]),
      ).changes === 1,
    releaseDraft: (id) =>
      db.execute(sql`DELETE FROM ${t} WHERE id = ${id} AND state = 'draft'`).changes === 1,
    releaseStaleDrafts: (before, limitRows) =>
      // The bound is applied in a subselect rather than as `DELETE ... LIMIT`, which requires a
      // compile-time SQLite option this project does not get to assume.
      db.execute(sql`
        DELETE FROM ${t}
        WHERE id IN (SELECT id FROM ${t}
                     WHERE state = 'draft' AND updated_at < ${before}
                     ORDER BY updated_at LIMIT ${limitRows})`).changes,
    compareAndSet: (id, expectVersion, next, at) =>
      db.execute(sql`
        UPDATE ${t} SET state = ${next}, version = version + 1, updated_at = ${at}
        WHERE id = ${id} AND version = ${expectVersion}`).changes === 1,
    approveForDispatch: (claim) =>
      settle(
        sqlJoin([
          // ONE STATEMENT - see the interface comment. The issued-at columns are cleared because
          // they belong to the dispatch attempts of THIS approval, none of which has happened yet.
          sql`UPDATE ${t} SET state = 'dispatching', version = version + 1, updated_at = ${claim.at},
                              approval_id = ${claim.approvalId},
                              approval_issued_at = NULL, first_dispatch_at = NULL
              WHERE id = ${claim.id} AND version = ${claim.expectVersion}
                AND state = 'awaiting_approval' AND repo_key = ${claim.repoKey}
                AND`,
          // The row is `awaiting_approval`, so it is not in its own count: the subquery asks how
          // many OTHER builds this repository already has dispatched, which is the question.
          dispatchSlotsHeldIn(t, claim.repoKey),
          sql`< ${claim.maxConcurrentPerRepo}`,
        ]),
        null,
        claim,
      ),
    recordIssue: (id, issueNumber, issueUrl, surface, at) =>
      db.execute(sql`
        UPDATE ${t} SET issue_number = ${issueNumber}, issue_url = ${issueUrl},
                        surface_json = ${JSON.stringify(surface)},
                        state = 'awaiting_approval', version = version + 1, updated_at = ${at}
        WHERE id = ${id} AND state = 'draft'`).changes === 1,
    recordRun: (id, runId, runUrl, at) =>
      db.execute(sql`
        UPDATE ${t} SET run_id = ${runId}, run_url = coalesce(${runUrl}, run_url),
                        state = 'running', version = version + 1, updated_at = ${at}
        WHERE id = ${id} AND state = 'dispatching'`).changes === 1,
    recordRunUrl: (id, runUrl, at) =>
      db.execute(sql`
        UPDATE ${t} SET run_url = ${runUrl}, updated_at = ${at}
        WHERE id = ${id} AND run_url IS NULL`).changes === 1,
    recordPrUrl: (id, prUrl, at) =>
      db.execute(sql`
        UPDATE ${t} SET pr_url = ${prUrl}, updated_at = ${at}
        WHERE id = ${id}`).changes === 1,
    recordSurface: (id, surface, at) =>
      db.execute(sql`
        UPDATE ${t} SET surface_json = ${JSON.stringify(surface)}, updated_at = ${at}
        WHERE id = ${id}`).changes === 1,
    countDispatchAttempt: (id, at) =>
      db.execute(sql`
        UPDATE ${t} SET dispatch_attempts = dispatch_attempts + 1,
                        approval_issued_at = ${at},
                        first_dispatch_at = coalesce(first_dispatch_at, ${at}),
                        updated_at = ${at}
        WHERE id = ${id}`).changes === 1,
    adoptRun: (id, runId, runUrl, at) =>
      db.execute(sql`
        UPDATE ${t} SET run_id = ${runId}, run_url = ${runUrl}, updated_at = ${at}
        WHERE id = ${id} AND state = 'running'`).changes === 1,
    noteRunSucceeded: (id, at) =>
      db.execute(sql`
        UPDATE ${t} SET succeeded_at = ${at}, updated_at = ${at}
        WHERE id = ${id} AND succeeded_at IS NULL`).changes === 1,
    finish: (id, next, at) =>
      db.execute(
        sqlJoin([
          sql`UPDATE ${t} SET state = ${next}, version = version + 1, updated_at = ${at}
              WHERE id = ${id} AND `,
          NOT_TERMINAL,
        ]),
      ).changes === 1,
    reopenForDispatch: (claim) =>
      settle(
        sqlJoin([
          // A FRESH approval id: a retry is a new spend, and the workflow has already consumed
          // the old id (or refused it). Re-sending it would be refused as a replay.
          sql`UPDATE ${t} SET state = 'dispatching', run_id = NULL, run_url = NULL, pr_url = NULL,
                              succeeded_at = NULL, dispatch_attempts = 0,
                              approval_id = ${claim.approvalId}, approval_issued_at = NULL,
                              first_dispatch_at = NULL,
                              retry_count = retry_count + 1, version = version + 1, updated_at = ${claim.at}
              WHERE id = ${claim.id} AND version = ${claim.expectVersion} AND state = 'failed'
                AND repo_key = ${claim.repoKey}
                AND`,
          // The row is terminal right now, so it is not in its own count - the subquery is
          // asking about everybody ELSE, which is the question the cap is about.
          slotsHeldBy(t, claim.guildId),
          sql`< ${claim.maxConcurrent} AND`,
          // AND the repository's dispatch slots, in the same predicate: a retry dispatches
          // straight away, so it faces both caps or it is a door around one of them.
          dispatchSlotsHeldIn(t, claim.repoKey),
          sql`< ${claim.maxConcurrentPerRepo}`,
        ]),
        claim,
        claim,
      ),
    reopenForApproval: (claim) =>
      settle(
        sqlJoin([
          // No approval id: nobody has approved this yet. The Approve click mints one.
          sql`UPDATE ${t} SET state = 'awaiting_approval', nonce = ${claim.nonce},
                              run_id = NULL, run_url = NULL, pr_url = NULL, succeeded_at = NULL,
                              approval_id = NULL, approval_issued_at = NULL, first_dispatch_at = NULL,
                              dispatch_attempts = 0, retry_count = retry_count + 1,
                              version = version + 1, updated_at = ${claim.at}
              WHERE id = ${claim.id} AND version = ${claim.expectVersion} AND state = 'expired'
                AND`,
          slotsHeldBy(t, claim.guildId),
          sql`< ${claim.maxConcurrent}`,
        ]),
        // Back to `awaiting_approval`, which holds no repository dispatch slot: only the guild's.
        claim,
        null,
      ),
    stuck: (before, limitRows) =>
      db.query<BuildRow>(
        sqlJoin([
          selectRow(t),
          sql`WHERE state IN ('dispatching', 'running') AND updated_at < ${before}
              ORDER BY updated_at LIMIT ${limitRows}`,
        ]),
      ),
    unconfigured: (configuredKeys) =>
      db.query<BuildRow>(
        sqlJoin([
          selectRow(t),
          // `configuredKeys` is never empty (a repository set always holds one), so `NOT IN ()`
          // - which SQLite would accept and answer "every row" - cannot be produced here.
          sql`WHERE repo_key NOT IN (`,
          sqlValues(configuredKeys),
          sql`) ORDER BY created_at`,
        ]),
      ),
    rekey: (id, from, to) =>
      // The NOT EXISTS keeps "one request per issue per repository" (migration 0005) without a
      // constraint error: a row whose issue another row in `to` already holds stays where it is,
      // and is reported as stranded rather than throwing out of `setup`.
      db.execute(sql`
        UPDATE ${t} SET repo_key = ${to}
        WHERE id = ${id} AND repo_key = ${from}
          AND NOT EXISTS (SELECT 1 FROM ${t} AS other
                          WHERE other.repo_key = ${to} AND other.issue_number = ${t}.issue_number)`).changes === 1,
    inFlightForGuild: (guildId) =>
      db.queryOne<{ readonly n: number }>(sqlJoin([sql`SELECT count(*) AS n FROM ${t} WHERE guild_id = ${guildId} AND`, NOT_TERMINAL]))?.n ?? 0,
    inFlightByRepo: () =>
      new Map(
        db
          .query<{ readonly repoKey: string; readonly n: number }>(
            sqlJoin([sql`SELECT repo_key AS repoKey, count(*) AS n FROM ${t} WHERE`, NOT_TERMINAL, sql`GROUP BY repo_key`]),
          )
          .map((r) => [r.repoKey, r.n] as const),
      ),
    buildingByRepo: () =>
      new Map(
        db
          .query<{ readonly repoKey: string; readonly n: number }>(
            sqlJoin([sql`SELECT repo_key AS repoKey, count(*) AS n FROM ${t} WHERE`, HOLDS_A_DISPATCH_SLOT, sql`GROUP BY repo_key`]),
          )
          .map((r) => [r.repoKey, r.n] as const),
      ),
    expiring: (before, limitRows) =>
      db.query<BuildRow>(
        sqlJoin([
          selectRow(t),
          sql`WHERE state = 'awaiting_approval' AND updated_at < ${before}
              ORDER BY updated_at LIMIT ${limitRows}`,
        ]),
      ),
    recentForRequester: (guildId, requesterId, limitRows) =>
      db.query<BuildRow>(
        sqlJoin([
          selectRow(t),
          sql`WHERE guild_id = ${guildId} AND requester_id = ${requesterId}
              ORDER BY created_at DESC LIMIT ${limitRows}`,
        ]),
      ),
    waitingInGuild: (guildId, limitRows) =>
      db.query<BuildRow>(
        sqlJoin([
          selectRow(t),
          sql`WHERE guild_id = ${guildId} AND state = 'awaiting_approval'
              ORDER BY updated_at LIMIT ${limitRows}`,
        ]),
      ),
    activeCounts: counts,
  };
};

// ---------------------------------------------------------------------------------------
// The daily run cap's calendar
// ---------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000;

/**
 * The UTC midnight at or before `nowMs`.
 *
 * WHY NOT A `Date`: modules may not read the ambient clock, and `new Date()` is banned outright
 * by `conventions.test.ts` - but the arithmetic needs no calendar anyway. The epoch is itself a
 * UTC midnight, so flooring to a whole number of days IS `date -u -d 'today 00:00'`, which is
 * exactly the boundary `.github/workflows/agent-implement-request.yml` counts from. The two
 * sides of the cap have to agree on the day or the bot's answer is about a different window
 * than the runner's.
 */
export function startOfUtcDay(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

/** How long until that window rolls over, i.e. how long a capped build must wait. */
export function msUntilUtcDayEnd(nowMs: number): number {
  return startOfUtcDay(nowMs) + DAY_MS - nowMs;
}

/**
 * The job dedupe key for one attempt at building a request.
 *
 * WHY `retryCount` IS IN IT: `/request retry` enqueues a second poller for a row whose first
 * job is dead but still present in `core_jobs`. One live job per (module, dedupeKey) means a
 * retry sharing the original key would be silently dropped - the state would say `dispatching`
 * and nothing would ever poll it, which is precisely the orphan `reconcile()` exists to catch,
 * arriving on purpose. `reconcile()` recomputes this from the row, so the two agree by
 * construction rather than by memory.
 */
export function buildDedupeKey(id: RequestId, retryCount: number): string {
  return retryCount === 0 ? `build-${id}` : `build-${id}-r${String(retryCount)}`;
}
