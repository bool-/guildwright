/**
 * `/admin`, part 1: pure logic. No Discord, no SQL, no clock, and — deliberately — no network.
 *
 * WHAT THIS MODULE IS FOR, stated plainly because the code alone does not say it.
 *
 * An operator with SSH and a Discord client could not answer "what is this bot doing?" without
 * stopping the process and opening SQLite by hand. Two facilities existed to answer it and
 * neither had a caller: `AuditLog.recent`/`forGuild` and `JobSystem.stats` were implemented,
 * tested, and reachable from nothing. So every approval and every denial was recorded, with the
 * layer that decided it, into a table no shipped command could read — and when a build hung,
 * `/status` said `ok`, because no module's health check looked at the job queue at all.
 *
 * THE THREE THINGS THIS ROUND CHANGED, each of them a case where the shipped command claimed
 * more than it could do:
 *
 *  A. "IS ANYTHING STUCK?" WAS UNANSWERABLE. Counts alone say `running: 1` for a job wedged
 *     since Tuesday and for one that started four seconds ago. `readOldestRunning` reads the
 *     oldest running attempt's name and age off `JobStats` and `jobs()` compares it against
 *     `stuckAfterMs`, so the card — and `/status` — can tell the two apart instead of printing
 *     a number and a disclaimer.
 *
 *  B. THE TRAIL STOPPED AT 20 ROWS. `audit()` now takes a `page`, so an investigation walks
 *     backwards without opening SQLite. Paging is a plain ARGUMENT, not a button, and the
 *     arithmetic that decided that is in `present.ts` beside the command — a `custom_id` entity
 *     segment is 40 characters and this query needs up to 80 of them, so a button could only
 *     ever have carried PART of the filter, and an "Older →" that silently drops your filter is
 *     precisely the class of untruth this round exists to delete.
 *
 *  C. THERE WAS NO FILTER. "Every denial in the last week" meant reading twenty rows and asking
 *     again. `AuditFilter` narrows by action prefix, by actor and by decision layer, and the
 *     page reports what it SEARCHED as well as what it found — see `windowFull`, which is the
 *     honest half: the port can only hand back the newest N rows, so an answer that hit that
 *     ceiling says so rather than implying it looked at everything.
 *
 * FOUR DECISIONS HERE ARE LOAD-BEARING:
 *
 *  1. NO NETWORK CALL, EVER. `src/modules/credentials/module.ts` already reasoned that a health
 *     check spending the same quota as the feature can take the feature down during exactly the
 *     incident that made someone run it. That reasoning holds harder here: this is the module
 *     you reach for WHEN SOMETHING IS ALREADY WRONG. Everything it reads is a local SQLite
 *     count, and `AdminPort` has no method that could do otherwise.
 *
 *  2. THE GUILD SCOPE COMES FROM THE INVOCATION, NEVER FROM AN OPTION. `recentAudit(null, n)`
 *     returns rows from EVERY guild. There is no command option that can produce that `null`:
 *     it comes from `inv.space.guildId` being absent, i.e. a DM, where the `guild-admin`
 *     fallback denies everyone (`access.ts` returns `deny` for `guild-admin` when `guildId` is
 *     null) so only the application owner's L0 bypass gets there. A server manager in guild A
 *     reads guild A and nothing else, and that is a property of the plumbing rather than of a
 *     filter someone remembered to write. THE FILTERS ADDED THIS ROUND NARROW THAT SCOPE AND
 *     CAN NEVER WIDEN IT: `AuditQuery.guildId` is a separate field from `AuditQuery.filter`,
 *     and nothing in `matchesFilter` reads `guildId` at all.
 *
 *  3. `detail` IS RENDERED AS DATA. It is a `JsonObject` that by contract never carries raw
 *     user text, and the temptation is to unpack it into a readable sentence. Doing that would
 *     re-assemble strings a sanitiser already took apart, in the one table that has to stay
 *     trustworthy. It is serialised with `JSON.stringify` and truncated, and that is all — see
 *     `compactDetail` in `present.ts`. The filters added this round are the same discipline
 *     pointing the other way: they MATCH against `action`, `actorId` and `decisionLayer`, which
 *     are constants the machinery wrote, and never against `detail`.
 *
 *  4. THE ACTION FILTER IS NARROWER THAN THE OPTION THAT CARRIES IT. `parseActionFilter` runs
 *     the text through `toPlainName` and then refuses anything that is not a lowercase dotted
 *     verb, so the value that reaches a table cell is drawn from `[a-z0-9_.]` and cannot close
 *     a code fence, carry a mention, or hide a zero-width character — whatever the renderer
 *     does with it afterwards.
 */

