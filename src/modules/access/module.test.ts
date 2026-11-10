/**
 * `/access`, against the REAL access adapter.
 *
 * WHY NOT `fakeAccess()`: that fake says yes to everything, so every refusal this module exists
 * to make would pass against it whether or not the code made it. The claims here are all about
 * what is REFUSED - an invented key, `@core.public`, a subject that is both a user and a role -
 * so they are asserted against `createAccess`, over a real `node:sqlite` database, with the
 * same `fallbacksFromCatalog` resolver production wires. A test file may import an adapter;
 * `src/conventions.test.ts` applies the module import wall to non-test files only.
 *
 * THE CLAIM THAT MATTERS MOST is the one that is easy to skip: `access.manage` must not fall
 * back to `nobody`. `builder.approve` does, correctly - it spends money - and the result today
 * is that the ONLY approver in the world is `DISCORD_OWNER_ID` via the L0 bypass, who cannot
 * approve their own request. If the command that hands out permissions had the same default,
 * it would need a grant only it could make, and the bootstrap would deadlock in exactly the
 * same shape. That is asserted from the shipped manifest, not from a comment.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { toChannelId, toGuildId, toRoleId, toUserId, type ChannelId, type GuildId, type RoleId, type UserId } from '#core/ids';
import { permissionRef } from '#core/policy';
import { renderSafeMarkdown, userTextForTest } from '#core/text';
import type { CatalogPermission, CatalogPort } from '#core/ports';
import type { View } from '#core/view';
import { fakeAudit, type FakeAudit } from '#testing/fakes';

import { createAccess, fallbacksFromCatalog, type AccessControl } from '#adapters/system/access';
import { createSettings } from '#adapters/system/settings';
import { createTestDb } from '#adapters/system/testdb';
import { manualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';

import { AccessAdminService, type MutationInput } from '#modules/access/domain';
import { accessCommands, describeSubject, present } from '#modules/access/present';
import accessModule from '#modules/access/module';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/** The registry this bot would really have: one grantable key, one that costs money. */
const DECLARED: readonly CatalogPermission[] = [
  {
    moduleId: 'access',
    key: 'manage',
    permKey: 'access.manage',
    summary: 'View, grant and revoke permission grants in this server',
    fallback: 'guild-admin',
  },
  { moduleId: 'builder', key: 'approve', permKey: 'builder.approve', summary: 'Approve a build request', fallback: 'nobody' },
  { moduleId: 'builder', key: 'request', permKey: 'builder.request', summary: 'Open a build request', fallback: 'guild-admin' },
];

function catalogOf(permissions: readonly CatalogPermission[]): CatalogPort {
  return {
    modules: () => [],
    commands: () => [],
    permissions: () => permissions,
    health: async () => [],
  };
}

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
/** WHY through the door and not `as ChannelId`: this repo has exactly one sanctioned cast,
 *  and it is not this one. The regex inside `toChannelId` IS the evidence for the brand. */
function channelId(raw: string): ChannelId {
  const r = toChannelId(raw);
  assert.ok(r.ok);
  return r.value;
}

const GUILD = guildId();
const ADMIN = userId('200000000000000001');
const ALICE = userId('200000000000000002');
const REVIEWERS = roleId('300000000000000001');

interface Fixture {
  readonly svc: AccessAdminService;
  readonly access: AccessControl;
  readonly audit: FakeAudit;
}

function fixture(permissions: readonly CatalogPermission[] = DECLARED): Fixture {
  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const settings = createSettings({ db, clock, logger });
  const catalog = catalogOf(permissions);
  // The SAME resolver production uses, so "declared" means one thing in both layers.
  const access = createAccess({ db, clock, logger, settings, fallbacks: fallbacksFromCatalog(catalog) });
  const audit = fakeAudit();
  return { svc: new AccessAdminService(access, catalog, audit), access, audit };
}

