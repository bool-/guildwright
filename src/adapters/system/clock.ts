/**
 * The clock adapter - the ONLY place in the runtime that reads ambient time.
 *
 * WHY it is a port at all: `Date.now()` inside a module makes the builder state machine
 * untestable without real time passing, and `setTimeout` inside a module is an in-memory
 * promise that a restart silently drops - the exact reason builds "disappeared" across a
 * deploy. The lint rule `no-ambient-clock` bans both under `src/modules/**`; this file is
 * where the ban is discharged.
 *
 * NOTE THE ABSENCE OF `sleep`, which `ClockPort` also refuses: waiting is a `JobContext`
 * capability, because a 30-minute wait inside an interaction handler answers a token that
 * died at 15 minutes.
 */

import type { ClockPort } from '#core/ports';

/**
 * Real time.
 *
 * WHY `monotonicNs` is `process.hrtime.bigint()` and not `Date.now() * 1e6`: an NTP step (or
 * a VM's clock jumping backwards on resume) makes a wall-clock duration negative, and a
 * negative duration in a backoff computation is how a poller turns into a hot loop.
 */
export function systemClock(): ClockPort {
  return {
    now: () => Date.now(),
    monotonicNs: () => process.hrtime.bigint(),
  };
}

/**
 * A deterministic clock for tests and for `npm run dev:offline`.
 *
 * WHY it ships here rather than only in `#testing/fakes`: the fake there can `set` but not
 * `advance`, and every job-runner test is written as "advance past the backoff, tick again".
 * Expressing that as absolute timestamps is how an off-by-one in a backoff test gets written
 * to match the bug.
 */
export interface ManualClock extends ClockPort {
  /** Jump to an absolute wall-clock time. May go backwards; `monotonicNs` will not. */
  set(ms: number): void;
  /** Move forward by `ms` and return the new time. Negative deltas are refused. */
  advance(ms: number): number;
}

/** The default start: a fixed, obviously-not-now instant, so a snapshot cannot pass by luck. */
export const MANUAL_CLOCK_EPOCH = 1_700_000_000_000;

export function manualClock(startMs: number = MANUAL_CLOCK_EPOCH): ManualClock {
  let wall = startMs;
  // Tracked separately so `set(earlier)` cannot make a duration negative - the one property
  // `monotonicNs` exists to guarantee.
  let monoMs = startMs;
  return {
    now: () => wall,
    monotonicNs: () => BigInt(Math.round(monoMs)) * 1_000_000n,
    set(ms: number): void {
      if (!Number.isFinite(ms)) throw new RangeError('manualClock.set: ms must be finite');
      monoMs += Math.max(0, ms - wall);
      wall = ms;
    },
    advance(ms: number): number {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('manualClock.advance: ms must be >= 0');
      wall += ms;
      monoMs += ms;
      return wall;
    },
  };
}
