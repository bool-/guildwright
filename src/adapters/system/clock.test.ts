/**
 * Runtime proof for the clock.
 *
 * The interesting property is the one that only shows up during an incident: `monotonicNs`
 * must not go backwards when the wall clock does. An NTP step, or a VM resuming from a
 * snapshot, is how a duration goes negative - and a negative duration inside a backoff turns a
 * poller into a hot loop against a rate-limited API.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { manualClock, systemClock, MANUAL_CLOCK_EPOCH } from '#adapters/system/clock';

test('the system clock reports wall time and a monotonic counter that only moves forward', () => {
  const clock = systemClock();
  const before = Date.now();
  const now = clock.now();
  assert.ok(now >= before && now <= Date.now());

  const a = clock.monotonicNs();
  const b = clock.monotonicNs();
  assert.equal(typeof a, 'bigint');
  assert.ok(b >= a, 'monotonic time never goes backwards');
});

test('the manual clock advances only when a test says so', () => {
  const clock = manualClock();
  assert.equal(clock.now(), MANUAL_CLOCK_EPOCH);
  assert.equal(clock.now(), MANUAL_CLOCK_EPOCH, 'reading it does not move it');
  assert.equal(clock.advance(15_000), MANUAL_CLOCK_EPOCH + 15_000);
  assert.equal(clock.now(), MANUAL_CLOCK_EPOCH + 15_000);
  assert.throws(() => clock.advance(-1), RangeError, 'time only moves one way');
});

test('a wall clock that jumps backwards does not drag the monotonic clock with it', () => {
  const clock = manualClock();
  clock.advance(60_000);
  const beforeStep = clock.monotonicNs();

  // The NTP step: wall time is corrected backwards by a minute.
  clock.set(MANUAL_CLOCK_EPOCH);
  assert.equal(clock.now(), MANUAL_CLOCK_EPOCH, 'wall time really did move back');
  assert.ok(clock.monotonicNs() >= beforeStep, 'and the monotonic clock did not');

  clock.advance(1_000);
  assert.ok(clock.monotonicNs() > beforeStep);
});

test('nanoseconds are a bigint, so a duration above 2^53 is not silently rounded', () => {
  const clock = manualClock();
  const start = clock.monotonicNs();
  clock.advance(1);
  assert.equal(clock.monotonicNs() - start, 1_000_000n);
});
