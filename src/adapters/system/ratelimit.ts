/**
 * THE REAL RATE GATE.
 *
 * Every `limit.perUser(...)` / `limit.perGuild(...)` in every module was decorative until this
 * existed: the composition root wired `ALLOW_ALL`, whose `spend()` unconditionally succeeds. So
 * the declarations typechecked, read convincingly in review, and enforced nothing. A single user
 * could file unlimited issues, and — with an approver clicking — spend unbounded Actions minutes
 * and Anthropic tokens. SC-9 says rate limits are enforced BEFORE any spend; they were not
 * enforced at all.
 *
 * DESIGN, and why each choice:
 *
 *  - FIXED WINDOWS, not a sliding log. A sliding window needs a row per event; a fixed window
 *    needs one row per (bucket, window) and a modulo. At Discord scale the extra precision buys
 *    nothing, and the worst case — 2N requests across a window boundary — is acceptable for a
 *    limit whose job is to stop abuse, not to meter billing.
 *
 *  - PERSISTED, not in memory. An in-memory counter resets on every restart, so "3 builds per
 *    hour" becomes unlimited for anyone who can make the bot restart. The job queue and the
 *    approval state are already durable; the thing that bounds spend should not be the exception.
 *
 *  - ALL-OR-NOTHING inside one transaction. A command declaring both a per-user and a per-guild
 *    limit must not consume the user's token and then fail on the guild's, or a user who is
 *    rate-limited at the guild level would still burn their own quota and be punished twice.
 *
 *  - The window key is derived, never stored as a timestamp to compare. `floor(at / perMs)`
 *    means expiry needs no sweeper: an old window's row is simply never read again. `prune()`
 *    exists to keep the table small, and is a convenience, not a correctness requirement.
 */

import { Err, Ok, type Result } from '#core/result';
import { describeWait, errors, type AppError } from '#core/errors';
import type { RateLimit } from '#core/ratelimit';
import type { DbPort } from '#core/ports/db';
import { sql } from '#core/ports/db';
import type { RateGate, RateGateRequest } from '#adapters/discord/router';

/** Rows older than this many windows are eligible for pruning. */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RateGateDeps {
  /** A CORE-scoped DbPort — the table is `core_ratelimits`, not a module's. */
  readonly db: DbPort;
}

export interface PersistentRateGate extends RateGate {
  /** Delete windows that can no longer be read. Safe to call at any time. */
  prune(olderThanMs: number): number;
}

/**
 * The bucket key for one declared limit.
 *
 * Includes the module and entry-point name, so two commands declaring "3 per hour" get their own
 * budgets rather than silently sharing one. A `global` bucket deliberately has no subject.
 */
export function bucketKey(req: RateGateRequest, limit: RateLimit): string {
  const subject =
    limit.scope === 'user' ? req.userId
    : limit.scope === 'guild' ? (req.guildId ?? 'dm')
    : limit.scope === 'channel' ? req.channelId
    : 'all';
  return `${req.moduleId}:${req.name}:${limit.scope}:${subject}`;
}

/** Fixed-window index. Two requests share a window iff this matches. */
export function windowIndex(at: number, perMs: number): number {
  return Math.floor(at / Math.max(1, perMs));
}

/** Human-facing wait, rounded up so "0 seconds" is never shown. */
export function retryAfterMs(at: number, perMs: number): number {
  const span = Math.max(1, perMs);
  return span - (at % span);
}

export function createRateGate(deps: RateGateDeps): PersistentRateGate {
  const t = deps.db.table('ratelimits');

  return {
    spend(req: RateGateRequest): Result<void, AppError> {
      if (req.limits.length === 0) return Ok(undefined);

      // One transaction for every bucket: either they all admit the request or none is charged.
      // Without this, a request rejected by the guild bucket would still have spent the user's.
      try {
        return deps.db.transaction((): Result<void, AppError> => {
          for (const limit of req.limits) {
            const key = bucketKey(req, limit);
            const window = windowIndex(req.at, limit.perMs);

            // Upsert-then-read, so a brand-new bucket and an existing one take the same path.
            deps.db.execute(sql`
              INSERT INTO ${t} (bucket, window_index, used, updated_at)
              VALUES (${key}, ${window}, 1, ${req.at})
              ON CONFLICT (bucket, window_index)
              DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`);

            const row = deps.db.queryOne<{ used: number }>(
              sql`SELECT used FROM ${t} WHERE bucket = ${key} AND window_index = ${window}`,
            );
            const used = row?.used ?? 1;

            if (used > limit.count) {
              // Throwing unwinds the transaction, so the increments above are rolled back and a
              // rejected caller is not charged for the attempt.
              throw new RateLimited(limit, retryAfterMs(req.at, limit.perMs));
            }
          }
          return Ok(undefined);
        });
      } catch (cause: unknown) {
        if (cause instanceof RateLimited) {
          return Err(
            errors.rateLimited(
              `${cause.limit.scope}:${cause.limit.count}/${cause.limit.perMs}ms`,
              cause.retryAfterMs,
              `Try again in ${describeWait(cause.retryAfterMs)}.`,
              `Limit is ${cause.limit.count} per ${describeWait(cause.limit.perMs)} per ${cause.limit.scope === 'global' ? 'bot' : cause.limit.scope}.`,
            ),
          );
        }
        throw cause;
      }
    },

    prune(olderThanMs: number): number {
      // A window is unreachable once its index can never be produced again. Comparing on
      // updated_at is simpler and equivalent for any sane window length.
      return deps.db.execute(sql`DELETE FROM ${t} WHERE updated_at < ${olderThanMs}`).changes;
    },
  };
}

/** Internal control-flow signal; never escapes `spend`. */
class RateLimited extends Error {
  readonly limit: RateLimit;
  readonly retryAfterMs: number;

  constructor(limit: RateLimit, retryAfterMs: number) {
    super('rate limited');
    this.name = 'RateLimited';
    this.limit = limit;
    this.retryAfterMs = retryAfterMs;
  }
}