import type { AdminPort, AuditRecord, CatalogPort, JobStats } from '#core/ports';
import { oldestRunningJob } from '#core/ports';
import type { AppError } from '#core/errors';
import { errors } from '#core/errors';
import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { DecisionLayer } from '#core/policy';
import type { UserText } from '#core/text';
import { renderPlainName, toPlainName } from '#core/text';

/**
 * The most rows one `/admin audit` card carries.
 *
 * WHY IT IS CAPPED AT ALL, and capped here rather than trusted to Discord: the renderer turns a
 * table into a fenced code block inside an embed description, and Discord rejects a description
 * over 4096 characters — in front of the operator, during the incident. `module.test.ts` renders
 * a worst-case card through the REAL renderer and asserts it fits.
 */
export const MAX_AUDIT_ROWS = 20;

/** How many rows an operator gets when they do not say. Overridable per install. */
export const DEFAULT_AUDIT_ROWS = 10;

/**
 * The highest page an operator may ask for.
 *
 * WHY IT IS NOT UNBOUNDED: `AdminPort.recentAudit` takes a `limit` and nothing else, so page N
 * is reached by reading N pages of rows and throwing the first N-1 away. `MAX_AUDIT_SCAN` is
 * the ceiling on that read, and `MAX_AUDIT_PAGE * DEFAULT_AUDIT_ROWS` is exactly it — so the
 * last page an operator can ask for is the last page the port can actually be made to produce.
 */
export const MAX_AUDIT_PAGE = 50;

/**
 * The most rows one `/admin audit` will read out of the port to answer one question.
 *
 * WHY A CEILING EXISTS AND WHY THE CARD REPORTS HITTING IT. There is no offset and no
 * server-side predicate on `recentAudit`, so "every denial by this person" is answered by
 * reading the newest rows and filtering them here. That is a local, synchronous SQLite read
 * (the adapter clamps its own `limit` at 1000, so this passes through unchanged) and it is
 * cheap — but it is a WINDOW, not the table. An answer that filled the window is an answer that
 * never looked at anything older, and `AuditPage.windowFull` exists so the card can say that
 * out loud instead of letting "no denials found" mean two different things.
 */
export const MAX_AUDIT_SCAN = 500;

/** The longest action prefix a filter may carry. Dotted verbs are short by contract. */
export const ACTION_FILTER_MAX = 40;

/** How many distinct actions the empty-result card lists to say what IS in the window. */
export const MAX_PRESENT_ACTIONS = 12;

/** The `layer` choice meaning "rows that recorded a fact rather than a decision". */
export const NO_LAYER_FILTER = 'none';

/**
 * Every authorization layer, plus the sentinel for "no decision".
 *
 * WHY `satisfies` and not a bare array: this list is handed to `args.choice`, which is the
 * server-side allow-list (SC-11 — Discord permits a client to submit a value that was never
 * offered). A typo here would be a filter that silently matches nothing; `satisfies` makes it a
 * compile error against the `DecisionLayer` union instead.
 */
export const LAYER_CHOICES = [
  'L0-owner',
  'L1-allowlist',
  'L2-fallback',
  'L3-deny',
  NO_LAYER_FILTER,
] as const satisfies readonly (DecisionLayer | typeof NO_LAYER_FILTER)[];

/** What the `layer` option may carry. */
export type LayerFilter = (typeof LAYER_CHOICES)[number];

/** A module the loader refused to install. Named here because it explains orphaned job rows. */
export interface QuarantinedModule {
  readonly id: string;
  readonly reason: string;
}

/**
 * The oldest job attempt still in `running`, normalised.
 *
 * `name` is `<moduleId>:<type>`, which is how the runner keys a handler — the same string that
 * turns up in `orphaned` when no installed module registers it.
 */