/** Shorthand for a well-formed request, so each test states only what it is about. */
function ask(over: Partial<MutationInput> = {}): MutationInput {
  return {
    guildId: over.guildId ?? GUILD,
    permission: over.permission ?? userTextForTest('builder.approve'),
    user: 'user' in over ? over.user : ALICE,
    role: 'role' in over ? over.role : undefined,
    actorId: over.actorId ?? ADMIN,
  };
}

/** Every string a `View` would put in front of a user. `SafeMarkdown` hides behind a symbol,
 *  so `JSON.stringify` of a view renders `{}` for every text node and asserts nothing. */
function viewText(view: View): string {
  const out: string[] = [];
  for (const node of view.nodes) {
    if (node.kind === 'text') out.push(renderSafeMarkdown(node.md));
    else if (node.kind === 'heading') out.push(node.text);
    else if (node.kind === 'field') out.push(node.name, renderSafeMarkdown(node.md));
    else if (node.kind === 'table') out.push(...node.head, ...node.rows.flatMap((r) => [...r]));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------
// A key must be one somebody declared. This is what keeps `PermissionRef` unforgeable.
// ---------------------------------------------------------------------------------------

test('an unknown permission key is refused - a caller cannot invent a permission', () => {
  const { svc } = fixture();

  const invented = svc.grant(ask({ permission: userTextForTest('ghost.do-anything') }));

  assert.equal(invented.ok, false, 'a key no module declares must not become a row');
  if (invented.ok) return;
  assert.equal(invented.error.kind, 'not-found');
  assert.ok(invented.error.nextStep.includes('/access list'), 'a refusal has to name the next step');
});

test('the PORT refuses an unknown key too, for a caller that never came through the module', () => {
  // The module re-validates against the catalog, but the module is not the guarantee: any
  // holder of the `access` capability can call `grantByKey` with a string it made up. The
  // adapter is where "a string cannot invent a permission" actually has to hold.
  const { access } = fixture();

  const direct = access.grantByKey(GUILD, 'ghost.do-anything', { kind: 'user', id: ALICE }, ADMIN);

  assert.equal(direct.ok, false);
  if (direct.ok) return;
  assert.equal(direct.error.kind, 'not-found');
  assert.deepEqual(access.list(GUILD), [], 'and nothing was written');
});

test('a malformed key that names no module at all is refused, not split into one', () => {
  const { access } = fixture();

  for (const bad of ['approve', '', '.approve', 'builder.']) {
    const r = access.grantByKey(GUILD, bad, { kind: 'user', id: ALICE }, ADMIN);
    assert.equal(r.ok, false, `"${bad}" must not be grantable`);
  }
  assert.deepEqual(access.list(GUILD), []);
});

test('a key the autocomplete never offered is still refused (SC-11)', () => {
  // Discord permits a client to submit a value that was never suggested, so the suggestion
  // list is a convenience and the catalog is the check.
  const { svc } = fixture();

  const offered = svc.suggest(userTextForTest('approve')).map((c) => c.value);
  assert.deepEqual(offered, ['builder.approve'], 'only the matching declared key is offered');

  const smuggled = svc.grant(ask({ permission: userTextForTest('builder.approve-everything') }));
  assert.equal(smuggled.ok, false);
});

test('PUBLIC cannot be granted', () => {
  const { svc, access } = fixture();

  // Through the module: `@core.public` is not in the catalog, so it is not a choice at all.
  const viaModule = svc.grant(ask({ permission: userTextForTest('@core.public') }));
  assert.equal(viaModule.ok, false);

  // Through the port, where it IS recognised - and refused BY NAME, so the operator is told
  // that the key is meaningless to grant rather than that it does not exist.
  const viaPort = access.grantByKey(GUILD, '@core.public', { kind: 'user', id: ALICE }, ADMIN);
  assert.equal(viaPort.ok, false);
  if (viaPort.ok) return;
  assert.equal(viaPort.error.kind, 'validation');
  assert.ok(viaPort.error.userDetail.toLowerCase().includes('public'));
  assert.deepEqual(access.list(GUILD), []);
});

// ---------------------------------------------------------------------------------------
// The round trip: grant, then see it
// ---------------------------------------------------------------------------------------

test('granting then listing shows the grant, and the underlying check now allows', () => {
  const { svc, access } = fixture();

  const granted = svc.grant(ask({ permission: userTextForTest('builder.approve'), user: ALICE }));
  assert.ok(granted.ok, 'a declared key granted to a real user must succeed');
  if (!granted.ok) return;
  assert.equal(granted.value.permKey, 'builder.approve');
  assert.deepEqual(granted.value.subject, { kind: 'user', id: ALICE });

  const row = svc.overview(GUILD).find((r) => r.permKey === 'builder.approve');
  assert.ok(row !== undefined, 'the declared key must appear in the listing');
  assert.deepEqual(row.subjects, [{ kind: 'user', id: ALICE }]);
  assert.equal(row.fallback, 'nobody');
  assert.equal(row.orphan, false);

  // The whole point: the grant is what `check` reads, so Alice can now approve.
  const decision = access.check(GUILD, permissionRef('builder', 'approve'), {
    userId: ALICE,
    roleIds: [],
    memberPermissions: 0n,
    isAppOwner: false,
  });
  assert.deepEqual(decision, { allowed: true, layer: 'L1-allowlist' });
});

test('a role grant works the same way, and the card prints the id revoke needs back', () => {
  const { svc } = fixture();

  const granted = svc.grant(ask({ user: undefined, role: REVIEWERS }));
  assert.ok(granted.ok);
  if (!granted.ok) return;
  assert.deepEqual(granted.value.subject, { kind: 'role', id: REVIEWERS });

  const text = viewText(present.overview(svc.overview(GUILD)));
  assert.ok(text.includes(`role:${REVIEWERS}`), 'the listing must print the id, since /access revoke takes it');
  assert.equal(describeSubject({ kind: 'role', id: REVIEWERS }), `role:${REVIEWERS}`);
});

test('a declared key with no grant still shows, with the fallback that explains why nothing works', () => {
  const { svc } = fixture();

  const rows = svc.overview(GUILD);

  assert.deepEqual(
    rows.map((r) => r.permKey),
    ['access.manage', 'builder.approve', 'builder.request'],
    'every declared key is listed, granted or not - that is what makes /access list an answer',
  );
  const approve = rows.find((r) => r.permKey === 'builder.approve');
  assert.deepEqual(approve?.subjects, []);
  assert.equal(approve?.fallback, 'nobody');

  const text = viewText(present.overview(rows));
  assert.ok(text.includes('builder.approve'));
  assert.ok(text.includes('nobody'), 'the card has to say `nobody` out loud, or the deadlock is invisible');
});

test('a grant whose key no module declares any more is listed as orphaned, not hidden', () => {
  const { access } = fixture();
  assert.ok(access.grantByKey(GUILD, 'builder.approve', { kind: 'user', id: ALICE }, ADMIN).ok);

  // The builder module is uninstalled: its keys leave the catalog, the rows stay behind.
  const after = new AccessAdminService(access, catalogOf(DECLARED.slice(0, 1)), fakeAudit());
  const rows = after.overview(GUILD);

  const orphan = rows.find((r) => r.permKey === 'builder.approve');
  assert.ok(orphan !== undefined, 'a row that gates nothing must not vanish from the listing');
  assert.equal(orphan.orphan, true);
  assert.deepEqual(orphan.subjects, [{ kind: 'user', id: ALICE }]);
});

// ---------------------------------------------------------------------------------------
// Revoking
// ---------------------------------------------------------------------------------------

test('revoking a grant that was not there answers "nothing to revoke", it does not error', () => {
  const { svc } = fixture();

  const gone = svc.revoke(ask({ permission: userTextForTest('builder.approve'), user: ALICE }));

  assert.ok(gone.ok, 'the state the operator asked for already holds; that is not a failure');
  if (!gone.ok) return;
  assert.equal(gone.value.changed, false);

  const view = present.revoked(gone.value.permKey, gone.value.subject, gone.value.changed);
  assert.equal(view.accent, 'warn');
  assert.ok(viewText(view).includes('Nothing to revoke'));
});

test('revoking a grant that WAS there removes it, and says so differently', () => {
  const { svc } = fixture();
  assert.ok(svc.grant(ask({ user: ALICE })).ok);

  const gone = svc.revoke(ask({ user: ALICE }));

  assert.ok(gone.ok);
  if (!gone.ok) return;
  assert.equal(gone.value.changed, true);
  assert.deepEqual(svc.overview(GUILD).find((r) => r.permKey === 'builder.approve')?.subjects, []);
  assert.equal(present.revoked('builder.approve', { kind: 'user', id: ALICE }, true).accent, 'ok');
});

test('revoke refuses an unknown key rather than reporting a comfortable "nothing to revoke"', () => {
  // The two answers are byte-identical to an operator, and only one of them means their
  // typo did nothing. A revoke that silently succeeds is how somebody walks away believing
  // they closed access they did not close.
  const { svc, access } = fixture();

  const viaModule = svc.revoke(ask({ permission: userTextForTest('ghost.do-anything') }));
  assert.equal(viaModule.ok, false);

  const viaPort = access.revokeByKey(GUILD, 'ghost.do-anything', { kind: 'user', id: ALICE });
  assert.equal(viaPort.ok, false);
  if (viaPort.ok) return;
  assert.equal(viaPort.error.kind, 'not-found');
});

// ---------------------------------------------------------------------------------------
// Exactly one of user / role — Discord cannot express it, so this must
// ---------------------------------------------------------------------------------------

test('naming neither a user nor a role is refused', () => {
  const { svc } = fixture();

  const nobody = svc.grant(ask({ user: undefined, role: undefined }));

  assert.equal(nobody.ok, false);
  if (nobody.ok) return;
  assert.equal(nobody.error.kind, 'validation');
  assert.equal(nobody.error.field, 'subject');
});

test('naming BOTH a user and a role is refused, not silently resolved to one', () => {
  const { svc, access } = fixture();

  const both = svc.grant(ask({ user: ALICE, role: REVIEWERS }));

  assert.equal(both.ok, false, 'picking one for them would grant half of what they asked for');
  if (both.ok) return;
  assert.equal(both.error.kind, 'validation');
  assert.deepEqual(access.list(GUILD), [], 'and neither half was written');
});

test('revoke enforces the same rule, so grant and revoke cannot drift apart', () => {
  const { svc } = fixture();
  assert.equal(svc.revoke(ask({ user: undefined, role: undefined })).ok, false);
  assert.equal(svc.revoke(ask({ user: ALICE, role: REVIEWERS })).ok, false);
});

// ---------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------

test('every grant and revoke is audited with the actor, the key and the subject', () => {
  const { svc, audit } = fixture();

  assert.ok(svc.grant(ask({ actorId: ADMIN, user: ALICE })).ok);
  assert.ok(svc.revoke(ask({ actorId: ADMIN, user: ALICE })).ok);

  assert.deepEqual(
    audit.entries.map((e) => e.action),
    ['access.grant', 'access.revoke'],
  );
  const [granted, revoked] = audit.entries;
  assert.equal(granted?.actorId, ADMIN);
  assert.equal(granted?.guildId, GUILD);
  assert.deepEqual(granted?.detail, { permKey: 'builder.approve', subjectKind: 'user', subjectId: ALICE });
  // `changed` is on the revoke row because "revoked" and "there was nothing there" are
  // different facts, and months later only the audit row can tell them apart.
  assert.deepEqual(revoked?.detail, {
    permKey: 'builder.approve',
    subjectKind: 'user',
    subjectId: ALICE,
    changed: true,
  });
});

test('a refused grant writes no audit row, because nothing happened', () => {
  const { svc, audit } = fixture();
  assert.equal(svc.grant(ask({ permission: userTextForTest('ghost.do-anything') })).ok, false);
  assert.equal(svc.grant(ask({ user: undefined, role: undefined })).ok, false);
  assert.deepEqual(audit.entries, []);
});

// ---------------------------------------------------------------------------------------
// The manifest — the bootstrap claim, asserted from what actually ships
// ---------------------------------------------------------------------------------------

test('access.manage does NOT fall back to nobody, or the bootstrap deadlocks', () => {
  const decl = accessModule.manifest.permissions['manage'];

  assert.ok(decl !== undefined, 'the module must declare the key its own commands gate on');
  assert.notEqual(
    decl.fallback,
    'nobody',
    'the command that hands out permissions would then need a grant only it can make - which is exactly the dead end `builder.approve` is in today',
  );
  assert.equal(decl.fallback, 'guild-admin');
  assert.ok(decl.summary.length > 0, 'an undocumented key is ungrantable: the summary is the autocomplete label');
});

test('the module asks for exactly the three ports it uses, and nothing that spends money', () => {
  assert.deepEqual([...accessModule.manifest.capabilities].sort(), ['access', 'audit', 'catalog']);
});

test('every /access command is gated on access.manage and declares its limits', () => {
  const perms = { manage: permissionRef('access', 'manage') };
  const commands = accessCommands(fixture().svc, perms);

  assert.deepEqual(
    commands.map((c) => c.name),
    ['access list', 'access grant', 'access revoke'],
  );
  for (const c of commands) {
    assert.equal(c.permission, perms.manage, `${c.name} must be gated on the declared key, never PUBLIC`);
    assert.equal(c.surface, 'guild', `${c.name} writes a per-guild allow-list, so it has no meaning in a DM`);
    assert.ok(c.limit.length > 0, `${c.name} must declare a rate limit`);
    // A permission listing names who can approve builds; it is nobody else's business.
    assert.equal(c.ack, 'defer-ephemeral');
  }
});

test('the autocompleting option has a handler, and both subject options are optional', () => {
  const commands = accessCommands(fixture().svc, { manage: permissionRef('access', 'manage') });

  for (const c of commands.filter((s) => s.name !== 'access list')) {
    const option = c.options.find((o) => o.name === 'permission');
    assert.equal(option?.autocomplete, true, `${c.name} must offer the declared keys`);
    // Without this the registry refuses to boot - and before that check existed, Discord
    // simply timed out in front of the user.
    assert.notEqual(c.autocomplete, undefined, `${c.name} declares autocomplete and must answer it`);
    assert.equal(c.options.find((o) => o.name === 'user')?.required, false);
    assert.equal(c.options.find((o) => o.name === 'role')?.required, false);
  }
});

test('autocomplete answers from the registry, so it cannot offer a key that does not exist', async () => {
  const { svc } = fixture();
  const commands = accessCommands(svc, { manage: permissionRef('access', 'manage') });
  const grant = commands.find((c) => c.name === 'access grant');
  assert.ok(grant !== undefined);
  assert.ok(grant.autocomplete !== undefined);

  const choices = await grant.autocomplete({
    actor: { userId: ADMIN, roleIds: [], isAppOwner: false, memberPermissions: 0n, appPermissions: 0n },
    space: { guildId: GUILD, channelId: channelId('400000000000000001') },
    option: 'permission',
    partial: userTextForTest('builder.'),
    at: 0,
  });

  assert.deepEqual(
    choices.map((c) => c.value),
    ['builder.approve', 'builder.request'],
  );
  for (const c of choices) assert.ok(c.name.includes(c.value), 'the label has to show the key that gets submitted');
});
