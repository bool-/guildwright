/**
 * THE RECONCILER: durable jobs over `DbPort`, and the loop that drives the builder state
 * machine forward.
 *
 * This is the file that makes "the bot restarted and forgot about my build" impossible rather
 * than unlikely. Everything a job needs is a row in `core_jobs`; nothing lives in a closure, a
 * `setTimeout`, or a promise that dies with the process.
 *
 * THE SIX PROPERTIES, AND THE MECHANISM FOR EACH:
 *
 *  1. PERIODIC TICK (default 15s, configurable). `start()` runs `tick()` on an interval;
 *     `tick()` is also callable directly, which is what makes every test below deterministic
 *     instead of a race against real time.
 *  2. AT LEAST ONCE. A claim is a compare-and-set to `running` with a lease. If the process
 *     dies mid-attempt the row stays `running` with a lease nobody renews, and the next boot -
 *     or the next tick past the lease - puts it back in `queued`. Nothing is ever lost; a job
 *     may run twice, which is why every handler's write is a guarded UPDATE.
 *  3. EXPONENTIAL BACKOFF WITH A CAP. `backoffDelayMs` is pure and exported, so the schedule
 *     is asserted directly rather than inferred from timings.
 *  4. A MAX-ATTEMPTS CEILING. `attempts` is incremented AT CLAIM, not at failure. That is the
 *     one decision here that is not obvious, and it is the one that bounds a POISON job: a
 *     payload that kills the process never reaches a failure handler, so counting at failure
 *     would let it be re-queued forever, one crash per boot, unkillable. Counting at claim
 *     makes it terminal after `maxAttempts`. A `retry` outcome hands the attempt back, because
 *     core is explicit that polling is not failing.
 *  5. NO TWO INSTANCES OF THE SAME KEY. Three layers: a partial UNIQUE index over
 *     `(module_id, dedupe_key)` for live rows, so a second enqueue returns `created: false`
 *     with the SAME id; a CAS claim, so two ticks cannot both take a row; and an in-process
 *     `running` set the lease reclaimer refuses to touch, so a slow job is never stolen from
 *     itself.
 *  6. RESTART RE-QUEUE. `recover()` runs once at boot, before `start()`, and returns every
 *     `running` row to `queued` - those leases belong to a process that no longer exists. It
 *     also reports job keys with no handler (a renamed or dropped module), which would
 *     otherwise sit in the queue forever behind a card that still says "building...".
 *
 * WHY `tick()` does not await the jobs it starts: a poll job for a 30-minute build IS the
 * normal case here. A tick that awaited its jobs would stop reconciling everything else for
 * half an hour. `drain()` exists for tests and for shutdown.
 */

import { randomUUID } from 'node:crypto';
import type { AppError } from '#core/errors';
import { errors, isRetryable, operatorMessage } from '#core/errors';
import { Err, Ok, type Result } from '#core/result';
import type { JsonObject } from '#core/json';
import type { JobId } from '#core/ids';
import { newJobId, toChannelId, toJobId } from '#core/ids';
import { permissionInteger } from '#core/permissions';
import { sql, sqlJoin, sqlValues } from '#core/sql';
import type {
  Backoff,
  ClockPort,
  DbPort,
  DiscordPort,
  EnqueueResult,
  JobRequest,
  JobsPort,
  JobStats,
  LoggerPort,
  RunningJob,
} from '#core/ports';
import { JOB_LEASE_MS } from '#core/ports';
import type { ErasedJob, JobRuntime } from '#core/module';
import type { JobOutcome } from '#core/command';
import { readSurface } from '#core/command';
import { CORE_TABLES } from '#adapters/system/schema';
import { intCol, parseJsonObject, textCol, type Row } from '#adapters/system/rows';

/** The lifecycle. `dead`, `done`, `cancelled` and `orphaned` are terminal. */
export type JobState = 'queued' | 'running' | 'done' | 'dead' | 'cancelled' | 'orphaned';

/** The default cadence. 15s is the poll interval the architecture decision record specifies. */
export const DEFAULT_TICK_MS = 15_000;
/** How many attempts may be in flight at once, across every module. */
export const DEFAULT_MAX_CONCURRENT = 4;
/** WHY a cap: a payload is written and read on every attempt, and it must survive a restart. */
export const MAX_PAYLOAD_BYTES = 32_768;
/** How long `stop()` waits for in-flight attempts before it re-queues them. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * The delay before attempt `attempt + 1`, given that `attempt` just failed.
 *
 * WHY pure and exported: "backoff grows and then stops growing" is the property, and asserting
 * it against real elapsed time is how a flaky test gets written and then deleted.
 * WHY the jitter is one-sided and added AFTER the cap: N pollers restarted together must not
 * thunder, and a symmetric jitter would let a delay fall BELOW `initialMs`, which is the one
 * direction that matters for a rate-limited upstream.
 */