export interface OldestRunningJob {
  readonly name: string;
  /** How long the attempt has been running. Never negative. */
  readonly ageMs: number;
}

/**
 * THE FIELD THIS MODULE READS AND DOES NOT OWN — now resolved.
 *
 * This shipped as a two-spelling `unknown`-valued probe while `#core/ports` was still deciding
 * the shape, precisely so that guessing wrong could not cost the point of the change (a jobs
 * card that silently omits the one thing it was extended for). THE PORT HAS LANDED, so the
 * probe is gone: `JobStats.oldestRunning` is a required `RunningJob | null`, and this module
 * reads it as the typed value it is. A hedge kept past the moment it resolves is just a second
 * shape nobody maintains.
 *
 * WHAT THE NEGOTIATION SETTLED ON, and why it is the shape that works:
 *
 *   - `RunningJob` carries `moduleId` and `type` separately. The display name this module wants
 *     is `<moduleId>:<type>` — the runner's own handler key, and the same string that turns up
 *     in `orphaned` — so it is DERIVED here rather than stored twice on the port.
 *   - `RunningJob` carries `ageMs` as well as `startedAtMs`, and the adapter does the
 *     subtraction. That is not convenience: `health()` is called with no time and this module
 *     declares no `clock` capability, so an instant alone could be rendered on the card and
 *     could never degrade `/status` — which is the one place the wedged-job verdict matters.
 *
 * `ObservedJobStats` survives as an alias so the rest of this file and its tests read the same,
 * but it is now exactly `JobStats`.
 */
export type ObservedJobStats = JobStats;

/** Everything `/admin jobs` renders. */
export interface JobsSnapshot {
  readonly stats: JobStats;
  /** Every row in the table, whatever its state. Zero means nothing has ever been queued. */
  readonly total: number;
  /**
   * The oldest attempt still running, or `null` when nothing is running — and ALSO `null` when
   * the port does not report it, which the card distinguishes from "nothing is running" by
   * looking at `stats.running`.
   */
  readonly oldestRunning: OldestRunningJob | null;
  /** The age past which a running job is reported as wedged rather than working. */
  readonly stuckAfterMs: number;
  /** `oldestRunning` is at or past `stuckAfterMs`. THE ANSWER TO "is anything stuck?". */
  readonly longRunning: boolean;
  /**
   * A state a human has to act on: a dead-lettered job, a row whose handler no longer exists, a
   * module that failed to install, or an attempt that has been running past `stuckAfterMs`.
   * That last one is new: until the port reported an age, one sample genuinely could not tell a
   * working job from a wedged one, and the card said so instead of guessing.
   */
  readonly needsAttention: boolean;
  /**
   * WHY QUARANTINED MODULES APPEAR ON THE JOBS CARD: `orphaned` means "rows exist for
   * `<moduleId>:<type>` and no handler is registered", and the commonest cause of that is a
   * module that failed to install this boot. Reporting the count without the cause makes an
   * operator go looking for a bug that is really a stack trace in the boot log.
   */
  readonly quarantined: readonly QuarantinedModule[];
}

/**
 * What an operator narrowed the trail to.
 *
 * EVERY FIELD MATCHES AGAINST A CONSTANT THE MACHINERY WROTE — a dotted verb, a snowflake, an
 * authorization layer. None of them touches `detail`, which is the one column carrying arbitrary
 * structure; a filter over it would be the first reason anybody ever had to parse it.
 */
export interface AuditFilter {
  /** Lowercase dotted-verb PREFIX: `builder` matches `builder.approve_denied`. */
  readonly action: string | null;
  /** An exact actor snowflake, from a Discord user option — never typed free-hand. */
  readonly actorId: string | null;
  /** An exact decision layer, or `none` for rows that recorded no decision. */
  readonly layer: LayerFilter | null;
}

/** No narrowing at all. */
export const NO_FILTER: AuditFilter = { action: null, actorId: null, layer: null };

/** True when anything at all was narrowed. */
export function filterIsActive(filter: AuditFilter): boolean {
  return filter.action !== null || filter.actorId !== null || filter.layer !== null;
}

