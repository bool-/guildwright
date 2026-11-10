/**
 * Runtime proof that the audit log is append-only, attributable, and not a place a secret can
 * hide.
 *
 * The type wall (`detail: JsonObject`, so a `UserText` / `Secret` / `ProgressHandle` is
 * TS2322 at the call site) is asserted by the compiler on every build. What is left for a test
 * is the runtime half: that this adapter issues no UPDATE and no DELETE, that the module id
 * cannot be spoofed, and that a credential inside an otherwise-legal `JsonObject` is scrubbed.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAuditLog, serialiseDetail, MAX_DETAIL_BYTES } from '#adapters/system/audit';
import { createTestDb, type TestDb } from '#adapters/system/testdb';
import { manualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';

const FAKE_GH_TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';

function fixture(): { readonly db: TestDb; readonly audit: ReturnType<typeof createAuditLog> } {
  const db = createTestDb();
  const audit = createAuditLog({ db, clock: manualClock(), logger: silentLogger() });
  return { db, audit };
}

test('an audit row records who, where, which layer decided, and which module asked', () => {
  const { audit } = fixture();
  audit.portFor('builder').record({
    action: 'builder.approve',
    actorId: '200000000000000001',
    guildId: '100000000000000001',
    detail: { requestId: '01JABC', issueNumber: 42 },
    decisionLayer: 'L1-allowlist',
  });

  const rows = audit.recent(10);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.moduleId, 'builder');
  assert.equal(row.action, 'builder.approve');
  assert.equal(row.actorId, '200000000000000001');
  assert.equal(row.guildId, '100000000000000001');
  assert.equal(row.decisionLayer, 'L1-allowlist', 'this is what makes "who let this through?" answerable');
  assert.deepEqual(row.detail, { requestId: '01JABC', issueNumber: 42 });
  assert.equal(row.atMs, 1_700_000_000_000);
});

test('the audit port issues INSERTs and SELECTs and nothing else', () => {
  const { db, audit } = fixture();
  const port = audit.portFor('tags');
  db.clearStatements();
  port.record({ action: 'tags.set', actorId: '200000000000000001', guildId: null, detail: {} });
  port.record({ action: 'tags.delete', actorId: '200000000000000001', guildId: null, detail: {} });
  audit.recent(5);
  assert.ok(db.statements.length >= 3);
  for (const statement of db.statements) {
    const verb = statement.trim().slice(0, 6).toUpperCase();
    assert.ok(verb === 'INSERT' || verb === 'SELECT', `append-only, but saw: ${statement.trim().slice(0, 40)}`);
  }
});

test('the module id comes from the wiring, so a module cannot file a row as another one', () => {
  const { audit } = fixture();
  audit.portFor('tags').record({ action: 'builder.approve', actorId: '1', guildId: null, detail: {} });
  const row = audit.recent(1)[0];
  assert.ok(row !== undefined);
  // The action is whatever the caller passed; `module_id` is not, and that is the attribution
  // an investigation actually runs on.
  assert.equal(row.moduleId, 'tags');
});

test('a credential inside a legal JsonObject detail is scrubbed before it is stored', () => {
  const { audit } = fixture();
  audit.portFor('builder').record({
    action: 'builder.dispatch',
    actorId: '200000000000000001',
    guildId: null,
    // Every value here is a legal `JsonValue`, so no type stops this. The adapter does.
    detail: { upstreamBody: `remote: token ${FAKE_GH_TOKEN} rejected`, nested: { authorization: `Bearer ${FAKE_GH_TOKEN}` } },
  });
  const row = audit.recent(1)[0];
  assert.ok(row !== undefined);
  const dump = JSON.stringify(row.detail);
  assert.ok(!dump.includes(FAKE_GH_TOKEN));
  assert.ok(dump.includes('[redacted]'));
});

test('an oversized detail is replaced rather than stored, so the table stays queryable', () => {
  const detail = { blob: 'a'.repeat(MAX_DETAIL_BYTES * 2) };
  const stored = serialiseDetail(detail);
  assert.ok(stored.length < MAX_DETAIL_BYTES);
  assert.ok(stored.includes('exceeded the audit size cap'));
});

test('an action name built from a variable is refused instead of becoming a free-text column', () => {
  const { audit } = fixture();
  audit.portFor('builder').record({ action: 'Approve build for @everyone <@123>', actorId: '1', guildId: null, detail: {} });
  const row = audit.recent(1)[0];
  assert.ok(row !== undefined);
  assert.equal(row.action, 'builder.invalid_action', 'the row still exists; the free text does not');
});

test('record() never throws, even when the database is gone', () => {
  const { db, audit } = fixture();
  const port = audit.portFor('builder');
  db.close();
  // An audit write that could fail a handler is an audit write somebody wraps in a try/catch
  // and then forgets. The failure goes to the operator log instead.
  assert.doesNotThrow(() => {
    port.record({ action: 'builder.approve', actorId: '1', guildId: null, detail: {} });
  });
});

test('rows can be read back per guild, newest first', () => {
  const { audit } = fixture();
  const port = audit.portFor('builder');
  port.record({ action: 'builder.request', actorId: '1', guildId: '100000000000000001', detail: { n: 1 } });
  port.record({ action: 'builder.request', actorId: '1', guildId: '100000000000000002', detail: { n: 2 } });
  port.record({ action: 'builder.approve', actorId: '1', guildId: '100000000000000001', detail: { n: 3 } });

  const forGuild = audit.forGuild('100000000000000001', 10);
  assert.equal(forGuild.length, 2);
  assert.equal(forGuild[0]?.action, 'builder.approve', 'newest first');
  assert.deepEqual(forGuild.map((r) => r.detail['n']), [3, 1]);
});