export function backoffDelayMs(backoff: Backoff, attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const factor = backoff.factor > 0 ? backoff.factor : 1;
  const raw = backoff.initialMs * Math.pow(factor, n - 1);
  // `raw` is `Infinity` for a large attempt count; `Math.min` is what makes that harmless.
  const capped = Math.min(raw, backoff.maxMs);
  const jitter = capped * Math.max(0, backoff.jitter) * random();
  return Math.max(0, Math.round(capped + jitter));
}

/** What one tick did. Returned so a test asserts on the tick rather than on the clock. */
export interface TickReport {
  /** Rows moved from `queued` to `running` by this tick. */
  readonly claimed: number;
  /** Attempts in flight after this tick. */
  readonly running: number;
  /** Rows whose lease had expired and were returned to `queued`. */
  readonly reclaimed: number;
  /** True when a tick was already in progress, so this one did nothing. */
  readonly skipped: boolean;
}

/** What `recover()` found at boot. */
export interface RecoverReport {
  /** `running` rows returned to `queued` - one per attempt the dead process was making. */
  readonly requeued: number;
  /** `<moduleId>:<type>` keys with rows but no handler. Their rows are marked `orphaned`. */
  readonly orphaned: readonly string[];
  /** Recurring jobs (`JobSpec.schedule`) that were (re-)armed. */
  readonly scheduled: number;
}

/**
 * Counts by state, for an operator command.
 *
 * MOVED TO `#core/ports/admin` and re-exported here: `AdminPort.jobStats` returns it, and a
 * port in core may not name a type only an adapter defines. Importers of this file are
 * unchanged.
 */
export type { JobStats, RunningJob };

export interface JobSystem {
  /** The port one module gets. The module id is bound here, so a job cannot be filed as
   *  another module's, and `<moduleId>:<type>` is what the runner dispatches on. */
  portFor(moduleId: string): JobsPort;
  /** Called by the composition root once the registry exists. Keyed `<moduleId>:<type>`. */
  registerJobs(jobs: ReadonlyMap<string, ErasedJob>): void;
  /** ONCE, at boot, BEFORE `start()`. Re-queues what the dead process was running. */
  recover(): RecoverReport;
  start(): void;
  stop(opts?: { readonly graceMs?: number }): Promise<void>;
  /** One reconciliation pass. Claims and STARTS work; it does not await it. */
  tick(): Promise<TickReport>;
  /** Await every in-flight attempt. Tests and shutdown only. */
  drain(): Promise<void>;
  stats(): JobStats;
}

export interface JobSystemDeps {
  /** Must be a CORE-scoped port (`tablePrefix === 'core_'`). */
  readonly db: DbPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /** Keyed `<moduleId>:<type>`, exactly as `Registry.jobs` is. May also arrive later. */
  readonly jobs?: ReadonlyMap<string, ErasedJob>;
  /**
   * Preflight for `JobSpec.needs` (SC-12).
   * WHY optional: a job runner must be testable and runnable offline without a gateway. When
   * it is absent the preflight is skipped, which is the same behaviour as a job declaring no
   * `needs` - never a silent allow of something that was checked.
   */
  readonly discord?: Pick<DiscordPort, 'botPermissionsIn' | 'missingFromAppPermissions'>;
  readonly tickMs?: number;
  readonly leaseMs?: number;
  readonly maxConcurrent?: number;
  readonly batchSize?: number;
  /** Identifies this process in `lease_owner`. Defaults to a per-process UUID. */
  readonly ownerId?: string;
  /** Injected for deterministic jitter in tests. */
  readonly random?: () => number;
}

/** The columns the runner depends on, after they have been re-proven. */
interface JobRow {
  readonly id: string;
  readonly moduleId: string;
  readonly type: string;
  readonly payload: string;
  readonly runAfterMs: number;
  readonly deadlineAtMs: number;
  readonly dedupeKey: string | null;
  readonly attempts: number;
}

interface InFlight {
  readonly promise: Promise<void>;
  readonly controller: AbortController;
}