/** One `/admin audit` question. */
export interface AuditQuery {
  /**
   * `null` means every guild — reachable only from a DM, i.e. only by the application owner.
   * IT IS NOT PART OF `filter` ON PURPOSE: an option may narrow WHICH rows you see and must
   * never be able to choose WHOSE they are. See decision (2) in the file header.
   */
  readonly guildId: string | null;
  /** 1-based. Page 1 is the newest rows. */
  readonly page: number;
  readonly pageSize: number;
  readonly filter: AuditFilter;
}

/** Everything `/admin audit` renders. */
export interface AuditPage {
  readonly guildId: string | null;
  /** The rows on THIS page, newest first. */
  readonly rows: readonly AuditRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly filter: AuditFilter;
  /** How many rows the port was asked for. */
  readonly scanRequested: number;
  /** How many it returned. */
  readonly scanReturned: number;
  /**
   * The read hit `MAX_AUDIT_SCAN` and came back full, so rows older than the window were never
   * looked at. THE FLAG THAT KEEPS THE CARD HONEST: without it, "nothing matched" and "nothing
   * matched in the newest 500 decisions" are the same sentence.
   */
  readonly windowFull: boolean;
  /** How many rows in the window matched the filter. */
  readonly matched: number;
  /**
   * `matched` is the WHOLE count for this scope, not a lower bound.
   *
   * THE DISTINCTION IS NOT PEDANTRY. An unfiltered page reads only as far as the page it was
   * asked for, so on a table of ten thousand rows page 1 of 10 reads eleven of them and
   * `matched` is 11 — printing "of 11, page 1 of 2" there would be a made-up total on a card
   * whose entire job is to be trusted. It is true exactly when the port returned FEWER rows than
   * it was asked for, which is the only proof available that the end of the trail was reached.
   */
  readonly matchedIsTotal: boolean;
  /** More matched rows exist after this page, within the window. */
  readonly hasMore: boolean;
  /** When the oldest row in the window was written, so the card can say how far back it saw. */
  readonly oldestScannedAtMs: number | null;
  /** Distinct actions present in the window, so an empty result can say what IS there. */
  readonly presentActions: readonly string[];
}

/** How the service is configured. An object, because two bare numbers are two chances to swap. */
export interface AdminOptions {
  readonly defaultRows: number;
  /** A running attempt at or past this age is reported as wedged rather than working. */
  readonly stuckAfterMs: number;
}

/**
 * How long a job may sit in `running` before it is worth a human's attention.
 *
 * WHY TEN MINUTES. A lease is `JOB_LEASE_MS` (60s) and the runner ticks every 15s, so a healthy
 * attempt either finishes or is reclaimed inside a minute or two; a poller does not hold
 * `running` between ticks, because `retry` puts the row back to `queued`. Ten minutes is
 * therefore an order of magnitude past normal while still inside a Discord interaction's own
 * fifteen. It is config rather than a constant, because "normal" is a property of the jobs an
 * install actually runs.
 */
export const DEFAULT_STUCK_AFTER_MS = 600_000;

/**
 * The read-only operator service.
 *
 * Every method is synchronous because every method is a local read. If one of them ever needs
 * to be `async`, that is the signal that something reached for the network and the answer is no.
 */
export class AdminService {
  private readonly admin: AdminPort;
  private readonly catalog: CatalogPort;
  private readonly defaultRows: number;
  private readonly stuckAfterMs: number;

  constructor(admin: AdminPort, catalog: CatalogPort, opts: AdminOptions) {
    // Fields declared and assigned explicitly: `erasableSyntaxOnly` rejects parameter
    // properties (TS1294).
    this.admin = admin;
    this.catalog = catalog;
    this.defaultRows = clampRows(opts.defaultRows, DEFAULT_AUDIT_ROWS);
    this.stuckAfterMs = clampDuration(opts.stuckAfterMs, DEFAULT_STUCK_AFTER_MS);
  }

