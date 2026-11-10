/**
 * Runtime proof for `ids.ts`, run by `node --test` under Node's own type stripping.
 *
 * These are the invariants the compiler cannot state: monotonic ordering inside one
 * millisecond, the 100-character `custom_id` budget against a real ULID, and the round trip
 * through `decodeActionRef` that every restored button depends on.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  actionRefFits,
  CUSTOM_ID_MAX,
  decodeActionRef,
  encodeActionRef,
  newApprovalId,
  newCardNonce,
  newFenceNonce,
  newRequestId,
  toCardNonce,
  toRequestId,
} from '#core/ids';

test('newRequestId is a 26-char Crockford ULID', () => {
  const id = newRequestId(1_700_000_000_000);
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.ok(toRequestId(id).ok);
});

test('newRequestId is strictly increasing inside one millisecond', () => {
  const at = 1_700_000_000_123;
  const ids = [newRequestId(at), newRequestId(at), newRequestId(at), newRequestId(at)];
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'ids minted in the same ms must sort in creation order');
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

test('newRequestId orders across milliseconds', () => {
  const a = newRequestId(1_700_000_000_000);
  const b = newRequestId(1_700_000_001_000);
  assert.ok(a < b);
});

test('newRequestId refuses a time outside the ULID range', () => {
  assert.throws(() => newRequestId(-1));
  assert.throws(() => newRequestId(Number.POSITIVE_INFINITY));
});

test('approval ids are UUIDs the workflow regex accepts', () => {
  const id = newApprovalId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test('fence nonces are 16 hex characters and unguessable', () => {
  const a = newFenceNonce();
  const b = newFenceNonce();
  assert.match(a, /^[0-9a-f]{16}$/u);
  assert.notEqual(a, b);
});

test('a realistic custom_id fits, and round-trips', () => {
  const nonce = newCardNonce();
  const entityId = newRequestId(1_700_000_000_000);
  const encoded = encodeActionRef({ moduleId: 'builder', action: 'approve', entityId, nonce });
  assert.ok(encoded.ok, 'a realistic ref must encode');
  if (!encoded.ok) return;
  assert.ok(encoded.value.length <= CUSTOM_ID_MAX, `${encoded.value.length} <= ${CUSTOM_ID_MAX}`);

  const decoded = decodeActionRef(encoded.value);
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.equal(decoded.value.moduleId, 'builder');
  assert.equal(decoded.value.action, 'approve');
  assert.equal(decoded.value.entityId, entityId);
  assert.equal(decoded.value.nonce, nonce);
});

test('the boot preflight refuses a name that could not fit a live card', () => {
  assert.equal(actionRefFits('builder', 'approve'), true);
  // 31-char module id + 38-char action name is what one earlier design booted happily and
  // then failed on at render time, in front of a user.
  assert.equal(actionRefFits('a'.repeat(31), 'approve-this-request-right-now-please-x'), false);
});

test('encodeActionRef refuses an over-long id rather than letting discord.js throw', () => {
  const nonce = newCardNonce();
  // 31 + 39 + 26 + 8 + 2 version chars + 4 separators = 110 > 100.
  const r = encodeActionRef({
    moduleId: 'a'.repeat(31),
    action: 'approve-this-request-right-now-please-x',
    entityId: newRequestId(1_700_000_000_000),
    nonce,
  });
  assert.equal(r.ok, false, 'the total budget must be enforced');

  // And a single segment longer than the codec allows is refused before length arithmetic.
  const seg = encodeActionRef({
    moduleId: 'builder',
    action: 'x'.repeat(41),
    entityId: newRequestId(1_700_000_000_001),
    nonce,
  });
  assert.equal(seg.ok, false, 'a 41-character segment must be refused');
});

test('decodeActionRef rejects a foreign or older custom_id cleanly', () => {
  for (const bad of ['', 'garbage', 'a1~builder~approve', 'a0~builder~approve~X~Y', 'a1~b~a~e~notanonce']) {
    const r = decodeActionRef(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not decode`);
  }
});

test('a nonce from a superseded card does not equal a fresh one', () => {
  const stored = newCardNonce();
  const fresh = newCardNonce();
  assert.notEqual(stored, fresh);
  assert.ok(toCardNonce(stored).ok);
  assert.equal(toCardNonce('nope').ok, false);
});
