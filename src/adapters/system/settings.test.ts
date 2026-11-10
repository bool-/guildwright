/**
 * Runtime proof for per-guild settings: the cache is a shortcut and never the source of truth,
 * and every default in this file fails CLOSED.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { toGuildId, type GuildId } from '#core/ids';
import { sql } from '#core/sql';
import {
  channelAllowsRequests,
  createSettings,
  readGuildOwnerId,
  readRequestChannels,
  readSelfApprove,
  setGuildOwnerId,
  setRequestChannels,
  setSelfApprove,
  SETTING_KEYS,
  type SettingsStore,
} from '#adapters/system/settings';
import { createTestDb, type TestDb } from '#adapters/system/testdb';
import { manualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';

function guildId(raw = '100000000000000001'): GuildId {
  const r = toGuildId(raw);
  assert.ok(r.ok);
  return r.value;
}

function fixture(): { readonly db: TestDb; readonly settings: SettingsStore } {
  const db = createTestDb();
  const settings = createSettings({ db, clock: manualClock(), logger: silentLogger() });
  return { db, settings };
}

test('a setting round-trips, and an unset key is undefined rather than a default nobody chose', () => {
  const { settings } = fixture();
  const g = guildId();
  assert.equal(settings.get(g, 'anything'), undefined);
  settings.set(g, 'builder.limits', { perUserPerHour: 3 });
  assert.deepEqual(settings.get(g, 'builder.limits'), { perUserPerHour: 3 });
  assert.deepEqual(settings.all(g), { 'builder.limits': { perUserPerHour: 3 } });
});

test('reads are cached, so an authorization check does not hit SQLite on every interaction', () => {
  const { db, settings } = fixture();
  const g = guildId();
  settings.set(g, 'k', { v: 1 });
  db.clearStatements();

  settings.get(g, 'k');
  const afterFirst = db.statements.length;
  assert.equal(afterFirst, 1, 'the first read loads the guild');
  for (let i = 0; i < 20; i += 1) settings.get(g, 'k');
  assert.equal(db.statements.length, afterFirst, 'and the next twenty read nothing');
});

test('a write invalidates the cache rather than updating it, so the table stays the truth', () => {
  const { db, settings } = fixture();
  const g = guildId();
  settings.set(g, 'k', { v: 1 });
  assert.deepEqual(settings.get(g, 'k'), { v: 1 });

  settings.set(g, 'k', { v: 2 });
  db.clearStatements();
  assert.deepEqual(settings.get(g, 'k'), { v: 2 });
  assert.equal(db.statements.length, 1, 'the read went back to the table');

  // And a second process writing the same row is picked up by an explicit invalidation - the
  // lever that exists precisely because the cache is not authoritative.
  db.execute(sql`UPDATE ${db.table('settings')} SET value_json = '{"v":3}' WHERE guild_id = ${g} AND key = 'k'`);
  assert.deepEqual(settings.get(g, 'k'), { v: 2 }, 'still the cached value, honestly');
  settings.invalidate(g);
  assert.deepEqual(settings.get(g, 'k'), { v: 3 });
});

test('settings are per guild, and clearing one key leaves the rest', () => {
  const { settings } = fixture();
  const a = guildId('100000000000000001');
  const b = guildId('100000000000000002');
  settings.set(a, 'k', { v: 'a' });
  settings.set(b, 'k', { v: 'b' });
  assert.deepEqual(settings.get(a, 'k'), { v: 'a' });
  assert.deepEqual(settings.get(b, 'k'), { v: 'b' });

  settings.set(a, 'other', { v: 1 });
  assert.equal(settings.clear(a, 'k'), true);
  assert.equal(settings.clear(a, 'k'), false);
  assert.equal(settings.get(a, 'k'), undefined);
  assert.deepEqual(settings.get(a, 'other'), { v: 1 });
  assert.deepEqual(settings.get(b, 'k'), { v: 'b' });
});

test('a settings row written by an older deploy reads as unset, never as a half-applied policy', () => {
  const { db, settings } = fixture();
  const g = guildId();
  db.execute(
    sql`INSERT INTO ${db.table('settings')} (guild_id, key, value_json, updated_at_ms) VALUES (${g}, 'broken', 'not json', 0)`,
  );
  assert.equal(settings.get(g, 'broken'), undefined);
});

// ---------------------------------------------------------------------------------------
// The typed settings, and their defaults
// ---------------------------------------------------------------------------------------

test('self-approval defaults to FALSE and only a written true turns it on', () => {
  const { settings } = fixture();
  const g = guildId();
  assert.equal(readSelfApprove(settings, g), false);
  // A junk value must not read as "on": this flag is the separation-of-duty switch.
  settings.set(g, SETTING_KEYS.selfApprove, { allowed: 'yes' });
  assert.equal(readSelfApprove(settings, g), false);
  setSelfApprove(settings, g, true);
  assert.equal(readSelfApprove(settings, g), true);
});

test('the $request channel list fails closed until an admin configures it', () => {
  const { settings } = fixture();
  const g = guildId();
  const channel = '400000000000000001';
  assert.deepEqual(readRequestChannels(settings, g), { configured: false, channelIds: [] });
  assert.equal(channelAllowsRequests(settings, g, channel), false, 'unconfigured means nowhere, not everywhere');

  setRequestChannels(settings, g, [channel]);
  assert.equal(channelAllowsRequests(settings, g, channel), true);
  assert.equal(channelAllowsRequests(settings, g, '400000000000000002'), false);

  // Explicitly emptied is still "configured", and still denies.
  setRequestChannels(settings, g, []);
  assert.deepEqual(readRequestChannels(settings, g), { configured: true, channelIds: [] });
  assert.equal(channelAllowsRequests(settings, g, channel), false);
});

test('a non-snowflake in the channel list is dropped rather than trusted', () => {
  const { settings } = fixture();
  const g = guildId();
  settings.set(g, SETTING_KEYS.requestChannels, { channelIds: ['400000000000000001', 'everything', 42] });
  assert.deepEqual(readRequestChannels(settings, g), { configured: true, channelIds: ['400000000000000001'] });
});

test('the guild owner is null until the Discord adapter records it', () => {
  const { settings } = fixture();
  const g = guildId();
  assert.equal(readGuildOwnerId(settings, g), null);
  setGuildOwnerId(settings, g, '200000000000000009');
  assert.equal(readGuildOwnerId(settings, g), '200000000000000009');
  settings.set(g, SETTING_KEYS.guildOwner, { userId: 'not-a-snowflake' });
  assert.equal(readGuildOwnerId(settings, g), null);
});