  /**
   * "Is anything stuck?" — and, now that the port reports the oldest running attempt, a question
   * this can answer rather than a count with a disclaimer attached.
   *
   * `nowMs` is `inv.at` on the command path and `null` in `health()`, which is called with no
   * time. A `null` there is not a gap: it only means an age expressed as a START INSTANT cannot
   * be resolved, and the age this module asks the port for is a DURATION.
   */
  jobs(nowMs: number | null): JobsSnapshot {
    const stats = this.admin.jobStats();
    const total = stats.queued + stats.running + stats.done + stats.dead + stats.cancelled + stats.orphaned;
    const quarantined: QuarantinedModule[] = [];
    for (const m of this.catalog.modules()) {
      if (m.quarantineReason !== null) quarantined.push({ id: m.id, reason: m.quarantineReason });
    }
    const oldestRunning = readOldestRunning(stats, nowMs);
    const longRunning = oldestRunning !== null && oldestRunning.ageMs >= this.stuckAfterMs;
    return {
      stats,
      total,
      oldestRunning,
      stuckAfterMs: this.stuckAfterMs,
      longRunning,
      needsAttention: stats.dead > 0 || stats.orphaned > 0 || quarantined.length > 0 || longRunning,
      quarantined,
    };
  }

  /**
   * One page of decisions, newest first.
   *
   * `query.guildId` is passed straight through from `inv.space.guildId`. It is NOT an option and
   * must never become one: see decision (2) in the file header.
   *
   * THE READ IS SIZED TO THE QUESTION. Unfiltered, page 2 of 10 needs 21 rows — twenty to skip
   * and print, and one more to learn whether a page 3 exists — so that is what it asks for,
   * which is the cost the un-paged command already had. Filtered, it asks for the whole window,
   * because the port cannot narrow and a match may be anywhere in it.
   */
  audit(query: AuditQuery): AuditPage {
    const pageSize = clampRows(query.pageSize, this.defaultRows);
    const page = clampPage(query.page);
    const filter = query.filter;
    const active = filterIsActive(filter);
    const scanRequested = active ? MAX_AUDIT_SCAN : Math.min(MAX_AUDIT_SCAN, page * pageSize + 1);

    const scanned = this.admin.recentAudit(query.guildId, scanRequested);
    const matches = active ? scanned.filter((row) => matchesFilter(row, filter)) : scanned;
    const start = (page - 1) * pageSize;
    const rows = matches.slice(start, start + pageSize);

    return {
      guildId: query.guildId,
      rows,
      page,
      pageSize,
      filter,
      scanRequested,
      scanReturned: scanned.length,
      windowFull: scanRequested >= MAX_AUDIT_SCAN && scanned.length >= scanRequested,
      matched: matches.length,
      matchedIsTotal: scanned.length < scanRequested,
      hasMore: matches.length > start + rows.length,
      oldestScannedAtMs: scanned.at(-1)?.atMs ?? null,
      presentActions: distinctActions(scanned, MAX_PRESENT_ACTIONS),
    };
  }

  /** The row count to use when the operator gave none. */
  get defaultAuditRows(): number {
    return this.defaultRows;
  }
}

/**
 * Does this row survive the narrowing?
 *
 * Exported because it IS the meaning of the `action`, `actor` and `layer` options, and a prefix
 * rule asserted at its edges is worth more than one demonstrated through a rendered card.
 */
export function matchesFilter(row: AuditRecord, filter: AuditFilter): boolean {
  if (filter.actorId !== null && row.actorId !== filter.actorId) return false;
  // A PREFIX, not equality: `builder` reaches every builder decision, and `builder.approve`
  // reaches both `builder.approve` and `builder.approve_denied` — which is how an investigation
  // actually narrows. `action` is lowercase by the audit adapter's own contract (`ACTION_RE`),
  // and `parseActionFilter` lowercases the needle, so this needs no case folding.
  if (filter.action !== null && !row.action.startsWith(filter.action)) return false;
  if (filter.layer !== null) {
    const want = filter.layer === NO_LAYER_FILTER ? null : filter.layer;
    if (row.decisionLayer !== want) return false;
  }
  return true;
}

