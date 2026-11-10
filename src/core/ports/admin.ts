/**
 * The OBSERVABILITY port - the door an operator command goes through.
 *
 * POSTMORTEM THIS FILE CLOSES: "the machinery recorded everything and could show none of it."
 * `AuditLog.recent`, `AuditLog.forGuild` and `JobSystem.stats` were all written, all tested,
 * and all called by nothing outside their own test files. The append-only audit table that
 * exists so "who approved this, and which layer let them?" is answerable was answerable only
 * by opening the SQLite file on the host - which is not a thing anyone does at 3am from a
 * phone, and is impossible for the person actually being asked.
 *
 * A capability, not a widened `db`. Reading `core_audit` from a module would otherwise mean
 * handing that module a core-scoped `DbPort`, i.e. write access to the access-control table as
 * well - so the useful half of this arrives with the dangerous half attached. `admin` is the
 * narrow grant: two reads, no writes, nothing that spends money or changes state.
 *
 * READ THE ABSENCE. There is no `deleteAudit`, no `clearJobs`, no `cancelJob`, no `grant`. The
 * audit log's entire value is that it is append-only, and a port that could edit it would make
 * "the row is there" mean "the row is there and nobody has been to it since" - which is a
 * weaker claim than the one the table exists to support. Cancelling a job is a JOB decision
 * and belongs to the module that filed it, through `JobsPort.cancel`.
 *
 * WHO SHOULD HOLD IT: exactly one module, whose command is gated behind a permission whose
 * fallback is `guild-admin` or narrower. Audit rows carry actor ids and a `detail` object; the
 * adapter redacts credentials on the way IN, but "which admin ran which command when" is still
 * not for a public channel.
 */

import type { AuditRecord } from '#core/ports/audit';

/**
 * One durable job that is running right now.
 *
 * Four fields, and no `id`: an operator cannot do anything with a ULID, and the only question
 * this type exists to answer - "what is that, and how long has it been like that?" - is
 * answered by the pair a human can recognise plus the age, twice over.
 *
 * WHY THE AGE IS CARRIED AS WELL AS THE INSTANT, which looks redundant and is not. The two
 * readers need different things and only one of them holds a clock:
 *
 *   - `/admin jobs` renders a card and has `inv.at`, so it could subtract for itself.
 *   - `ModuleHandle.health()` - which is what makes `/status` say `degraded` instead of `ok`
 *     while a job is wedged, i.e. the entire point of the round - IS CALLED WITH NO TIME AT
 *     ALL, and the `admin` module deliberately declares no `clock` capability. A start instant
 *     is unusable there, so a port that offered only `startedAtMs` would render the fact on
 *     the card and stay silent in the one place an operator is actually watching.
 *
 * So the ADAPTER subtracts, because the adapter is the layer that legitimately owns a clock.
 * `startedAtMs` stays because it is the honest stored column and the thing a log line should
 * carry; `ageMs` is what a renderer and a health check can both use.
 */
export interface RunningJob {
  /** The module that filed it. */
  readonly moduleId: string;
  /** The `JobSpec.type` that module declared. `<moduleId>:<type>` is the runner's own key. */
  readonly type: string;
  /**
   * When the CURRENT attempt was claimed. Absolute epoch milliseconds.
   *
   * WHY NOT `updated_at_ms`, which was already on the row: a running job renews its lease every
   * tick and a long one heartbeats, and both write `updated_at_ms`. So the column that looks
   * like "when did this last do something" reads as NOW for a job that has been wedged since
   * Tuesday - it is a liveness signal for the LEASE, not for the work. A job that hangs on a
   * socket keeps its lease perfectly. This is a separate column, written once at claim and
   * never touched again, which is the only way a duration can be true.
   */
  readonly startedAtMs: number;
  /**
   * How long the current attempt has been running, as at the moment `jobStats()` was called.
   *
   * `clock.now() - startedAtMs`, floored at zero. The floor is not defensive tidying: a clock
   * that steps backwards (NTP, or a second process on the same database file) really can make
   * that subtraction negative, and "running for -3s" reads as a bug in the card rather than as
   * a fact about the host.
   */
  readonly ageMs: number;
}

