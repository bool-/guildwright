/**
 * HOW LONG THE BUILD JOB WAITS BEFORE ITS NEXT ATTEMPT.
 *
 * `mapGithubError` reads `retry-after` and `x-ratelimit-reset` off a 429 or a rate-limited 403,
 * bounds the result to fifteen minutes, and puts it on `RateLimitedError.retryAfterMs`. Every
 * retry arm in the build job then threw that away and slept `pollIntervalMs` — fifteen seconds.
 *
 * WHAT THAT COSTS, and why it is worth a file of its own: a build job may retry for up to six
 * hours. Re-polling a throttled API every fifteen seconds for hours does not merely fail to help
 * — each rejected call is itself counted against the limit, so the bot holds its own rate limit
 * open, and secondary-limit abuse detection is what GitHub answers next. The number that fixes it
 * was already sitting in the error object the code was holding.
 *
 * TWO CHECKS, because there are two ways to lose this:
 *   1. `retryDelayMs` stops taking the maximum → the unit tests below fail.
 *   2. A call site goes back to a bare `cfg.pollIntervalMs` → the source check below fails.
 * Neither alone is sufficient, and neither is redundant.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { retryDelayMs } from '#modules/builder/module';
import { errors } from '#core/errors';

const POLL_MS = 15_000;

test('a rate limit is waited out, not re-polled every 15 seconds', () => {
  const limited = errors.rateLimited('github', 900_000, 'It resumes on its own.');
  assert.equal(
    retryDelayMs(limited, POLL_MS),
    900_000,
    'GitHub said fifteen minutes; polling it sixty times in that window is what triggers abuse detection',
  );
});

test('GitHub’s wait is a FLOOR, never a schedule', () => {
  // A short `retry-after` must not turn a 15s poll into a 2s hot loop. Whichever is longer wins,
  // in both directions — which is the whole reason this is `Math.max` and not an assignment.
  const brief = errors.rateLimited('github', 2_000, 'It resumes on its own.');
  assert.equal(retryDelayMs(brief, POLL_MS), POLL_MS);
});

test('an error carrying no wait keeps the configured interval', () => {
  // `retryAfterMs` lives only on the rate-limited variant. Every other failure — a 500, a socket
  // reset, a shape error — has nothing to say about timing, and inventing a longer wait for those
  // would slow down the ordinary "GitHub blipped" case for no reason.
  for (const error of [
    errors.upstream('github', 500, 'Try again in a minute.'),
    errors.upstream('github', 0, 'Try again in a minute.'),
    errors.timeout('github', 1_000, 'Try again.'),
  ]) {
    assert.equal(retryDelayMs(error, POLL_MS), POLL_MS, `${error.code} must not change the cadence`);
  }
});

test('every retry arm holding a failed result consults that result', () => {
  // THE STRUCTURAL HALF. `retryDelayMs` being correct is worth nothing if a call site does not
  // call it, and the defect was exactly that: five arms, all holding an error, all writing the
  // same plausible-looking `afterMs: cfg.pollIntervalMs`.
  //
  // Asserted textually, in the same spirit as `contract.test.ts` and the
  // `no-await-in-form-handler` check — a type cannot express "you are holding an error you did
  // not read". Comments are stripped first, for the reason `conventions.test.ts` gives: this
  // file's own prose quotes the bad pattern, and a check that fires on its explanation is a check
  // that gets suppressed.
  const code = readFileSync('src/modules/builder/module.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1 ');

  // ENUMERATION, not proximity. A positional regex ("a retry literal within N characters of a
  // failed guard") reads across into the NEXT arm and reports a false positive, and loosening it
  // until it stops doing that is how a rule ends up matching nothing. So instead: list every arm
  // that still passes a bare interval, by its own `why` string, and pin that list exactly.
  //
  // `used` JOINED THE LIST when the daily run cap arrived: reading how many agent runs have
  // started today is one more GitHub call, and a 429 on it is exactly the case `retryAfterMs`
  // exists for - re-asking every fifteen seconds while GitHub is throttling us is how the bot
  // holds its own rate limit open.
  //
  // These seven, and only these seven, hold no error to consult — they are the "the request went
  // fine, come back later" arms. Every OTHER arm is holding a failed `Result`, and converting one
  // back to a bare interval adds a name to this list and fails here.
  //
  // `adopted the earlier run ...` JOINED THE LIST with the single-use approval token: when the
  // repository refuses the bot's own re-dispatch as a replay, the bot switches the row to the
  // earlier run it found and simply polls again. Nothing failed; there is no error to consult.
  const bare = [...code.matchAll(/\{\s*kind:\s*'retry',\s*afterMs:\s*cfg\.pollIntervalMs,\s*why:\s*'([^']+)'/gu)].map(
    (m) => m[1] ?? '?',
  );

  assert.deepEqual(
    bare.sort(),
    [
      'PR not open yet',
      'adopted the earlier run of this approval; polling',
      'dispatched blind; correlating',
      'dispatched; polling',
      'still building',
      'unknown ending',
      'unknown status',
    ],
    'a retry arm is ignoring the retryAfterMs on an AppError it is holding. Use retryAfter(error, cfg.pollIntervalMs, why).',
  );

  // And the counterpart: the five arms that DO hold an error all route through the helper. This
  // is what fails if one is reverted to a literal — the name would appear above and vanish here.
  const routed = [...code.matchAll(/retryAfter\(\s*(\w+)\.error,\s*cfg\.pollIntervalMs/gu)].map((m) => m[1] ?? '?');
  assert.deepEqual(
    routed.sort(),
    ['bodySha', 'earlier', 'gated', 'out', 'payer', 'pr', 'report', 'status', 'used'],
    'every arm holding a failed Result must consult it: gate-file check, daily-cap read, payer, body digest, dispatch, poll, PR lookup, report, replay search',
  );
});