/**
 * The oldest running attempt, from whichever shape the port reports it in.
 *
 * TOTAL, AND SILENT ON ABSENCE. Every value here crosses an ownership boundary and was read back
 * out of SQLite by another owner's adapter, so each is re-proven rather than trusted: a missing
 * field, a `null`, a name that is not a string, an age that is not a finite number all produce
 * `null`, and the card then renders the counts alone exactly as it did before. A jobs card
 * printing `NaN` during an incident would be worse than one printing nothing.
 */
export function readOldestRunning(stats: ObservedJobStats, nowMs: number | null): OldestRunningJob | null {
  const running = oldestRunningJob(stats);
  if (running === null) return null;
  // `<moduleId>:<type>` is the runner's key, and the string an operator can match against an
  // `orphaned` count or a log line. It is derived rather than carried so the port has one
  // spelling of the identity and not two that can disagree.
  const name = `${running.moduleId}:${running.type}`;
  // `nowMs` IS DELIBERATELY IGNORED, and the parameter is deliberately kept. The port now
  // reports a duration the adapter computed with its own clock, so there is nothing here left
  // to derive and `health()` — which passes `null` — is no longer a degraded caller. The
  // parameter stays because it is the seam that would be needed again the moment any future
  // field is an instant, and because removing it would churn every call site to prove a point
  // about an argument nobody reads.
  void nowMs;
  return { name, ageMs: Math.max(0, Math.floor(running.ageMs)) };
}

/**
 * Read an action prefix out of a command option.
 *
 * WHY THE SHAPE IS CHECKED AND NOT ONLY THE LENGTH. This is the only option on `/admin` that
 * carries typed text, and the value ends up in a table cell and in the card's own account of
 * what it filtered by. Constraining it to a lowercase dotted verb means the accepted value is
 * drawn from `[a-z0-9_.]`: it cannot close the renderer's code fence, cannot carry a mention or
 * a zero-width character, and cannot be mistaken for prose. The renderer sanitises cells anyway;
 * this makes that the second line of defence rather than the first.
 *
 * WHY `toPlainName` FIRST: rule 3 — `UserText` is converted by a named function from
 * `#core/text`, never read as a string. It normalises, strips mentions and invisibles, collapses
 * to one line and bounds the length; the regex then decides whether what survived is an action.
 */
export function parseActionFilter(text: UserText): Result<string, AppError> {
  const plain = toPlainName(text, { maxLength: ACTION_FILTER_MAX });
  if (!plain.ok) return Err(actionFilterError());
  const candidate = renderPlainName(plain.value).trim().toLowerCase();
  return ACTION_FILTER_RE.test(candidate) ? Ok(candidate) : Err(actionFilterError());
}

/** A trailing dot is legal, because `builder.` is the natural way to ask for one module. */
const ACTION_FILTER_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]*)*$/u;

function actionFilterError(): AppError {
  return errors.validation(
    'action',
    'That is not an action name.',
    'Use a dotted verb or the start of one: builder, builder.approve, credentials.set.',
  );
}

/**
 * Bound a requested row count.
 *
 * WHY IT EXISTS WHEN THE OPTION ALREADY DECLARES `minValue`/`maxValue`: Discord enforces those
 * client-side and the API is not the only caller — `health()` and the previews reach the service
 * directly, and a config file can carry any integer at all. A bound that lives only in the
 * command payload is a bound the next caller does not have.
 */
export function clampRows(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return 1;
  return Math.min(n, MAX_AUDIT_ROWS);
}

/** The same bound for the page number, for the same reason. */
export function clampPage(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const n = Math.floor(value);
  if (n < 1) return 1;
  return Math.min(n, MAX_AUDIT_PAGE);
}

/** And for a duration read out of config, where zero would mean "everything is stuck". */
export function clampDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n < 1 ? fallback : n;
}

/**
 * The distinct actions in a window, so an empty result can say what IS there.
 *
 * WHY IT EARNS ITS LINES: a filter that matches nothing has two causes an operator cannot tell
 * apart — the wrong needle, or the right needle for something that has not happened here.
 * Listing what the window does contain separates them without a second command, and every value
 * in the list is a constant dotted verb the machinery itself wrote.
 */
function distinctActions(rows: readonly AuditRecord[], max: number): readonly string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.action);
    if (seen.size >= max) break;
  }
  return [...seen].sort();
}