/**
 * Durable-job counts, by state, plus the one sample that says whether any of them is stuck.
 *
 * WHY EVERY STATE IS A SEPARATE FIELD rather than a map: the two numbers that mean something
 * are `dead` and `orphaned`, and both are invisible in a total. `dead` is a job that exhausted
 * its attempts - a build nobody will ever hear about again. `orphaned` is a queued row whose
 * `<moduleId>:<type>` has no handler, i.e. a renamed or quarantined module, which is the exact
 * shape of "the card still says Building..." with nothing left to move it. Naming them makes a
 * renderer that forgets one a visibly incomplete renderer.
 *
 * WHY IT LIVES IN CORE: `AdminPort` returns it, and a port may not name a type that only an
 * adapter defines. `#adapters/system/jobs` re-exports this name, so its own importers are
 * unchanged.
 */
export interface JobStats {
  readonly queued: number;
  readonly running: number;
  readonly done: number;
  readonly dead: number;
  readonly cancelled: number;
  readonly orphaned: number;
  /**
   * The running job that has been running LONGEST, or `null` when nothing is running.
   *
   * WHY COUNTS ALONE COULD NOT ANSWER THE QUESTION `/admin jobs` EXISTS FOR. "1 running" is the
   * same sentence for a build that started four seconds ago and a build wedged since Tuesday,
   * and those are the two ends of "is anything stuck?" - so an operator who read the card
   * learned nothing they did not already assume. One timestamp turns the same row into
   * "builder:build, running for 3d 4h", which is a fact somebody can act on. It is the OLDEST
   * one because that is the only sample that can be alarming: if the oldest is young, none of
   * them is stuck.
   *
   * IT IS REQUIRED. It shipped optional for exactly one commit, as the additive half of a
   * two-step widening, so that adding it could not break `JobStats` literals owned by another
   * author. `/admin jobs` now renders it and `health()` now degrades on it, so the second step
   * has been taken: a `JobStats` that omits this is an implementation that cannot answer the
   * question the type exists for, and that should not typecheck.
   *
   * `null` MEANS NOTHING IS RUNNING, and it is the only thing it means. It is not "the port
   * does not know" - there is no longer a spelling for that.
   *
   * Read it through `oldestRunningJob(stats)` rather than directly; see that function.
   */
  readonly oldestRunning: RunningJob | null;
}

/**
 * The oldest running job.
 *
 * IT SURVIVES THE FIELD BECOMING REQUIRED, and is still the sanctioned way to read it. While
 * the field was optional this collapsed `undefined` and `null` - which `exactOptionalPropertyTypes`
 * makes genuinely different types - into the one state a renderer can mean. Now that it is
 * required the two spellings cannot both occur, so this is a plain read; keeping it means the
 * call sites that already go through it do not churn, and it stays the single place to put any
 * future normalisation rather than that normalisation being scattered over every renderer.
 */
export function oldestRunningJob(stats: JobStats): RunningJob | null {
  return stats.oldestRunning;
}

/** The port a module receives when it declares the `admin` capability. */
export interface AdminPort {
  /**
   * The newest audit rows, newest first.
   *
   * `guildId === null` means EVERY guild, which is what a DM or a console-shaped command
   * wants; a guild id scopes it to that guild. The two are separate arguments rather than two
   * methods because the caller is always deciding between them, and a caller that forgot the
   * scoping would otherwise be reading another server's rows into this one's channel.
   *
   * `limit` is clamped by the adapter, so an enormous number is a small answer rather than a
   * table scan that blocks the interaction.
   */
  recentAudit(guildId: string | null, limit: number): readonly AuditRecord[];

  /**
   * A count per durable-job state, right now, plus the oldest running job.
   *
   * The counts say HOW MANY; `oldestRunning` is the only field that can say whether any of them
   * is stuck - read it through `oldestRunningJob(stats)`.
   *
   * Synchronous, like every other SQLite-backed read in this system: `node:sqlite` is
   * synchronous, and an `await` here would buy a microtask and no concurrency.
   */
  jobStats(): JobStats;
}

/** Short alias, matching the style of every other port in `#core/ports`. */
export type Admin = AdminPort;
