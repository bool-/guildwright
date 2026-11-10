/**
 * Runtime proof that a credential cannot reach a log line (SC-6).
 *
 * The type system stops the obvious version - `LoggerPort` takes `JsonObject`, and a `Secret`
 * is not one - so these tests cover the two paths the types cannot see: a token-shaped value
 * under a field NAME nobody thought about, and a token inside the MESSAGE itself.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadConfig, secret } from '#core/config';
import { createLogger, memorySink, withCorrelation, CORRELATION_FIELD } from '#adapters/system/logger';
import { manualClock } from '#adapters/system/clock';

const FAKE_GH_TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
const FAKE_BOT_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.abcdefghijklmnopqrstuvwxyz0123456789';

function logger(): { readonly sink: ReturnType<typeof memorySink>; readonly log: ReturnType<typeof createLogger> } {
  const sink = memorySink();
  const log = createLogger({ level: 'debug', clock: manualClock(), destination: sink, base: { service: 'bot' } });
  return { sink, log };
}

// ---------------------------------------------------------------------------------------
// The Secret carrier
// ---------------------------------------------------------------------------------------

test('a Secret never serialises, through any path a logger takes', () => {
  const s = secret(FAKE_GH_TOKEN);
  // pino serialises with JSON.stringify, so this is the hook that actually fires.
  assert.equal(JSON.stringify(s), '"[redacted]"');
  assert.equal(JSON.stringify({ github: { token: s } }), '{"github":{"token":"[redacted]"}}');
  // Template interpolation is the other way it has leaked.
  assert.equal(`${s}`, '[redacted]');
  assert.equal(String(s), '[redacted]');
  assert.equal([s].join(','), '[redacted]');
  // And the one greppable unwrap still works, so the value is not merely destroyed.
  assert.equal(s.reveal(), FAKE_GH_TOKEN);
});

test('a whole AppConfig can be serialised without leaking a single credential', () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: FAKE_BOT_TOKEN,
    DISCORD_CLIENT_ID: '100000000000000001',
    DISCORD_OWNER_ID: '100000000000000002',
    GITHUB_TOKEN: FAKE_GH_TOKEN,
    GITHUB_OWNER: 'octo',
    GITHUB_REPO: 'demo',
    APPROVAL_HMAC_KEY: 'x'.repeat(48),
    NODE_ENV: 'test',
  });
  assert.ok(cfg.ok, 'the fixture env must be valid');
  const dump = JSON.stringify(cfg.value);
  assert.ok(!dump.includes(FAKE_GH_TOKEN));
  assert.ok(!dump.includes(FAKE_BOT_TOKEN));
  assert.ok(!dump.includes('x'.repeat(48)));
  assert.equal(dump.match(/\[redacted\]/gu)?.length, 3, 'all three credentials, all redacted');
});

// ---------------------------------------------------------------------------------------
// The two layers the types cannot see
// ---------------------------------------------------------------------------------------

test('a token-shaped field is redacted by name, at the top level and nested', () => {
  const { sink, log } = logger();
  log.info('dispatching', {
    token: FAKE_GH_TOKEN,
    github: { token: FAKE_GH_TOKEN, owner: 'octo' },
    err: { config: { authorization: `Bearer ${FAKE_GH_TOKEN}` } },
  });
  const line = sink.lines.join('');
  assert.ok(!line.includes(FAKE_GH_TOKEN), 'no layer may let the raw value through');
  assert.ok(line.includes('[redacted]'));
  assert.ok(line.includes('"owner":"octo"'), 'and everything else is still there to debug with');
});

test('a credential in the MESSAGE is scrubbed too - the layer redact paths cannot reach', () => {
  const { sink, log } = logger();
  // The real shape of this incident: an upstream error string interpolated into a message.
  log.error(`github refused the request: token ${FAKE_GH_TOKEN} is invalid`);
  log.warn(`authorization: Bearer ${FAKE_GH_TOKEN}`);
  const line = sink.lines.join('');
  assert.ok(!line.includes(FAKE_GH_TOKEN));
  assert.equal(sink.lines.length, 2);
  for (const record of sink.records()) {
    assert.ok(String(record['msg']).includes('[redacted]'));
  }
});

test('an unlisted field name is still caught by the output scrub', () => {
  const { sink, log } = logger();
  // `credential_we_forgot` is in no redact path anywhere. Layer 3 is why that is survivable.
  log.info('boot', { credential_we_forgot: FAKE_GH_TOKEN });
  assert.ok(!sink.lines.join('').includes(FAKE_GH_TOKEN));
});

// ---------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------

test('every line is NDJSON with the level, the time and the base bindings', () => {
  const { sink, log } = logger();
  log.info('hello', { requestId: '01JABCDE' });
  assert.equal(sink.lines.length, 1);
  assert.ok(sink.lines[0]?.endsWith('\n'), 'newline delimited');
  const record = sink.records()[0];
  assert.ok(record !== undefined);
  assert.equal(record['msg'], 'hello');
  assert.equal(record['service'], 'bot');
  assert.equal(record['requestId'], '01JABCDE');
  // The injected clock is what makes this assertable at all.
  assert.equal(record['time'], 1_700_000_000_000);
  assert.equal(record['level'], 30);
});

test('a correlation id is inherited by every child, so one request greps as one story', () => {
  const { sink, log } = logger();
  const request = withCorrelation(log, '01JREQUEST');
  request.info('hook fired');
  request.child({ jobId: '01JJOB' }).info('job started');
  const records = sink.records();
  assert.equal(records.length, 2);
  for (const r of records) assert.equal(r[CORRELATION_FIELD], '01JREQUEST');
  assert.equal(records[1]?.['jobId'], '01JJOB');
});

test('the level gate is real, so debug logging costs nothing in production', () => {
  const sink = memorySink();
  const log = createLogger({ level: 'warn', clock: manualClock(), destination: sink });
  log.debug('noise');
  log.info('noise');
  log.warn('kept');
  log.error('kept');
  assert.equal(sink.lines.length, 2);
});
