/**
 * Declared rate limits (SC-9).
 *
 * POSTMORTEM THIS FILE CLOSES: "one user held the Approve button down and we dispatched
 * eleven workflow runs, each burning credits, before anyone noticed."
 *
 * WHY `limit` is a LIST and not a single bucket: SC-9 specifies `$request` as
 * "3/user/hour + 20/guild/day". A single `RateLimit` field cannot express that, so the
 * previous designs silently dropped the per-guild daily cap and one guild with thirty users
 * could file ninety build requests an hour. The router spends every bucket atomically in one
 * transaction and reports WHICH one was exhausted.
 *
 * WHY declared and not applied: the router applies them before the handler runs, so a module
 * author cannot forget the call, and `/status` lists every bucket in the bot from the registry
 * alone.
 */

/** Who the bucket is keyed by. `global` is the whole bot - use it for anything that spends. */
export type LimitScope = 'user' | 'guild' | 'channel' | 'global';

/** A token-bucket declaration. Applied centrally by the router, never by a handler. */
export interface RateLimit {
  readonly scope: LimitScope;
  /** Tokens per window. */
  readonly count: number;
  /** Window length in milliseconds. */
  readonly perMs: number;
}

/**
 * The explicit opt-out.
 * WHY a named empty list rather than an omittable field: `NO_LIMIT` greps and reads as a
 * decision. `limit: []` is legal too, but the scaffolder writes `NO_LIMIT`.
 */
export const NO_LIMIT: readonly RateLimit[] = [];

/** Constructors. Named scopes read better in review than a bare object literal. */
export const limit = {
  /** Per invoking user. The default choice for anything a human triggers. */
  perUser(count: number, perMs: number): RateLimit {
    return { scope: 'user', count, perMs };
  },
  /** Per guild. Pair it with `perUser` for anything that costs money - see SC-9. */
  perGuild(count: number, perMs: number): RateLimit {
    return { scope: 'guild', count, perMs };
  },
  /** Per channel. Mostly for message-prefix hooks like `$request`. */
  perChannel(count: number, perMs: number): RateLimit {
    return { scope: 'channel', count, perMs };
  },
  /** Whole-bot ceiling. The last line before a surprise invoice. */
  global(count: number, perMs: number): RateLimit {
    return { scope: 'global', count, perMs };
  },
};

/** WHY the key shape is here: it must match `core_ratelimit.bucket` exactly, in one place. */
export function bucketKey(moduleId: string, name: string, l: RateLimit, subjectId: string): string {
  return `${moduleId}:${name}:${l.scope}:${l.scope === 'global' ? '-' : subjectId}`;
}