export function createJobSystem(deps: JobSystemDeps): JobSystem {
  const { db, clock } = deps;
  const logger = deps.logger.child({ component: 'jobs' });
  const table = db.table(CORE_TABLES.jobs);
  const tickMs = positive(deps.tickMs, DEFAULT_TICK_MS);
  const leaseMs = positive(deps.leaseMs, JOB_LEASE_MS);
  const maxConcurrent = positive(deps.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const batchSize = positive(deps.batchSize, 20);
  const ownerId = deps.ownerId ?? `${String(process.pid)}:${randomUUID()}`;
  const random = deps.random ?? Math.random;

  let handlers: ReadonlyMap<string, ErasedJob> = deps.jobs ?? new Map();
  const inFlight = new Map<string, InFlight>();
  const warnedOrphans = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let stopped = false;

  // -------------------------------------------------------------------------------------
  // Writes. Every one of them is a compare-and-set on the state we believe we hold, so a
  // late completion after `stop()` re-queued the row is a no-op rather than a resurrection.
  // -------------------------------------------------------------------------------------

  /**
   * `started_at_ms` IS WRITTEN HERE AND NOWHERE ELSE, which is the entire reason it can be
   * trusted. Every other timestamp on the row moves: `updated_at_ms` is rewritten by each lease
   * renewal and each `heartbeat()`, so it says when the LEASE was last touched, not when the
   * work began - and a job hung on a socket renews its lease perfectly. Written once at claim,
   * this is the only column from which "running for 3d 4h" can be a true sentence.
   *
   * It is not cleared on settle. Every reader filters on `state = 'running'`, and a row that
   * leaves that state carries a value nobody looks at until the next claim overwrites it.
   */
  function claim(id: string, now: number): boolean {
    const res = db.execute(
      sql`UPDATE ${table} SET state = 'running', attempts = attempts + 1, lease_owner = ${ownerId}, lease_until_ms = ${now + leaseMs}, updated_at_ms = ${now}, started_at_ms = ${now}
          WHERE id = ${id} AND state = 'queued'`,
    );
    return res.changes === 1;
  }

  function settleDone(id: string, now: number): void {
    db.execute(
      sql`UPDATE ${table} SET state = 'done', lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ${now}
          WHERE id = ${id} AND state = 'running' AND lease_owner = ${ownerId}`,
    );
  }

  function settleRequeue(id: string, now: number, runAfterMs: number, giveBackAttempt: boolean, lastError: string | null): void {
    const attemptsExpr = giveBackAttempt
      ? sql`attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,`
      : sql``;
    db.execute(
      sqlJoin([
        sql`UPDATE ${table} SET state = 'queued',`,
        attemptsExpr,
        sql`run_after_ms = ${runAfterMs}, last_error = ${lastError}, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ${now}
            WHERE id = ${id} AND state = 'running' AND lease_owner = ${ownerId}`,
      ]),
    );
  }

  function settleTerminal(id: string, state: JobState, now: number, lastError: string | null): void {
    db.execute(
      sql`UPDATE ${table} SET state = ${state}, last_error = ${lastError}, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ${now}
          WHERE id = ${id} AND state = 'running' AND lease_owner = ${ownerId}`,
    );
  }

  function markOrphaned(id: string, now: number): void {
    db.execute(
      sql`UPDATE ${table} SET state = 'orphaned', last_error = 'no handler is registered for this job type', updated_at_ms = ${now}
          WHERE id = ${id} AND state = 'queued'`,
    );
  }

  function renewLeases(now: number): void {
    const ids = [...inFlight.keys()];
    if (ids.length === 0) return;
    db.execute(
      sqlJoin([
        sql`UPDATE ${table} SET lease_until_ms = ${now + leaseMs}, updated_at_ms = ${now} WHERE lease_owner = ${ownerId} AND state = 'running' AND id IN (`,
        sqlValues(ids),
        sql`)`,
      ]),
    );
  }

  /**
   * Return leases nobody is renewing.
   * WHY the in-process ids are excluded: a job that is genuinely still running here must not
   * be reclaimed by the very process that is running it - that is the double-execution this
   * whole file exists to prevent.
   */
  function reclaimExpired(now: number): number {
    const ids = [...inFlight.keys()];
    const base = sql`UPDATE ${table} SET state = 'queued', lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ${now}
                     WHERE state = 'running' AND (lease_until_ms IS NULL OR lease_until_ms <= ${now})`;
    const q = ids.length === 0 ? base : sqlJoin([base, sql`AND id NOT IN (`, sqlValues(ids), sql`)`]);
    return db.execute(q).changes;
  }

  /**
   * The running job that has been running LONGEST, or `null` when nothing is running.
   *
   * ONE ROW, STRAIGHT OFF AN INDEX. `/admin jobs` runs inside an interaction, and a second read
   * of a table whose `done` rows outnumber its running ones by orders of magnitude has to be
   * cheap or it does not get to happen at all - `core_jobs_running_started_idx` is exactly
   * `(state, started_at_ms)`, so this is a seek to the front of one state's range.
   *
   * WHY THE OLDEST AND NOT A LIST: it is the only sample that can be alarming. If the oldest
   * running job is young, none of them is stuck, so one row answers the question the whole
   * command exists for and a list would just be the same answer plus noise.
   *
   * `started_at_ms IS NOT NULL` IS LOAD-BEARING, not defensive. The column arrived in core
   * migration 0002 and rows claimed before it carry NULL - and SQLite sorts NULL FIRST in an
   * ascending order, so without the filter the ONE row this query returns would be a
   * pre-migration row with no start time, every time, for as long as one existed. It would
   * report "nothing is stuck" by way of a row it could say nothing about at all.
   *
   * WHY THIS FUNCTION READS THE CLOCK. `RunningJob` carries `ageMs` as well as `startedAtMs`,
   * and the subtraction happens HERE because this is the layer that legitimately owns a clock.
   * The reader that most needs the age is `admin`'s `health()`, which core calls with no time
   * argument at all and which declares no `clock` capability - so if the port handed back only
   * an instant, `/status` could never say `degraded` about a wedged job, which is the single
   * thing this column was added for. Doing it here costs one subtraction and keeps the module
   * layer's capability line honest.
   */
  function oldestRunning(): RunningJob | null {
    const row = db.queryOne<Row>(
      sql`SELECT module_id, type, started_at_ms FROM ${table}
          WHERE state = 'running' AND started_at_ms IS NOT NULL
          ORDER BY started_at_ms ASC LIMIT 1`,
    );
    if (row === undefined) return null;
    const moduleId = textCol(row, 'module_id');
    const type = textCol(row, 'type');
    const startedAtMs = intCol(row, 'started_at_ms');
    // Re-proven column by column, like `readJobRow`: a row read out of SQLite is data, and a
    // half-read one must be no answer rather than an answer with `undefined` in it.
    if (moduleId === null || type === null || startedAtMs === null) return null;
    // Floored at zero: a backwards clock step is a fact about the host, and "running for -3s"
    // reads as a bug in the card that renders it.
    return { moduleId, type, startedAtMs, ageMs: Math.max(0, clock.now() - startedAtMs) };
  }

  // -------------------------------------------------------------------------------------
  // The attempt
  // -------------------------------------------------------------------------------------

  function runtimeFor(row: JobRow, attempt: number, controller: AbortController): JobRuntime {
    return {
      attempt,
      deadlineAtMs: row.deadlineAtMs,
      signal: controller.signal,
      heartbeat(): void {
        try {
          const now = clock.now();
          db.execute(
            sql`UPDATE ${table} SET lease_until_ms = ${now + leaseMs}, updated_at_ms = ${now}
                WHERE id = ${row.id} AND lease_owner = ${ownerId} AND state = 'running'`,
          );
        } catch (cause: unknown) {
          // A failed heartbeat is not the job's problem: the worst case is that the lease
          // expires and the work is retried, which is the semantics we promised anyway.
          logger.warn('heartbeat failed', { jobId: row.id, cause: cause instanceof Error ? cause.name : 'unknown' });
        }
      },
      sleep(ms: number): Promise<void> {
        return sleep(ms, controller.signal);
      },
    };
  }

  async function preflight(job: ErasedJob, payload: JsonObject): Promise<AppError | null> {
    const discord = deps.discord;
    if (discord === undefined || job.needs.length === 0) return null;
    const surface = readSurface(payload);
    // No card in the payload means there is nothing this job would edit, so there is nothing
    // to preflight. The job's own code still has to handle its absence.
    if (!surface.ok) return null;
    const channelId = toChannelId(surface.value.channelId);
    if (!channelId.ok) return null;
    const perms = await discord.botPermissionsIn(channelId.value);
    // WHY a failed lookup does not block: a transient 500 from Discord must not dead-letter a
    // build. The attempt proceeds and fails on its own terms if the permission is really gone.
    if (!perms.ok) return null;
    const missing = discord.missingFromAppPermissions(perms.value, job.needs);
    if (missing.length === 0) return null;
    return errors.missingBotPermission(
      missing,
      permissionInteger(job.needs),
      'Re-invite the bot with the missing permissions, then run the command again.',
    );
  }

  async function deadLetter(row: JobRow, job: ErasedJob, payload: JsonObject, attempt: number, error: AppError): Promise<void> {
    // A FRESH controller on purpose: the attempt's signal may already be aborted (that is
    // often WHY we are here), and `onDead` is the one call that must still be able to reach
    // Discord and tell the human. It is the notification, not the work.
    const controller = new AbortController();
    try {
      // The row is still `running` and still leased while this executes, ON PURPOSE: if the
      // process dies inside `onDead`, the next boot re-queues the row and the user gets told
      // then. A "dead" row that never told anybody looks exactly like a hung bot.
      await job.onDead(payload, error, runtimeFor(row, attempt, controller));
    } catch (cause: unknown) {
      logger.error('onDead threw', {
        jobId: row.id,
        jobKey: `${row.moduleId}:${row.type}`,
        cause: cause instanceof Error ? cause.name : 'unknown',
      });
    }
    settleTerminal(row.id, 'dead', clock.now(), operatorMessage(error));
    logger.warn('job dead-lettered', { jobId: row.id, jobKey: `${row.moduleId}:${row.type}`, attempts: attempt, code: error.code });
  }

  /**
   * WHY the controller is passed IN rather than created here: `tick` has to register it with
   * the in-flight entry, and `stop`/`cancel` abort through that entry. An earlier revision
   * created a second controller here, so every abort travelled to a signal no job ever saw -
   * a shutdown then waited out its whole grace period on a job that had already been told to
   * stop, which is exactly the class of bug the abort signal exists to prevent.
   */
  async function execute(row: JobRow, job: ErasedJob, attempt: number, controller: AbortController): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const payload = parseJsonObject(row.payload);
      if (payload === null) {
        // A payload written by an older deploy. Report, never retry: every attempt would fail
        // identically, and the module is the only thing that can explain it to the user.
        try {
          await job.onUnparseable({}, runtimeFor(row, attempt, controller));
        } catch (cause: unknown) {
          logger.error('onUnparseable threw', { jobId: row.id, cause: cause instanceof Error ? cause.name : 'unknown' });
        }
        settleTerminal(row.id, 'dead', clock.now(), 'payload was not a JSON object');
        return;
      }

      const now = clock.now();
      if (now >= row.deadlineAtMs) {
        await deadLetter(row, job, payload, attempt, errors.timeout(`${row.moduleId}.${row.type}`, now - row.runAfterMs, 'Run the command again.'));
        return;
      }
      if (attempt > job.maxAttempts) {
        await deadLetter(row, job, payload, attempt, errors.unavailable(`${row.moduleId}.${row.type}`, 'Run the command again.'));
        return;
      }

      const missing = await preflight(job, payload);
      if (missing !== null) {
        await applyOutcome(row, job, payload, attempt, { kind: 'failed', error: missing });
        return;
      }

      const remaining = row.deadlineAtMs - now;
      deadlineTimer = setTimeout(() => controller.abort(), remaining);
      deadlineTimer.unref();

      let outcome: JobOutcome;
      try {
        outcome = await job.run(payload, runtimeFor(row, attempt, controller));
      } catch (cause: unknown) {
        // A throwing job must not take the process down: an unhandled rejection here would
        // kill every other module's work too.
        outcome = {
          kind: 'failed',
          error: errors.internal(row.id, `job threw: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : 'unknown'}`),
        };
      }
      await applyOutcome(row, job, payload, attempt, outcome);
    } catch (cause: unknown) {
      // Defence in depth: nothing in this function may reject, because it is started and not
      // awaited by `tick`.
      logger.error('job runner failed outside the handler', {
        jobId: row.id,
        cause: cause instanceof Error ? cause.name : 'unknown',
      });
      try {
        // Release the row now rather than leaving it leased until the reclaimer notices. The
        // write is the same CAS every settle uses, so it is a no-op if the outcome already
        // landed and only the bookkeeping after it threw.
        const now = clock.now();
        settleRequeue(row.id, now, now, false, 'runner error');
      } catch {
        // The lease expiry is the backstop; there is nothing further to try here.
      }
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      inFlight.delete(row.id);
    }
  }

  async function applyOutcome(row: JobRow, job: ErasedJob, payload: JsonObject, attempt: number, outcome: JobOutcome): Promise<void> {
    const now = clock.now();
    switch (outcome.kind) {
      case 'done': {
        settleDone(row.id, now);
        rearmSchedule(row, job, now);
        return;
      }
      case 'retry': {
        const at = now + Math.max(0, outcome.afterMs);
        if (at >= row.deadlineAtMs) {
          // Bounded by construction (SC-14): a poller may not outlive its deadline just
          // because it keeps saying "not yet".
          await deadLetter(row, job, payload, attempt, errors.timeout(`${row.moduleId}.${row.type}`, row.deadlineAtMs - row.runAfterMs, 'Run the command again.'));
          rearmSchedule(row, job, now);
          return;
        }
        // `retry` hands the attempt BACK - core is explicit that polling is not failing, and
        // a 30-minute build would otherwise burn `maxAttempts` in the first two minutes.
        settleRequeue(row.id, now, at, true, null);
        logger.debug('job asked to retry', { jobId: row.id, why: outcome.why, afterMs: outcome.afterMs });
        return;
      }
      case 'failed': {
        const error = outcome.error;
        const exhausted = attempt >= job.maxAttempts || !isRetryable(error);
        if (exhausted) {
          await deadLetter(row, job, payload, attempt, error);
          rearmSchedule(row, job, now);
          return;
        }
        const delay = backoffDelayMs(job.backoff, attempt, random);
        const at = now + delay;
        if (at >= row.deadlineAtMs) {
          await deadLetter(row, job, payload, attempt, error);
          rearmSchedule(row, job, now);
          return;
        }
        settleRequeue(row.id, now, at, false, operatorMessage(error));
        logger.info('job attempt failed; retrying', { jobId: row.id, attempt, delayMs: delay, code: error.code, internal: error.internal });
        return;
      }
      default: {
        const exhaustive: never = outcome;
        void exhaustive;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Recurring jobs
  // -------------------------------------------------------------------------------------

  /** The dedupe key a scheduled job uses, so exactly one occurrence is ever live. */
  const SCHEDULE_KEY = '@schedule';

  function enqueueRaw(
    moduleId: string,
    type: string,
    payload: JsonObject,
    runAfterMs: number,
    deadlineAtMs: number,
    dedupeKey: string | null,
  ): Result<EnqueueResult, AppError> {
    const json = serialisePayload(payload);
    if (json === null) {
      return Err(errors.config(moduleId, `job payload for "${type}" is not serialisable or exceeds ${String(MAX_PAYLOAD_BYTES)} bytes`, 'Store the large value in a table and put its id in the payload.'));
    }
    if (!Number.isFinite(runAfterMs) || !Number.isFinite(deadlineAtMs)) {
      return Err(errors.config(moduleId, `job "${type}" has a non-finite runAfterMs/deadlineAtMs`, 'Use clock.now() + a delay.'));
    }
    if (deadlineAtMs <= runAfterMs) {
      return Err(errors.config(moduleId, `job "${type}" has a deadline at or before its start time`, 'Set deadlineAtMs to clock.now() + the job deadline.'));
    }
    try {
      return db.transaction((): Result<EnqueueResult, AppError> => {
        if (dedupeKey !== null) {
          const live = findLive(moduleId, dedupeKey);
          // The double-click fence for async work: the SECOND Approve gets the FIRST job's id
          // and `created: false`, which is exactly what the card needs to say "already building".
          if (live !== undefined) return Ok({ id: live, created: false });
        }
        const now = clock.now();
        const id = newJobId(now);
        db.execute(
          sql`INSERT INTO ${table} (id, module_id, type, payload, run_after_ms, deadline_at_ms, dedupe_key, state, attempts, last_error, lease_owner, lease_until_ms, created_at_ms, updated_at_ms)
              VALUES (${id}, ${moduleId}, ${type}, ${json}, ${runAfterMs}, ${deadlineAtMs}, ${dedupeKey}, 'queued', 0, NULL, NULL, NULL, ${now}, ${now})`,
        );
        return Ok({ id, created: true });
      });
    } catch (cause: unknown) {
      logger.error('enqueue failed', { moduleId, type, cause: cause instanceof Error ? cause.name : 'unknown' });
      return Err(errors.upstream('sqlite', 0, 'Try the command again; nothing was started.', 'core_jobs insert failed'));
    }
  }

  function rearmSchedule(row: JobRow, job: ErasedJob, now: number): void {
    const schedule = job.schedule;
    if (schedule === null || row.dedupeKey !== SCHEDULE_KEY) return;
    const everyMs = positive(schedule.everyMs, tickMs);
    const at = now + everyMs;
    const r = enqueueRaw(row.moduleId, row.type, {}, at, at + Math.max(job.deadlineMs, everyMs), SCHEDULE_KEY);
    if (!r.ok) logger.error('could not re-arm a scheduled job', { jobKey: `${row.moduleId}:${row.type}` });
  }

  /** Arm every recurring job that has no live occurrence. Idempotent, so boot may call it. */
  function armSchedules(): number {
    let armed = 0;
    for (const [key, job] of handlers) {
      if (job.schedule === null) continue;
      const now = clock.now();
      const everyMs = positive(job.schedule.everyMs, tickMs);
      const r = enqueueRaw(job.moduleId, job.type, {}, now, now + Math.max(job.deadlineMs, everyMs), SCHEDULE_KEY);
      if (!r.ok) {
        logger.error('could not arm a scheduled job', { jobKey: key });
        continue;
      }
      if (r.value.created) armed += 1;
    }
    return armed;
  }

  // -------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------

  function findLive(moduleId: string, dedupeKey: string): JobId | undefined {
    const row = db.queryOne<Row>(
      sql`SELECT id FROM ${table} WHERE module_id = ${moduleId} AND dedupe_key = ${dedupeKey} AND state IN ('queued', 'running') LIMIT 1`,
    );
    if (row === undefined) return undefined;
    const id = textCol(row, 'id');
    if (id === null) return undefined;
    // Re-branded rather than asserted: a job id read back out of SQLite is bytes.
    const jobId = toJobIdOrNull(id);
    return jobId ?? undefined;
  }

  function due(now: number, limit: number): readonly JobRow[] {
    const rows = db.query<Row>(
      sql`SELECT * FROM ${table} WHERE state = 'queued' AND (run_after_ms <= ${now} OR deadline_at_ms <= ${now})
          ORDER BY run_after_ms ASC, id ASC LIMIT ${limit}`,
    );
    const out: JobRow[] = [];
    for (const row of rows) {
      const parsed = readJobRow(row);
      if (parsed === null) {
        logger.error('unreadable core_jobs row skipped', { id: textCol(row, 'id') ?? '?' });
        continue;
      }
      out.push(parsed);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------------------

  async function tick(): Promise<TickReport> {
    if (stopped || ticking) return { claimed: 0, running: inFlight.size, reclaimed: 0, skipped: true };
    ticking = true;
    try {
      const now = clock.now();
      // Renew BEFORE reclaiming, so a long attempt in this process never reclaims itself.
      renewLeases(now);
      const reclaimed = reclaimExpired(now);
      const capacity = maxConcurrent - inFlight.size;
      if (capacity <= 0) return { claimed: 0, running: inFlight.size, reclaimed, skipped: false };

      let claimed = 0;
      for (const row of due(now, Math.min(capacity, batchSize))) {
        const key = `${row.moduleId}:${row.type}`;
        const job = handlers.get(key);
        if (job === undefined) {
          markOrphaned(row.id, now);
          if (!warnedOrphans.has(key)) {
            warnedOrphans.add(key);
            logger.error('queued job has no handler; marking it orphaned', { jobKey: key });
          }
          continue;
        }
        // Nothing may run twice: the row must still be `queued` when we take it, and this
        // process must not already be running it.
        if (inFlight.has(row.id)) continue;
        if (!claim(row.id, now)) continue;
        claimed += 1;
        const attempt = row.attempts + 1;
        const controller = new AbortController();
        // Started, deliberately NOT awaited - see the header. The controller is registered
        // with the entry, so `cancel` and `stop` reach the signal the handler is holding.
        const promise = execute(row, job, attempt, controller);
        inFlight.set(row.id, { promise, controller });
      }
      return { claimed, running: inFlight.size, reclaimed, skipped: false };
    } finally {
      ticking = false;
    }
  }

  async function drain(): Promise<void> {
    // A settled job can start another one only through a fresh tick, so one pass is enough -
    // but the map is re-read each round to cover a job that was claimed while we waited.
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()].map((f) => f.promise));
    }
  }

  return {
    portFor(moduleId: string): JobsPort {
      return {
        enqueue(req: JobRequest): Result<EnqueueResult, AppError> {
          if (handlers.size > 0 && !handlers.has(`${moduleId}:${req.type}`)) {
            // Fail at the enqueue, where the caller can still tell the user, rather than
            // leaving a row that routes to nothing behind a card that says "building...".
            return Err(
              errors.config(moduleId, `no job of type "${req.type}" is declared by module "${moduleId}"`, 'Declare it in the module handle\'s `jobs` array.'),
            );
          }
          return enqueueRaw(moduleId, req.type, req.payload, req.runAfterMs, req.deadlineAtMs, req.dedupeKey);
        },

        cancel(id: JobId): Result<boolean, AppError> {
          try {
            const now = clock.now();
            const res = db.execute(
              sql`UPDATE ${table} SET state = 'cancelled', lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ${now}
                  WHERE id = ${id} AND module_id = ${moduleId} AND state IN ('queued', 'running')`,
            );
            // An attempt already in flight is told to stop; its own settle is a CAS on
            // `state = 'running'`, which no longer matches, so it cannot resurrect the row.
            inFlight.get(id)?.controller.abort();
            return Ok(res.changes > 0);
          } catch (cause: unknown) {
            logger.error('cancel failed', { moduleId, cause: cause instanceof Error ? cause.name : 'unknown' });
            return Err(errors.upstream('sqlite', 0, 'Try again in a moment.', 'core_jobs cancel failed'));
          }
        },

        findByDedupeKey(dedupeKey: string): JobId | undefined {
          return findLive(moduleId, dedupeKey);
        },
      };
    },

    registerJobs(jobs: ReadonlyMap<string, ErasedJob>): void {
      handlers = jobs;
    },

    recover(): RecoverReport {
      const now = clock.now();
      // Those leases belong to a process that is gone. Their attempts have already been
      // counted, which is what stops a crash-loop payload from being immortal.
      const requeued = db.execute(
        sql`UPDATE ${table} SET state = 'queued', lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ${now}
            WHERE state = 'running'`,
      ).changes;

      const queuedRows = db.query<Row>(sql`SELECT DISTINCT module_id, type FROM ${table} WHERE state IN ('queued', 'running')`);
      const orphaned: string[] = [];
      for (const row of queuedRows) {
        const moduleId = textCol(row, 'module_id');
        const type = textCol(row, 'type');
        if (moduleId === null || type === null) continue;
        const key = `${moduleId}:${type}`;
        if (handlers.has(key)) continue;
        orphaned.push(key);
        logger.error('queued jobs have no handler after this deploy', { jobKey: key });
      }
      const scheduled = armSchedules();
      logger.info('job recovery complete', { requeued, orphaned: orphaned.length, scheduled });
      return { requeued, orphaned, scheduled };
    },

    start(): void {
      if (timer !== null) return;
      stopped = false;
      // Idempotent, and here as well as in `recover()` so a composition root that forgets the
      // boot sweep still gets its recurring jobs instead of a queue that silently never runs.
      armSchedules();
      timer = setInterval(() => {
        // `void tick()` discards the promise WITHOUT attaching a rejection handler, so a single
        // throw anywhere in the tick — a locked database, a corrupt row, a disk error — became an
        // unhandledRejection. main.ts treats that as fatal and exits non-zero, so one transient
        // SQLITE_BUSY took the whole bot down mid-build.
        //
        // A tick is a POLL: the correct response to one failing is to log it and take the next
        // one, not to end the process. Anything genuinely unrecoverable will keep failing and
        // stays visible in the log.
        tick().catch((cause: unknown) => {
          logger.error('job tick failed; continuing to the next tick', {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
      }, tickMs);
      // WHY unref: the gateway connection is what keeps this process alive. A reconciler that
      // held the loop open by itself would turn every `npm run` into a hang.
      timer.unref();
      logger.info('job runner started', { tickMs, leaseMs, maxConcurrent });
    },

    async stop(opts?: { readonly graceMs?: number }): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      for (const f of inFlight.values()) f.controller.abort();
      const graceMs = positive(opts?.graceMs, DEFAULT_SHUTDOWN_GRACE_MS);
      await Promise.race([drain(), delay(graceMs)]);
      // Anything still in flight is abandoned rather than waited on forever. Its lease is
      // released and its attempt handed back, because a SIGTERM is not a failed attempt.
      const now = clock.now();
      for (const id of inFlight.keys()) settleRequeue(id, now, now, true, 'released at shutdown');
      logger.info('job runner stopped', { abandoned: inFlight.size });
    },

    tick,
    drain,

    stats(): JobStats {
      const rows = db.query<Row>(sql`SELECT state, COUNT(*) AS n FROM ${table} GROUP BY state`);
      const counts = new Map<string, number>();
      for (const row of rows) {
        const state = textCol(row, 'state');
        const n = intCol(row, 'n');
        if (state !== null && n !== null) counts.set(state, n);
      }
      return {
        queued: counts.get('queued') ?? 0,
        running: counts.get('running') ?? 0,
        done: counts.get('done') ?? 0,
        dead: counts.get('dead') ?? 0,
        cancelled: counts.get('cancelled') ?? 0,
        orphaned: counts.get('orphaned') ?? 0,
        // THE FIELD THAT MAKES THE COUNTS MEAN SOMETHING. Without it "1 running" is the same
        // card for a healthy build and for a wedged one; see `oldestRunning` above.
        oldestRunning: oldestRunning(),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** `null` when the payload is not JSON, or is bigger than a row has any business being. */
function serialisePayload(payload: JsonObject): string | null {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return null;
  }
  return Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES ? json : null;
}

/**
 * WHY it goes back through `toJobId`: `JobId` is branded, a row read out of SQLite has not
 * earned the brand, and core's own door carries the regex that IS the evidence for it.
 */
function toJobIdOrNull(raw: string): JobId | null {
  const r = toJobId(raw);
  return r.ok ? r.value : null;
}

function readJobRow(row: Row): JobRow | null {
  const id = textCol(row, 'id');
  const moduleId = textCol(row, 'module_id');
  const type = textCol(row, 'type');
  const payload = textCol(row, 'payload');
  const runAfterMs = intCol(row, 'run_after_ms');
  const deadlineAtMs = intCol(row, 'deadline_at_ms');
  const attempts = intCol(row, 'attempts');
  if (id === null || moduleId === null || type === null || payload === null) return null;
  if (runAfterMs === null || deadlineAtMs === null || attempts === null) return null;
  return { id, moduleId, type, payload, runAfterMs, deadlineAtMs, dedupeKey: textCol(row, 'dedupe_key'), attempts };
}

/**
 * A cancellable wait.
 * WHY it resolves rather than rejects on abort: a job that is being shut down should return
 * `retry`, not throw - and a rejected sleep is how an unhandled rejection reaches the top.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
