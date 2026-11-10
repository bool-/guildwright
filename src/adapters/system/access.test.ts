/**
 * Runtime proof for the authorization layers.
 *
 * Two of these tests are the reason this repo has its own access port at all:
 *  - "asking is not approving": a grant of `builder.request` must not confer `builder.approve`;
 *  - the DM bypass: a `guild-admin` fallback evaluated in a DM must DENY. That is the live
 *    `@sapphire/framework` finding this design rejected the dependency over, and it is one
 *    `return true` away from being reintroduced by anyone refactoring this file.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { toGuildId, toRoleId, toUserId, type GuildId, type RoleId, type UserId } from '#core/ids';
import { PERMISSION_BITS } from '#core/permissions';
import { permissionRef, PUBLIC, type Fallback } from '#core/policy';
import type { AccessSubjectSnapshot } from '#core/ports';
import { createAccess, type AccessControl, type FallbackResolver } from '#adapters/system/access';
import { createSettings, setGuildOwnerId, setSelfApprove, type SettingsStore } from '#adapters/system/settings';
import { createTestDb } from '#adapters/system/testdb';
import { manualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';

// Separate keys with separate allow-lists: this IS the separation of duty (SC-7 item 8).
const REQUEST = permissionRef('builder', 'request');
const APPROVE = permissionRef('builder', 'approve');
const HELP = permissionRef('help', 'show');
const RESET = permissionRef('admin', 'reset');

const DECLARED: Readonly<Record<string, Fallback>> = {
  'builder.request': 'guild-admin',
  // Anything that spends money defaults to nobody until somebody is named.
  'builder.approve': 'nobody',
  'help.show': 'everyone',
  'admin.reset': 'app-owner',
};

const fallbacks: FallbackResolver = (permKey) => DECLARED[permKey];

function guildId(raw = '100000000000000001'): GuildId {
  const r = toGuildId(raw);
  assert.ok(r.ok);
  return r.value;
}
function userId(raw: string): UserId {
  const r = toUserId(raw);
  assert.ok(r.ok);
  return r.value;
}
function roleId(raw: string): RoleId {
  const r = toRoleId(raw);
  assert.ok(r.ok);
  return r.value;
}

const ALICE = userId('200000000000000001');
const BOB = userId('200000000000000002');
const OWNER = userId('200000000000000003');
const REVIEWERS = roleId('300000000000000001');

function subject(over: Partial<AccessSubjectSnapshot> = {}): AccessSubjectSnapshot {
  return {
    userId: over.userId ?? ALICE,
    roleIds: over.roleIds ?? [],
    memberPermissions: over.memberPermissions ?? 0n,
    isAppOwner: over.isAppOwner ?? false,
  };
}

interface Fixture {
  readonly access: AccessControl;
  readonly settings: SettingsStore;
}

function fixture(): Fixture {
  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const settings = createSettings({ db, clock, logger });
  const access = createAccess({ db, clock, logger, settings, fallbacks });
  return { access, settings };
}

// ---------------------------------------------------------------------------------------
// Separation of duty
// ---------------------------------------------------------------------------------------

test('granting builder.request does not grant builder.approve - asking is not approving', () => {
  const { access } = fixture();
  const g = guildId();
  const granted = access.grant(g, REQUEST, { kind: 'role', id: REVIEWERS }, OWNER);
  assert.ok(granted.ok);

  const asker = subject({ roleIds: [REVIEWERS] });
  assert.deepEqual(access.check(g, REQUEST, asker), { allowed: true, layer: 'L1-allowlist' });

  const approve = access.check(g, APPROVE, asker);
  assert.equal(approve.allowed, false, 'the SAME role must not be able to approve');
  if (approve.allowed) return;
  assert.equal(approve.layer, 'L3-deny');
  assert.equal(approve.grantableBy, 'a server manager', 'a denial has to name who to ask, as a bare noun phrase');
});

test('the two keys keep independent allow-lists, so revoking one leaves the other', () => {
  const { access } = fixture();
  const g = guildId();
  assert.ok(access.grant(g, REQUEST, { kind: 'user', id: ALICE }, OWNER).ok);
  assert.ok(access.grant(g, APPROVE, { kind: 'user', id: BOB }, OWNER).ok);

  assert.equal(access.check(g, REQUEST, subject({ userId: ALICE })).allowed, true);
  assert.equal(access.check(g, APPROVE, subject({ userId: ALICE })).allowed, false);
  assert.equal(access.check(g, APPROVE, subject({ userId: BOB })).allowed, true);
  assert.equal(access.check(g, REQUEST, subject({ userId: BOB })).allowed, false);

  const revoked = access.revoke(g, APPROVE, { kind: 'user', id: BOB });
  assert.ok(revoked.ok);
  assert.equal(revoked.value, true);
  // The write invalidated the cache, so the very next decision sees the revocation.
  assert.equal(access.check(g, APPROVE, subject({ userId: BOB })).allowed, false);
  assert.equal(access.check(g, REQUEST, subject({ userId: ALICE })).allowed, true);

  const again = access.revoke(g, APPROVE, { kind: 'user', id: BOB });
  assert.ok(again.ok);
  assert.equal(again.value, false, 'revoking nothing is a routine false, not an error');
});

// ---------------------------------------------------------------------------------------
// Self-approval
// ---------------------------------------------------------------------------------------

test('the requester cannot approve their own request, even holding the approve grant', () => {
  const { access } = fixture();
  const g = guildId();
  assert.ok(access.grant(g, APPROVE, { kind: 'role', id: REVIEWERS }, OWNER).ok);
  const alice = subject({ userId: ALICE, roleIds: [REVIEWERS] });

  // She may approve in general...
  assert.equal(access.check(g, APPROVE, alice).allowed, true);
  // ...but not her own request. THIS IS THE DEFAULT, with no configuration anywhere.
  const own = access.checkSelfApproval({ guildId: g, ref: APPROVE, subject: alice, requesterId: ALICE });
  assert.equal(own.allowed, false);
  if (own.allowed) return;
  assert.equal(own.grantableBy, 'another approver');

  // A different holder of the same grant is fine - the rule is about identity, not privilege.
  const bob = subject({ userId: BOB, roleIds: [REVIEWERS] });
  assert.equal(access.checkSelfApproval({ guildId: g, ref: APPROVE, subject: bob, requesterId: ALICE }).allowed, true);
});

test('self-approval is allowed only after a guild explicitly turns it on', () => {
  const { access, settings } = fixture();
  const g = guildId();
  assert.ok(access.grant(g, APPROVE, { kind: 'user', id: ALICE }, OWNER).ok);
  const alice = subject({ userId: ALICE });

  assert.equal(access.checkSelfApproval({ guildId: g, ref: APPROVE, subject: alice, requesterId: ALICE }).allowed, false);
  setSelfApprove(settings, g, true);
  assert.equal(access.checkSelfApproval({ guildId: g, ref: APPROVE, subject: alice, requesterId: ALICE }).allowed, true);
  setSelfApprove(settings, g, false);
  assert.equal(access.checkSelfApproval({ guildId: g, ref: APPROVE, subject: alice, requesterId: ALICE }).allowed, false);
});

test('not even the application owner self-approves by default', () => {
  const { access } = fixture();
  const g = guildId();
  const owner = subject({ userId: OWNER, isAppOwner: true });
  assert.equal(access.check(g, APPROVE, owner).allowed, true, 'L0 still allows approving in general');
  assert.equal(
    access.checkSelfApproval({ guildId: g, ref: APPROVE, subject: owner, requesterId: OWNER }).allowed,
    false,
    'separation of duty is about identity, so it applies to the owner too',
  );
});

test('self-approval in a DM is denied, because no guild has enabled anything', () => {
  const { access } = fixture();
  const owner = subject({ userId: OWNER, isAppOwner: true });
  assert.equal(access.checkSelfApproval({ guildId: null, ref: APPROVE, subject: owner, requesterId: OWNER }).allowed, false);
});

// ---------------------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------------------

test('the application owner is allowed at L0, above every allow-list', () => {
  const { access } = fixture();
  assert.deepEqual(access.check(guildId(), APPROVE, subject({ isAppOwner: true })), { allowed: true, layer: 'L0-owner' });
  assert.deepEqual(access.check(null, RESET, subject({ isAppOwner: true })), { allowed: true, layer: 'L0-owner' });
});

test('PUBLIC allows without touching the allow-list', () => {
  const { access } = fixture();
  assert.deepEqual(access.check(guildId(), PUBLIC, subject()), { allowed: true, layer: 'L2-fallback' });
  assert.deepEqual(access.check(null, PUBLIC, subject()), { allowed: true, layer: 'L2-fallback' });
});

test('a role allow-list matches on the CLICKER roles, not on who created the card', () => {
  const { access } = fixture();
  const g = guildId();
  assert.ok(access.grant(g, APPROVE, { kind: 'role', id: REVIEWERS }, OWNER).ok);
  assert.equal(access.check(g, APPROVE, subject({ userId: BOB, roleIds: [REVIEWERS] })).allowed, true);
  assert.equal(access.check(g, APPROVE, subject({ userId: BOB, roleIds: [] })).allowed, false);
});

test('the guild-admin fallback is Manage Server ONLY - Administrator is never expanded', () => {
  const { access } = fixture();
  const g = guildId();
  const manager = subject({ memberPermissions: PERMISSION_BITS.ManageGuild });
  assert.deepEqual(access.check(g, REQUEST, manager), { allowed: true, layer: 'L2-fallback' });

  // The bit that every "admin shortcut" in every framework expands. Here it means nothing:
  // an Administrator-only member does not satisfy `guild-admin`.
  const administratorOnly = subject({ memberPermissions: 1n << 3n });
  assert.equal(access.check(g, REQUEST, administratorOnly).allowed, false);
});

test('THE DM BYPASS: a guild-admin fallback evaluated in a DM denies', () => {
  const { access } = fixture();
  // Every permission bit set, in a DM. The rejected framework answered "allowed" here for
  // every gated command; the only correct answer is that there is no server to manage.
  const everything = subject({ memberPermissions: (1n << 64n) - 1n });
  const decision = access.check(null, REQUEST, everything);
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.layer, 'L3-deny');
});

test('the guild owner satisfies guild-admin even with no permission bits recorded', () => {
  const { access, settings } = fixture();
  const g = guildId();
  const owner = subject({ userId: BOB, memberPermissions: 0n });
  assert.equal(access.check(g, REQUEST, owner).allowed, false, 'before the owner is known');
  setGuildOwnerId(settings, g, BOB);
  assert.deepEqual(access.check(g, REQUEST, owner), { allowed: true, layer: 'L2-fallback' });
  assert.equal(access.check(g, REQUEST, subject({ userId: ALICE })).allowed, false, 'and only the owner');
});

test('an everyone fallback allows in a guild and in a DM', () => {
  const { access } = fixture();
  assert.equal(access.check(guildId(), HELP, subject()).allowed, true);
  assert.equal(access.check(null, HELP, subject()).allowed, true);
});

test('an app-owner fallback denies everyone else, whatever their guild permissions', () => {
  const { access } = fixture();
  const decision = access.check(guildId(), RESET, subject({ memberPermissions: PERMISSION_BITS.ManageGuild }));
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.grantableBy, 'the bot owner');
});

test('a permission key no module declares is denied, never defaulted to everyone', () => {
  const { access } = fixture();
  const ghost = permissionRef('ghost', 'do-anything');
  assert.equal(access.check(guildId(), ghost, subject({ memberPermissions: PERMISSION_BITS.ManageGuild })).allowed, false);

  const granted = access.grant(guildId(), ghost, { kind: 'user', id: ALICE }, OWNER);
  assert.equal(granted.ok, false, 'and it cannot be granted either - a typo must not look fixed');
  if (granted.ok) return;
  assert.equal(granted.error.kind, 'not-found');
});

test('PUBLIC cannot be granted', () => {
  const { access } = fixture();
  const r = access.grant(guildId(), PUBLIC, { kind: 'user', id: ALICE }, OWNER);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.kind, 'validation');
});

test('list reports the grants of one guild only', () => {
  const { access } = fixture();
  const a = guildId('100000000000000001');
  const b = guildId('100000000000000002');
  assert.ok(access.grant(a, APPROVE, { kind: 'user', id: ALICE }, OWNER).ok);
  assert.ok(access.grant(b, APPROVE, { kind: 'role', id: REVIEWERS }, OWNER).ok);

  const inA = access.list(a);
  assert.equal(inA.length, 1);
  assert.deepEqual(inA[0]?.subject, { kind: 'user', id: ALICE });
  assert.equal(inA[0]?.grantedBy, OWNER);
  assert.equal(access.list(b).length, 1);
  // A grant in one guild is not a grant in another - the table is keyed by guild for a reason.
  assert.equal(access.check(b, APPROVE, subject({ userId: ALICE })).allowed, false);
});

test('a re-grant refreshes the record instead of duplicating it', () => {
  const { access } = fixture();
  const g = guildId();
  assert.ok(access.grant(g, APPROVE, { kind: 'user', id: ALICE }, OWNER).ok);
  assert.ok(access.grant(g, APPROVE, { kind: 'user', id: ALICE }, BOB).ok);
  const grants = access.list(g);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.grantedBy, BOB);
});
