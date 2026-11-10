/**
 * `/admin` — the operator's view, asserted where it can actually be wrong.
 *
 * THE CLAIMS WORTH TESTING HERE ARE NOT "does it render". They are the ones that would be
 * expensive to get wrong and cheap to get wrong silently:
 *
 *  1. GUILD ISOLATION. `AdminPort.recentAudit(null, n)` returns rows from EVERY guild. The
 *     module must reach that only from a DM, where the `guild-admin` fallback denies everyone
 *     and the application owner's L0 bypass is the only way through. That claim is about the
 *     REAL access adapter, so it is asserted against `createAccess` over a real database — a
 *     fake that says yes to everything would pass whether or not the property held. This is the
 *     same reasoning `src/modules/access/module.test.ts` records. THE FILTERS ADDED THIS ROUND
 *     ARE HELD TO THE SAME PROPERTY: five options now exist, and none of them may move the
 *     guild the port is asked about.
 *
 *  2. `detail` STAYS DATA. It is serialised and cut, never read key by key and never turned
 *     into a sentence. The test asserts the SHAPE of the cell, because a future "nicer"
 *     rendering is exactly the change that would re-assemble text a sanitiser took apart. The
 *     action filter is held to the same line: it is refused unless it is a lowercase dotted
 *     verb, so the one typed option on this command cannot carry prose into a card.
 *
 *  3. THE CARD FITS. `MAX_AUDIT_ROWS` rows of maximum-width cells go through the REAL renderer,
 *     and the fenced block must come back closed. Discord rejects an embed description over
 *     4096 characters in front of the operator, during the incident — boot previews use small
 *     samples and would not catch it. The table grew a column this round, so the proof matters
 *     more than it did.
 *
 *  4. `/status` STOPS SAYING `ok` WHILE JOBS ARE DEAD — OR WHILE ONE IS WEDGED. That is the
 *     defect this module exists to close, so it is asserted from the SHIPPED manifest through
 *     `install()`, not from a hand-built service.
 *
 *  5. THE ANSWERS ARE TRUE ABOUT WHAT WAS SEARCHED. Paging reads only as far as the page it was
 *     asked for; a filter reads the whole window and the card says so; "nothing matched" and
 *     "nothing has happened" are different sentences. Each of those is asserted, because each is
 *     a claim a card makes to somebody mid-incident.
 *
 * A test file may import an adapter; `src/conventions.test.ts` applies the module import wall to
 * non-test files only.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { AdminPort, AuditRecord, CatalogModule, CatalogPermission, CatalogPort, JobStats, RunningJob } from '#core/ports';
import type { CommandSpec, InstalledModule, Invocation, ProgressHandle } from '#core/module';
import type { Args } from '#core/args';
import type { AppError } from '#core/errors';
import type { Result } from '#core/result';
import { Err, Ok } from '#core/result';
import type { SurfaceRef, View } from '#core/view';
import type { DecisionLayer } from '#core/policy';
import { permissionRef } from '#core/policy';
import { createEventBus } from '#core/events';
import { renderSafeMarkdown, toEnum, userTextForTest, wrapUserText } from '#core/text';
import {
  toChannelId,
  toGuildId,
  toRoleId,
  toUserId,
  newRequestId,
  type ChannelId,
  type GuildId,
  type RoleId,
  type UserId,
} from '#core/ids';
import { fakeCatalog, fakeLogger } from '#testing/fakes';

import { EMBED_DESCRIPTION_MAX, renderView } from '#adapters/discord/render';
import { createAccess, fallbacksFromCatalog } from '#adapters/system/access';
import { createSettings } from '#adapters/system/settings';
import { createTestDb } from '#adapters/system/testdb';
import { createJobSystem } from '#adapters/system/jobs';
import { manualClock } from '#adapters/system/clock';
import { silentLogger } from '#adapters/system/logger';

import adminModule from '#modules/admin/module';
import {
  AdminService,
  DEFAULT_AUDIT_ROWS,
  DEFAULT_STUCK_AFTER_MS,
  LAYER_CHOICES,
  MAX_AUDIT_PAGE,
  MAX_AUDIT_ROWS,
  MAX_AUDIT_SCAN,
  NO_FILTER,
  NO_LAYER_FILTER,
  clampPage,
  clampRows,
  matchesFilter,
  parseActionFilter,
  readOldestRunning,
  type AdminOptions,
  type AuditFilter,
  type AuditPage,
} from '#modules/admin/domain';
import {
  ACTION_CELL_MAX,
  AUDIT_COLUMNS,
  DETAIL_CELL_MAX,
  MODULE_CELL_MAX,
  NO_LAYER,
  adminCommands,
  actorLabels,
  auditRowCells,
  compactDetail,
  formatAge,
  formatDuration,
  present,
} from '#modules/admin/present';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const CHANNEL = '300000000000000009';
const OWNER = '200000000000000001';
const MANAGER = '200000000000000002';
const NOBODY = '200000000000000003';

/** Discord's `ManageGuild` bit, which is what the `guild-admin` fallback reads. */
const MANAGE_GUILD = 1n << 5n;

// `oldestRunning: null` is WRITTEN OUT, not left off. The field is required on `JobStats` now,
// and a fixture that omitted it would only be possible while the port was still optional - which
// is exactly the window in which a renderer could be tested entirely against the absent case
// while production only ever produced `null`.
const EMPTY_STATS: JobStats = { queued: 0, running: 0, done: 0, dead: 0, cancelled: 0, orphaned: 0, oldestRunning: null };

/** The service options a test does not otherwise care about. */
const OPTS: AdminOptions = { defaultRows: DEFAULT_AUDIT_ROWS, stuckAfterMs: DEFAULT_STUCK_AFTER_MS };

function opts(over: Partial<AdminOptions> = {}): AdminOptions {
  return { ...OPTS, ...over };
}

function stats(over: Partial<JobStats> = {}): JobStats {
  return { ...EMPTY_STATS, ...over };
}

/**
 * `JobStats` carrying an oldest running job.
 *
 * THE NEGOTIATION THIS FILE USED TO ENCODE IS OVER. While `#core/ports` was still being written
 * these tests drove an `unknown`-valued probe that read two possible spellings, because guessing
 * wrong would have cost the entire point of the change. The port landed as a required
 * `RunningJob | null` carrying `moduleId`, `type`, `startedAtMs` AND `ageMs`, so the hedge is
 * gone and this builds the real type.
 *
 * `ageMs` is the field this module argued for and got: `health()` is handed no clock and this
 * module declares no `clock` capability, so a start instant alone could be rendered on the card
 * and could never degrade `/status`.
 */
function runningJob(name: string, ageMs: number): RunningJob {
  const [moduleId = name, type = ''] = name.split(':');
  return { moduleId, type, startedAtMs: NOW - ageMs, ageMs };
}

function statsWith(over: Partial<JobStats>, oldest: RunningJob | null): JobStats {
  return { ...EMPTY_STATS, ...over, oldestRunning: oldest };
}

function guildId(raw: string): GuildId {
  const r = toGuildId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a guild id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function userId(raw: string): UserId {
  const r = toUserId(raw);
  assert.ok(r.ok, `fixture: ${raw} is not a user id`);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
function roleId(raw: string): RoleId {
  const r = toRoleId(raw);
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}
/** WHY through the door and not `as ChannelId`: this repo has exactly one sanctioned cast. */
function channelId(raw: string): ChannelId {
  const r = toChannelId(raw);
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

function row(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 1,
    atMs: NOW - 60_000,
    moduleId: 'builder',
    action: 'builder.approve',
    actorId: OWNER,
    guildId: GUILD,
    decisionLayer: 'L1-allowlist',
    detail: { requestId: 'rq_1' },
    ...over,
  };
}

/** `n` rows, newest first, distinguishable by id. */
function rows(n: number, over: (i: number) => Partial<AuditRecord> = () => ({})): readonly AuditRecord[] {
  return Array.from({ length: n }, (_v, i) => row({ id: n - i, atMs: NOW - i * 60_000, ...over(i) }));
}

/** A filter with only the fields a test cares about set. */
function filter(over: Partial<AuditFilter> = {}): AuditFilter {
  return { ...NO_FILTER, ...over };
}

/**
 * An `AdminPort` that REMEMBERS what it was asked.
 *
 * The scoping claim is about the ARGUMENTS this module passes, not about what comes back, so
 * the fake has to record the call. `#testing/fakes` ships one too; this file keeps its own so
 * the assertions here do not depend on another owner's fake staying shaped this way.
 */
interface RecordingAdmin extends AdminPort {
  readonly asked: readonly { readonly guildId: string | null; readonly limit: number }[];
}

function recordingAdmin(seeded: readonly AuditRecord[] = [], jobStats: JobStats = EMPTY_STATS): RecordingAdmin {
  const asked: { guildId: string | null; limit: number }[] = [];
  return {
    asked,
    recentAudit(scope, limit) {
      asked.push({ guildId: scope, limit });
      return seeded.slice(0, limit);
    },
    jobStats: () => jobStats,
  };
}

function catalogOf(modules: readonly CatalogModule[] = [], permissions: readonly CatalogPermission[] = []): CatalogPort {
  return { modules: () => modules, commands: () => [], permissions: () => permissions, health: async () => [] };
}

/**
 * The one cast in this file, and it is structural rather than lazy.
 * `ProgressHandle` carries a module-private symbol on purpose — that is what makes it
 * unserialisable, so a live interaction token cannot reach a durable job payload. A test cannot
 * build one by writing the fields, and the router does this same cast for this same reason.
 * Nothing on the `/admin` path reads it.
 */
function progress(): ProgressHandle {
  const stub = {
    tokenExpiresAtMs: NOW + 900_000,
    update: (): void => undefined,
    detach: (): SurfaceRef => ({ guildId: GUILD, channelId: CHANNEL, messageId: '400000000000000001' }),
  };
  return stub as unknown as ProgressHandle;
}

/** Every option `/admin audit` declares, as a test writes them. */
interface Options {
  readonly limit?: number;
  readonly page?: number;
  readonly action?: string;
  readonly actor?: string;
  readonly layer?: string;
}

/** The option bag as the router builds it: absent options are absent from `names`. */
function args(options: Options = {}): Args {
  const missing = (name: string): Result<never, AppError> =>
    Err({
      kind: 'validation',
      field: name,
      userDetail: 'That option is missing.',
      nextStep: `Provide ${name}.`,
    } as AppError);
  const numeric: Readonly<Record<string, number | undefined>> = { limit: options.limit, page: options.page };
  return {
    names: Object.keys(options),
    text: (name) => (name === 'action' && options.action !== undefined ? userTextForTest(options.action) : undefined),
    textRequired(name: string) {
      throw new Error(`args.textRequired("${name}"): /admin declares no required text option`);
    },
    integer(name, bounds) {
      const raw = numeric[name];
      if (raw === undefined) return missing(name);
      if (raw < bounds.min || raw > bounds.max) {
        return Err({
          kind: 'validation',
          field: name,
          userDetail: `That number must be between ${bounds.min} and ${bounds.max}.`,
          nextStep: 'Pick a number in range.',
        } as AppError);
      }
      return Ok(raw);
    },
    bool: () => undefined,
    user: (name) => (name === 'actor' && options.actor !== undefined ? userId(options.actor) : undefined),
    role: () => undefined,
    channel: () => undefined,
    choice(name, allowed) {
      const raw = name === 'layer' ? options.layer : undefined;
      if (raw === undefined) return missing(name);
      // The REAL door: `args.choice` re-validates against the handler's allow-list (SC-11).
      return toEnum(userTextForTest(raw), allowed);
    },
  };
}

function invocation(over: { guild?: string | null; options?: Options } = {}): Invocation {
  const guild = 'guild' in over ? over.guild : GUILD;
  return {
    id: newRequestId(NOW),
    actor: {
      userId: userId(MANAGER),
      roleIds: [],
      isAppOwner: false,
      memberPermissions: MANAGE_GUILD,
      appPermissions: 0n,
    },
    space: {
      guildId: guild === null || guild === undefined ? null : guildId(guild),
      channelId: channelId(CHANNEL),
    },
    args: args(over.options ?? {}),
    progress: progress(),
    at: NOW,
  };
}

function command(name: string, svc: AdminService): CommandSpec {
  const found = adminCommands(svc, { view: permissionRef('admin', 'view') }).find((c) => c.name === name);
  assert.ok(found !== undefined, `/admin must declare "${name}"`);
  if (found === undefined) throw new Error('unreachable');
  return found;
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

/** The real module, really installed, with fakes for both declared ports. */
function install(admin: AdminPort, catalog: CatalogPort = fakeCatalog(), rawConfig: unknown = {}): InstalledModule {
  const installed = adminModule.install({
    ports: { admin, catalog },
    rawConfig,
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(installed.ok, installed.ok ? '' : `the admin module must install: ${installed.error.kind}`);
  if (!installed.ok) throw new Error('unreachable');
  return installed.value;
}

/** The audit command's rendered answer to one invocation. */
async function auditText(svc: AdminService, over: { guild?: string | null; options?: Options } = {}): Promise<string> {
  const outcome = await command('admin audit', svc).handle(invocation(over));
  assert.equal(outcome.kind, 'view', `the audit command must answer with a view, got ${outcome.kind}`);
  return outcome.kind === 'view' ? viewText(outcome.view) : '';
}

/** An `AuditPage` with everything but the interesting field at its quietest. */
function auditPage(over: Partial<AuditPage> = {}): AuditPage {
  const rowsIn = over.rows ?? [row()];
  return {
    guildId: GUILD,
    rows: rowsIn,
    page: 1,
    pageSize: DEFAULT_AUDIT_ROWS,
    filter: NO_FILTER,
    scanRequested: DEFAULT_AUDIT_ROWS + 1,
    scanReturned: rowsIn.length,
    windowFull: false,
    matched: rowsIn.length,
    matchedIsTotal: true,
    hasMore: false,
    oldestScannedAtMs: NOW - 60_000,
    presentActions: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// (1) GUILD ISOLATION — the property the whole design rests on
// ---------------------------------------------------------------------------------------

test('the audit scope comes from the invocation, so a guild only ever reads its own rows', async () => {
  const admin = recordingAdmin([row()]);
  const svc = new AdminService(admin, fakeCatalog(), OPTS);

  await command('admin audit', svc).handle(invocation({ guild: GUILD }));
  await command('admin audit', svc).handle(invocation({ guild: OTHER_GUILD }));

  assert.deepEqual(
    admin.asked.map((a) => a.guildId),
    [GUILD, OTHER_GUILD],
    'the guild passed to the port must be the one the command ran in, never a value from an option',
  );
});

test('no command option can produce the whole-bot scope: it exists only when there is no guild', async () => {
  const admin = recordingAdmin([row()]);
  const svc = new AdminService(admin, fakeCatalog(), OPTS);
  const audit = command('admin audit', svc);

  // Every option this command declares. A new one here is a new way to choose whose rows you
  // read, which is why the list itself is pinned rather than merely the behaviour.
  assert.deepEqual(
    audit.options.map((o) => o.name),
    ['limit', 'page', 'action', 'actor', 'layer'],
    'a new option here is a new way to choose whose rows you read — that is why this is asserted',
  );

  // Every option at once, at values that mean something, from inside a guild.
  await audit.handle(
    invocation({
      guild: GUILD,
      options: { limit: MAX_AUDIT_ROWS, page: MAX_AUDIT_PAGE, action: 'builder', actor: NOBODY, layer: 'L3-deny' },
    }),
  );
  assert.equal(admin.asked.at(-1)?.guildId, GUILD, 'no combination of options may widen the scope');

  await audit.handle(invocation({ guild: null }));
  assert.equal(admin.asked.at(-1)?.guildId, null, 'a DM is the only route to every guild');
});

test('a filter narrows which rows you see and never whose rows they are', () => {
  // Structural, and the reason the types are shaped this way: `matchesFilter` is handed a row
  // and a filter, and there is no guild anywhere in its arguments.
  const mine = row({ guildId: GUILD, actorId: NOBODY });
  const theirs = row({ guildId: OTHER_GUILD, actorId: NOBODY });
  const f = filter({ actorId: NOBODY });
  assert.equal(matchesFilter(mine, f), true);
  assert.equal(matchesFilter(theirs, f), true, 'scoping is the port argument, never the filter');
});

test('in a DM, `guild-admin` denies a server manager — only the app owner reaches the whole-bot view', () => {
  // Against the REAL adapter: `fakeAccess` allows everything, so this claim would pass against
  // it whether or not the code held it.
  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const settings = createSettings({ db, clock, logger });

  // The fallback resolver reads the catalog, and the catalog entry is built from the SHIPPED
  // manifest — so this test fails if somebody changes `view.fallback` in module.ts.
  const declared = adminModule.manifest.permissions['view'];
  assert.ok(declared !== undefined, 'the admin module must declare a `view` permission key');
  assert.equal(declared.fallback, 'guild-admin', 'a diagnostic must not be `nobody`; see module.ts');

  const catalog = catalogOf(
    [],
    [{ moduleId: 'admin', key: 'view', permKey: 'admin.view', summary: declared.summary, fallback: declared.fallback }],
  );
  const access = createAccess({ db, clock, logger, settings, fallbacks: fallbacksFromCatalog(catalog) });
  const ref = permissionRef('admin', 'view');

  const manager = { userId: userId(MANAGER), roleIds: [] as readonly RoleId[], memberPermissions: MANAGE_GUILD, isAppOwner: false };
  const owner = { userId: userId(OWNER), roleIds: [] as readonly RoleId[], memberPermissions: 0n, isAppOwner: true };

  assert.equal(access.check(guildId(GUILD), ref, manager).allowed, true, 'Manage Server reads its own guild');
  assert.equal(access.check(null, ref, manager).allowed, false, 'a DM has no guild to be an admin of');
  assert.equal(access.check(null, ref, owner).allowed, true, 'the application owner keeps the whole-bot view');

  const plain = { userId: userId(NOBODY), roleIds: [] as readonly RoleId[], memberPermissions: 0n, isAppOwner: false };
  assert.equal(access.check(guildId(GUILD), ref, plain).allowed, false, 'an ordinary member reads nothing');
});

test('an explicit grant still works, so an operator can delegate without Manage Server', () => {
  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const settings = createSettings({ db, clock, logger });
  const declared = adminModule.manifest.permissions['view'];
  assert.ok(declared !== undefined);
  if (declared === undefined) throw new Error('unreachable');
  const catalog = catalogOf(
    [],
    [{ moduleId: 'admin', key: 'view', permKey: 'admin.view', summary: declared.summary, fallback: declared.fallback }],
  );
  const access = createAccess({ db, clock, logger, settings, fallbacks: fallbacksFromCatalog(catalog) });

  const granted = access.grantByKey(
    guildId(GUILD),
    'admin.view',
    { kind: 'role', id: roleId('300000000000000001') },
    userId(OWNER),
  );
  assert.ok(granted.ok, 'admin.view must be grantable by key, or /access cannot delegate it');

  const holder = {
    userId: userId(NOBODY),
    roleIds: [roleId('300000000000000001')] as readonly RoleId[],
    memberPermissions: 0n,
    isAppOwner: false,
  };
  const decision = access.check(guildId(GUILD), permissionRef('admin', 'view'), holder);
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed ? decision.layer : null, 'L1-allowlist');
});

// ---------------------------------------------------------------------------------------
// (2) `detail` STAYS DATA — and so does the one typed option
// ---------------------------------------------------------------------------------------

test('detail is serialised as JSON, never described in prose', () => {
  const detail = { requestId: 'rq_1', issue: 41 };
  // The claim, stated exactly: the cell IS the serialisation. Not a summary of it, not a
  // sentence built from its keys — the same bytes `JSON.stringify` produces.
  assert.equal(compactDetail(detail), JSON.stringify(detail));
  assert.equal(compactDetail(detail), '{"requestId":"rq_1","issue":41}');
});

test('detail is bounded, so one fat row cannot eat the card', () => {
  const fat = compactDetail({ note: 'x'.repeat(500) });
  assert.equal([...fat].length, DETAIL_CELL_MAX);
  assert.ok(fat.endsWith('…'), 'a truncated cell must say so');
});

test('detail truncation cuts code points, so it cannot emit a lone surrogate', () => {
  const cut = compactDetail({ e: '😀'.repeat(60) }, 12);
  assert.equal([...cut].length, 12);
  // A lone surrogate is D800-DFFF standing alone; splitting a pair with `.slice` produces one,
  // SQLite stores it happily, and Discord rejects the message.
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(cut));
});

test('an empty detail renders as empty data, not as an empty string', () => {
  assert.equal(compactDetail({}), '{}');
});

test('nothing filters on detail: a filter may only touch what the machinery itself wrote', () => {
  const f = filter({ action: 'builder', actorId: OWNER, layer: 'L1-allowlist' });
  const same = (over: Partial<AuditRecord>): boolean => matchesFilter(row(over), f);
  assert.equal(same({ detail: { anything: 'at all' } }), true);
  assert.equal(same({ detail: {} }), true, 'detail is never read by a filter, so it cannot change the answer');
});

test('the action filter refuses anything that is not a dotted verb', () => {
  const parsed = (raw: string): string | null => {
    const r = parseActionFilter(userTextForTest(raw));
    return r.ok ? r.value : null;
  };
  assert.equal(parsed('builder'), 'builder', 'a bare module id is the natural "everything from here"');
  assert.equal(parsed('builder.approve_denied'), 'builder.approve_denied');
  assert.equal(parsed('builder.'), 'builder.', 'a trailing dot is how you ask for one module');
  assert.equal(parsed('BUILDER.Approve'), 'builder.approve', 'actions are lowercase; so is the needle');

  // The whole point: none of these can reach a table cell or the card's own prose.
  for (const bad of ['', '   ', '```', 'builder approve', '<@200000000000000001>', 'builder`', '1builder', '**b**']) {
    assert.equal(parsed(bad), null, `"${bad}" must be refused, not sanitised into something that matches`);
  }
});

test('an unusable action filter is a validation failure the operator can act on', async () => {
  const svc = new AdminService(recordingAdmin([row()]), fakeCatalog(), OPTS);
  const outcome = await command('admin audit', svc).handle(invocation({ options: { action: 'not a verb' } }));
  assert.equal(outcome.kind, 'fail');
  if (outcome.kind !== 'fail') return;
  assert.equal(outcome.error.kind, 'validation');
  assert.match(outcome.error.nextStep, /builder\.approve/u, 'an error with no example is a dead end');
});

test('the deciding layer is a column this command exists for, and a missing one is explicit', () => {
  const layers: readonly DecisionLayer[] = ['L0-owner', 'L1-allowlist', 'L2-fallback', 'L3-deny'];
  const at = AUDIT_COLUMNS.indexOf('layer');
  for (const layer of layers) {
    assert.equal(auditRowCells(row({ decisionLayer: layer }), NOW)[at], layer);
  }
  assert.equal(
    auditRowCells(row({ decisionLayer: null }), NOW)[at],
    NO_LAYER,
    'a row with no decision must be visibly different from one decided at L3',
  );
});

test('a pathological action name is cut rather than allowed to widen every row', () => {
  const cells = auditRowCells(row({ action: `builder.${'a'.repeat(200)}` }), NOW);
  assert.equal([...(cells[AUDIT_COLUMNS.indexOf('action')] ?? '')].length, ACTION_CELL_MAX);
});

// ---------------------------------------------------------------------------------------
// `module` — the column that makes "who decided this" unspoofable
// ---------------------------------------------------------------------------------------

test('the card shows the module the audit port was minted for, not only the action prefix', () => {
  // `AuditLog.portFor(moduleId)` binds `module_id` at wiring time; `action` is a string the
  // calling module chose. Nothing stops `tags` recording `builder.approve` — and until this
  // column existed, that row was indistinguishable from one the builder wrote.
  const spoofed = row({ moduleId: 'tags', action: 'builder.approve' });
  const cells = auditRowCells(spoofed, NOW);
  assert.equal(cells[AUDIT_COLUMNS.indexOf('module')], 'tags');
  assert.equal(cells[AUDIT_COLUMNS.indexOf('action')], 'builder.approve');

  const text = viewText(present.audit(auditPage({ rows: [spoofed] }), NOW));
  assert.match(text, /\btags\b/u, 'the bound module id must be on the card, or the row cannot be judged');
  assert.match(text, /`layer` shows what allowed it/u, 'and the footer must say what the layer column means');
});

test('a pathological module id is cut, because MODULE_ID_RE allows more than a column can hold', () => {
  const cells = auditRowCells(row({ moduleId: 'm'.repeat(31) }), NOW);
  assert.equal([...(cells[AUDIT_COLUMNS.indexOf('module')] ?? '')].length, MODULE_CELL_MAX);
});

// ---------------------------------------------------------------------------------------
// Relative time, which is what actually answers "is it stuck?"
// ---------------------------------------------------------------------------------------

test('ages read at a glance, at every boundary', () => {
  assert.equal(formatAge(NOW, NOW), '0s');
  assert.equal(formatAge(NOW, NOW - 59_999), '59s');
  assert.equal(formatAge(NOW, NOW - 60_000), '1m');
  assert.equal(formatAge(NOW, NOW - 3_599_999), '59m');
  assert.equal(formatAge(NOW, NOW - 3_600_000), '1h');
  assert.equal(formatAge(NOW, NOW - 86_399_999), '23h');
  assert.equal(formatAge(NOW, NOW - 86_400_000), '1d');
});

test('a row stamped in the future says so instead of printing a negative age', () => {
  // An NTP step or a second process on the same database really does produce these.
  assert.equal(formatAge(NOW, NOW + 5_000), 'ahead');
  assert.equal(formatAge(NOW, Number.NaN), '?');
});

test('a duration formats the same way an age does, because it is the same reading', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(600_000), '10m');
  assert.equal(formatDuration(297_000_000), '3d');
});

// ---------------------------------------------------------------------------------------
// (3) THE CARD FITS — through the real renderer, at the worst case the command can produce
// ---------------------------------------------------------------------------------------

test('a full audit card survives the real renderer with its code fence closed', () => {
  // Every cell at its maximum width: a 19-digit snowflake, the longest layer name, a module id
  // and an action and a detail that all hit their caps — plus every optional line the footer can
  // grow (a filter, a full window, a next page).
  const worst: readonly AuditRecord[] = Array.from({ length: MAX_AUDIT_ROWS }, (_v, i) =>
    row({
      id: i,
      atMs: NOW - i * 86_400_000,
      moduleId: 'm'.repeat(31),
      action: `builder.${'a'.repeat(ACTION_CELL_MAX)}`,
      actorId: '9'.repeat(19),
      decisionLayer: 'L1-allowlist',
      detail: { k: 'v'.repeat(200) },
    }),
  );

  const rendered = renderView(
    present.audit(
      auditPage({
        rows: worst,
        pageSize: MAX_AUDIT_ROWS,
        page: MAX_AUDIT_PAGE,
        matched: MAX_AUDIT_SCAN,
        hasMore: true,
        windowFull: true,
        scanRequested: MAX_AUDIT_SCAN,
        scanReturned: MAX_AUDIT_SCAN,
        filter: { action: 'a'.repeat(40), actorId: '9'.repeat(19), layer: 'L1-allowlist' },
      }),
      NOW,
    ),
  );
  assert.ok(rendered.ok, rendered.ok ? '' : `the worst-case card must render: ${rendered.error.kind}`);
  if (!rendered.ok) return;

  const description = rendered.value.embeds[0]?.description ?? '';
  assert.ok(
    description.length <= EMBED_DESCRIPTION_MAX,
    `Discord rejects a description over ${EMBED_DESCRIPTION_MAX}; this one is ${description.length}`,
  );
  // If clipping had happened, the closing fence would be the part that got cut — which is how a
  // too-large table shows up in front of a user rather than in a test.
  assert.ok(description.includes('```'), 'the table must still be fenced');
  assert.equal(
    [...description.matchAll(/```/gu)].length % 2,
    0,
    'an odd number of fences means the table was truncated mid-block',
  );
});

test('every card this module can produce is ephemeral', () => {
  const svc = new AdminService(recordingAdmin([row()]), fakeCatalog(), OPTS);
  const views: readonly View[] = [
    present.jobs(svc.jobs(NOW)),
    present.audit(svc.audit({ guildId: GUILD, page: 1, pageSize: 5, filter: NO_FILTER }), NOW),
    present.audit(auditPage({ rows: [], matched: 0 }), NOW),
    present.audit(auditPage({ rows: [], matched: 0, filter: filter({ action: 'tags' }) }), NOW),
  ];
  for (const v of views) {
    assert.equal(v.ephemeral, true, 'operational detail must not be left sitting in a channel');
  }
});

// ---------------------------------------------------------------------------------------
// (4) `/status` STOPS SAYING `ok` WHILE JOBS ARE DEAD — OR WHILE ONE IS WEDGED
// ---------------------------------------------------------------------------------------

test('health degrades on a dead-lettered job — the reason this module exists', async () => {
  const installed = install(recordingAdmin([], stats({ dead: 2, done: 40 })));
  const report = await installed.health();
  assert.equal(report.status, 'degraded');
  assert.match(report.detail, /2 jobs dead-lettered/u);
});

test('health degrades on an orphaned row, which means a handler disappeared', async () => {
  const installed = install(recordingAdmin([], stats({ orphaned: 3 })));
  const report = await installed.health();
  assert.equal(report.status, 'degraded');
  assert.match(report.detail, /3 orphaned/u);
});

test('health degrades on a job that has been RUNNING too long, and names it', async () => {
  // THE DEFECT THIS ROUND CLOSES. `1 running` was reported as `ok` whether the attempt started
  // four seconds ago or last Tuesday, because a count was all `/status` had.
  const wedged = statsWith({ running: 1, done: 12 }, runningJob('builder:poll', 3_600_000));
  const installed = install(recordingAdmin([], wedged));
  const report = await installed.health();
  assert.equal(report.status, 'degraded', 'a job running for an hour is not `ok`');
  assert.match(report.detail, /builder:poll/u, 'naming the job is the difference between a signal and an alarm');
  assert.match(report.detail, /1h/u);
});

test('a job that is merely busy stays `ok`: the threshold is what separates the two', async () => {
  const busy = statsWith({ running: 1, done: 900, queued: 4 }, runningJob('builder:poll', 4_000));
  const installed = install(recordingAdmin([], busy));
  const report = await installed.health();
  assert.equal(report.status, 'ok');
  assert.equal(report.detail, '4 queued, 1 running');
});

test('the threshold is configurable, because "normal" depends on the jobs an install runs', async () => {
  const s = statsWith({ running: 1 }, runningJob('tags:reindex', 120_000));
  const patient = install(recordingAdmin([], s), fakeCatalog(), { stuckAfterMs: 600_000 });
  assert.equal((await patient.health()).status, 'ok', 'two minutes is nothing at the default threshold');

  const impatient = install(recordingAdmin([], s), fakeCatalog(), { stuckAfterMs: 60_000 });
  assert.equal((await impatient.health()).status, 'degraded', 'and everything at a one-minute one');
});

test('a busy but healthy queue is `ok`, and says what it is busy with', async () => {
  const installed = install(recordingAdmin([], stats({ queued: 4, running: 2, done: 900 })));
  const report = await installed.health();
  assert.equal(report.status, 'ok');
  assert.equal(report.detail, '4 queued, 2 running');
});

test('health makes no network call: the only port it may touch has none', () => {
  // Structural, and deliberately so. `AdminPort` has exactly two methods and both are local
  // reads; a probe would need a capability this module does not declare. The capability line did
  // not grow this round, which is itself the point — see module.ts.
  assert.deepEqual(
    [...adminModule.manifest.capabilities].sort(),
    ['admin', 'catalog'],
    'no db, no discord, no issues, no builds, no secrets, no access, no jobs, no clock',
  );
});

// ---------------------------------------------------------------------------------------
// The oldest running job — the field this module reads but does not own
// ---------------------------------------------------------------------------------------

test('the oldest running job is read from the port, and its display name is DERIVED not stored', () => {
  // `RunningJob` carries `moduleId` and `type` separately, and `<moduleId>:<type>` is the
  // runner's own handler key - the same string an `orphaned` count refers to. Deriving it here
  // rather than carrying it on the port means there is one spelling of the identity, not two
  // that can disagree.
  const s = statsWith({ running: 1 }, { moduleId: 'builder', type: 'poll', startedAtMs: NOW - 90_000, ageMs: 90_000 });
  assert.deepEqual(readOldestRunning(s, NOW), { name: 'builder:poll', ageMs: 90_000 });
});

test('the age comes from the PORT, so health() needs no clock at all', () => {
  // THE SHAPE THIS MODULE ARGUED FOR AND GOT. `health()` is called with no time argument, and
  // this module declares no `clock` capability - so if the port reported only `startedAtMs`,
  // the wedged-job verdict would render on the card and be permanently unavailable to
  // `/status`, which is the one place an operator is actually watching. `nowMs` is passed as
  // `null` here to prove it is not needed.
  const s = statsWith({ running: 1 }, { moduleId: 'builder', type: 'poll', startedAtMs: NOW - 90_000, ageMs: 90_000 });
  assert.deepEqual(readOldestRunning(s, null), { name: 'builder:poll', ageMs: 90_000 });
});

test('nothing running reads as nothing running, and the card renders the counts alone', () => {
  assert.equal(readOldestRunning(statsWith({ running: 0 }, null), NOW), null);
  assert.equal(readOldestRunning(EMPTY_STATS, NOW), null);
});

test('an age that arrives negative is floored, because a clock skew is not a negative age', () => {
  // The adapter already floors, so this is belt and braces on a value that crossed an ownership
  // boundary - but "running for -3s" reads as a bug in this card rather than as a fact about a
  // host whose clock stepped backwards, so it is worth the one `Math.max`.
  const s = statsWith({ running: 1 }, { moduleId: 'j', type: 'k', startedAtMs: NOW, ageMs: -5 });
  assert.equal(readOldestRunning(s, NOW)?.ageMs, 0);
});

// ---------------------------------------------------------------------------------------
// The jobs card
// ---------------------------------------------------------------------------------------

test('dead jobs colour the card red; orphaned rows only warn', () => {
  const clean = new AdminService(recordingAdmin([], stats({ done: 10 })), fakeCatalog(), OPTS);
  const orphan = new AdminService(recordingAdmin([], stats({ orphaned: 1 })), fakeCatalog(), OPTS);
  const dead = new AdminService(recordingAdmin([], stats({ dead: 1, orphaned: 1 })), fakeCatalog(), OPTS);

  assert.equal(present.jobs(clean.jobs(NOW)).accent, 'ok');
  assert.equal(present.jobs(orphan.jobs(NOW)).accent, 'warn');
  assert.equal(present.jobs(dead.jobs(NOW)).accent, 'error');
});

test('a wedged job is visibly different from a working one, not merely a different number', () => {
  const wedged = statsWith({ running: 1, done: 10 }, runningJob('builder:poll', 3_600_000));
  const busy = statsWith({ running: 1, done: 10 }, runningJob('builder:poll', 4_000));

  const stuckView = present.jobs(new AdminService(recordingAdmin([], wedged), fakeCatalog(), OPTS).jobs(NOW));
  const busyView = present.jobs(new AdminService(recordingAdmin([], busy), fakeCatalog(), OPTS).jobs(NOW));

  assert.equal(stuckView.accent, 'warn', 'the colour is the first thing an operator reads');
  assert.equal(busyView.accent, 'ok');

  const stuckText = viewText(stuckView);
  assert.match(stuckText, /builder:poll/u, 'name the job, or the operator has to guess which one');
  assert.match(stuckText, /1h/u, 'and say how long, because that is the whole answer');
  assert.match(stuckText, /10m/u, 'and against what threshold it was judged');
  assert.match(stuckText, /Past the `10m` stuck mark/u);

  assert.match(viewText(busyView), /Nothing has been running longer than/u);
  assert.ok(!/stuck mark/u.test(viewText(busyView)));
});

test('the jobs card refuses to claim it can see a stuck job when no age came back', () => {
  // The honest branch, kept for exactly the case that still deserves it: something is running
  // and the port reported no age for it.
  const svc = new AdminService(recordingAdmin([], stats({ running: 1 })), fakeCatalog(), OPTS);
  assert.match(
    viewText(present.jobs(svc.jobs(NOW))),
    /Can't tell how long it has run/u,
    'without an age, one sample cannot distinguish a working job from a wedged one',
  );
});

test('an idle queue is not told to run itself twice: there is nothing running to disambiguate', () => {
  const svc = new AdminService(recordingAdmin([], stats({ done: 9 })), fakeCatalog(), OPTS);
  assert.ok(!/Run this twice/u.test(viewText(present.jobs(svc.jobs(NOW)))));
});

test('the jobs card names a quarantined module, because that is what orphaned rows usually mean', () => {
  const catalog = catalogOf([
    { id: 'tags', summary: 'tags', capabilities: ['db'], quarantineReason: 'setup() threw: no migrations' },
    { id: 'help', summary: 'help', capabilities: ['catalog'], quarantineReason: null },
  ]);
  const svc = new AdminService(recordingAdmin([], stats({ orphaned: 2 })), catalog, OPTS);
  const text = viewText(present.jobs(svc.jobs(NOW)));
  assert.match(text, /tags/u);
  assert.match(text, /setup\(\) threw/u);
  assert.ok(!/\bhelp\b/u.test(text), 'a module that installed cleanly is not a finding');
});

test('an untouched install says so rather than rendering six zeros with no explanation', () => {
  const svc = new AdminService(recordingAdmin(), fakeCatalog(), OPTS);
  assert.match(viewText(present.jobs(svc.jobs(NOW))), /Nothing has ever been queued/u);
});

// ---------------------------------------------------------------------------------------
// Paging — the trail no longer stops at twenty rows
// ---------------------------------------------------------------------------------------

test('page 2 is the rows after page 1, and neither page repeats the other', () => {
  const admin = recordingAdmin(rows(25, (i) => ({ action: `builder.a${String(i)}` })));
  const svc = new AdminService(admin, fakeCatalog(), OPTS);

  const first = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: NO_FILTER });
  const second = svc.audit({ guildId: GUILD, page: 2, pageSize: 10, filter: NO_FILTER });

  assert.deepEqual(first.rows.map((r) => r.id), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
  assert.deepEqual(second.rows.map((r) => r.id), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  assert.equal(first.hasMore, true, 'page 1 of 25 rows has a page 2');
  assert.equal(second.hasMore, true);
});

test('an unfiltered page reads only as far as it needs, plus the one row that proves a next page', () => {
  const admin = recordingAdmin(rows(100));
  const svc = new AdminService(admin, fakeCatalog(), OPTS);
  svc.audit({ guildId: GUILD, page: 3, pageSize: 10, filter: NO_FILTER });
  assert.equal(admin.asked.at(-1)?.limit, 31, 'thirty rows to reach the end of page 3, and one to look past it');
});

test('the last page says so instead of offering a next one that is empty', () => {
  const svc = new AdminService(recordingAdmin(rows(12)), fakeCatalog(), OPTS);
  const last = svc.audit({ guildId: GUILD, page: 2, pageSize: 10, filter: NO_FILTER });
  assert.equal(last.rows.length, 2);
  assert.equal(last.hasMore, false);
  assert.ok(!/page:3/u.test(viewText(present.audit(last, NOW))), 'a card must not offer a page that is not there');
});

test('a page past the end is a different sentence from an empty trail', () => {
  const svc = new AdminService(recordingAdmin(rows(12)), fakeCatalog(), OPTS);
  const beyond = svc.audit({ guildId: GUILD, page: 7, pageSize: 10, filter: NO_FILTER });
  const text = viewText(present.audit(beyond, NOW));
  assert.match(text, /past the end/u);
  assert.match(text, /12/u, 'say how many there actually were, so the reader can aim');
  assert.ok(!/No audit rows/u.test(text), '"nothing here" and "not that far" are different facts');
});

test('a page card says where it is, so a screenshot of it is self-describing', async () => {
  const svc = new AdminService(recordingAdmin(rows(25)), fakeCatalog(), OPTS);
  const text = await auditText(svc, { options: { page: 2, limit: 10 } });
  assert.match(text, /Rows `11-20`/u);
  assert.match(text, /page `2`/u);
  assert.match(text, /page:3/u, 'and how to get the next one');
});

test('an unfiltered page does not print a total it never counted', async () => {
  // It read 21 rows to answer "page 2 of 10". Saying "of 21" on a table of thousands would be a
  // made-up number on the one card whose value is that its numbers are real.
  const svc = new AdminService(recordingAdmin(rows(400)), fakeCatalog(), OPTS);
  const text = await auditText(svc, { options: { page: 2, limit: 10 } });
  assert.ok(!/of `21`/u.test(text), 'the rows it happened to read are not the size of the trail');
  assert.ok(!/page `2` of/u.test(text), 'and a page count derived from that would be just as wrong');
});

test('once the end of the trail is in the window, the total is real and is printed', () => {
  // Page 2 asks for twenty-one rows and gets twelve. Coming back short IS the proof that there
  // is nothing older, and it is the only proof this port can offer.
  const svc = new AdminService(recordingAdmin(rows(12)), fakeCatalog(), OPTS);
  const known = svc.audit({ guildId: GUILD, page: 2, pageSize: 10, filter: NO_FILTER });
  assert.equal(known.matchedIsTotal, true);
  assert.match(viewText(present.audit(known, NOW)), /of `12`, page `2` of `2`/u);

  // And page 1 of the same twelve rows read only eleven, so it says where it is and no more.
  const partial = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: NO_FILTER });
  assert.equal(partial.matchedIsTotal, false, 'eleven of eleven came back; there may be a twelfth or a million');
  assert.equal(partial.hasMore, true);
});

test('a filtered page always counts, because it read the whole window to filter it', () => {
  const svc = new AdminService(recordingAdmin(rows(30)), fakeCatalog(), OPTS);
  const counted = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: filter({ action: 'builder' }) });
  assert.equal(counted.matchedIsTotal, true);
  assert.match(viewText(present.audit(counted, NOW)), /of `30`, page `1` of `3`/u);
});

test('the page number is bounded server-side, exactly as the row count is', () => {
  assert.equal(clampPage(0), 1);
  assert.equal(clampPage(-4), 1);
  assert.equal(clampPage(Number.NaN), 1);
  assert.equal(clampPage(2.9), 2);
  assert.equal(clampPage(MAX_AUDIT_PAGE + 500), MAX_AUDIT_PAGE);
});

test('an out-of-range page is reported to the operator, not silently changed', async () => {
  const svc = new AdminService(recordingAdmin([row()]), fakeCatalog(), OPTS);
  const outcome = await command('admin audit', svc).handle(invocation({ options: { page: MAX_AUDIT_PAGE + 1 } }));
  assert.equal(outcome.kind, 'fail', 'a value Discord should have rejected is a validation failure here');
});

// ---------------------------------------------------------------------------------------
// Filtering — "every denial", in one command
// ---------------------------------------------------------------------------------------

test('an action filter matches by prefix, which is how an investigation actually narrows', () => {
  const approve = row({ action: 'builder.approve' });
  const denied = row({ action: 'builder.approve_denied' });
  const grant = row({ action: 'access.grant' });

  assert.equal(matchesFilter(approve, filter({ action: 'builder' })), true);
  assert.equal(matchesFilter(denied, filter({ action: 'builder' })), true);
  assert.equal(matchesFilter(grant, filter({ action: 'builder' })), false);
  assert.equal(matchesFilter(denied, filter({ action: 'builder.approve' })), true, 'a prefix, not equality');
  assert.equal(matchesFilter(approve, filter({ action: 'builder.approve_denied' })), false);
});

test('an actor filter is exact, because a snowflake prefix would be a different person', () => {
  assert.equal(matchesFilter(row({ actorId: OWNER }), filter({ actorId: OWNER })), true);
  assert.equal(matchesFilter(row({ actorId: OWNER }), filter({ actorId: OWNER.slice(0, 10) })), false);
});

test('every denial in one command: the layer filter is the shape of that question', async () => {
  const trail = [
    row({ id: 4, action: 'builder.approve', decisionLayer: 'L1-allowlist' }),
    row({ id: 3, action: 'builder.approve_denied', actorId: NOBODY, decisionLayer: 'L3-deny' }),
    row({ id: 2, action: 'credentials.set_refused', actorId: NOBODY, decisionLayer: 'L3-deny' }),
    row({ id: 1, action: 'tags.set', decisionLayer: null }),
  ];
  const svc = new AdminService(recordingAdmin(trail), fakeCatalog(), OPTS);

  const denials = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: filter({ layer: 'L3-deny' }) });
  assert.deepEqual(denials.rows.map((r) => r.id), [3, 2], 'two refusals, from two different modules');
  assert.equal(denials.matched, 2);

  const text = await auditText(svc, { options: { layer: 'L3-deny' } });
  assert.match(text, /Filtered to layer `L3-deny`/u, 'the card must say what it narrowed to');
});

test('`none` is a layer choice, because a row with no decision is a real thing to look for', () => {
  const fact = row({ decisionLayer: null });
  const decision = row({ decisionLayer: 'L2-fallback' });
  assert.equal(matchesFilter(fact, filter({ layer: NO_LAYER_FILTER })), true);
  assert.equal(matchesFilter(decision, filter({ layer: NO_LAYER_FILTER })), false);
  assert.deepEqual([...LAYER_CHOICES], ['L0-owner', 'L1-allowlist', 'L2-fallback', 'L3-deny', 'none']);
});

test('the layer option offers exactly the layers the handler will accept', () => {
  const svc = new AdminService(recordingAdmin(), fakeCatalog(), OPTS);
  const layer = command('admin audit', svc).options.find((o) => o.name === 'layer');
  assert.ok(layer !== undefined);
  assert.deepEqual(layer?.choices, [...LAYER_CHOICES], 'the offered list and the allow-list must be one list');
});

test('a layer Discord never offered is refused server-side, because Discord permits sending one', async () => {
  const svc = new AdminService(recordingAdmin([row()]), fakeCatalog(), OPTS);
  const outcome = await command('admin audit', svc).handle(invocation({ options: { layer: 'L9-superuser' } }));
  assert.equal(outcome.kind, 'fail', 'SC-11: the allow-list the handler will accept is the only one that counts');
});

test('filters compose, and all three together narrow to one row', () => {
  const trail = [
    row({ id: 3, action: 'builder.approve_denied', actorId: NOBODY, decisionLayer: 'L3-deny' }),
    row({ id: 2, action: 'builder.approve_denied', actorId: OWNER, decisionLayer: 'L3-deny' }),
    row({ id: 1, action: 'access.grant', actorId: NOBODY, decisionLayer: 'L3-deny' }),
  ];
  const svc = new AdminService(recordingAdmin(trail), fakeCatalog(), OPTS);
  const narrowed = svc.audit({
    guildId: GUILD,
    page: 1,
    pageSize: 10,
    filter: { action: 'builder', actorId: NOBODY, layer: 'L3-deny' },
  });
  assert.deepEqual(narrowed.rows.map((r) => r.id), [3]);
});

test('a filtered question reads the whole window, because the port cannot narrow for us', () => {
  const admin = recordingAdmin(rows(30));
  const svc = new AdminService(admin, fakeCatalog(), OPTS);
  svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: filter({ action: 'builder' }) });
  assert.equal(admin.asked.at(-1)?.limit, MAX_AUDIT_SCAN, 'a match can be anywhere in the window');
});

test('an answer that filled its window says so, rather than implying it read the table', () => {
  const admin = recordingAdmin(rows(MAX_AUDIT_SCAN, (i) => ({ atMs: NOW - i * 3_600_000 })));
  const svc = new AdminService(admin, fakeCatalog(), OPTS);
  const full = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: filter({ action: 'builder' }) });
  assert.equal(full.windowFull, true);

  const text = viewText(present.audit(full, NOW));
  assert.match(text, /Only the newest `500` rows/u);
  assert.match(text, /were searched/u, 'the limit of the answer is part of the answer');
  assert.match(text, /back to `20d` ago/u, 'and how far back it reached, which is what "last week" needs');
});

test('a short trail does not pretend to have hit a limit it never reached', () => {
  const svc = new AdminService(recordingAdmin(rows(3)), fakeCatalog(), OPTS);
  const small = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: filter({ action: 'builder' }) });
  assert.equal(small.windowFull, false);
  assert.ok(!/Searched the newest/u.test(viewText(present.audit(small, NOW))));
});

test('a filter that matches nothing says what IS in the window, so the next guess is informed', () => {
  const trail = [row({ action: 'builder.approve' }), row({ id: 2, action: 'access.grant' })];
  const svc = new AdminService(recordingAdmin(trail), fakeCatalog(), OPTS);
  const none = svc.audit({ guildId: GUILD, page: 1, pageSize: 10, filter: filter({ action: 'tags' }) });
  const text = viewText(present.audit(none, NOW));

  assert.match(text, /No audit row for `this server` matched/u);
  assert.match(text, /access\.grant/u, 'listing what is there separates a wrong needle from a quiet server');
  assert.match(text, /builder\.approve/u);
  assert.ok(!/No audit rows/u.test(text), 'an empty trail and an unmatched filter are different answers');
});

// ---------------------------------------------------------------------------------------
// The `limit` option
// ---------------------------------------------------------------------------------------

test('an omitted limit uses the configured default, not a validation error', async () => {
  const admin = recordingAdmin([row()]);
  const installed = install(admin, fakeCatalog(), { auditRows: 7 });
  const audit = installed.commands.find((c) => c.name === 'admin audit');
  assert.ok(audit !== undefined);
  if (audit === undefined) return;

  const outcome = await audit.handle(invocation());
  assert.equal(outcome.kind, 'view', 'an absent optional option is not a user error');
  assert.equal(admin.asked.at(-1)?.limit, 8, 'seven rows for page 1, plus the one that proves a page 2');
});

test('a limit is bounded server-side, because the command payload is not a bound', () => {
  assert.equal(clampRows(MAX_AUDIT_ROWS + 500, DEFAULT_AUDIT_ROWS), MAX_AUDIT_ROWS);
  assert.equal(clampRows(0, DEFAULT_AUDIT_ROWS), 1);
  assert.equal(clampRows(-3, DEFAULT_AUDIT_ROWS), 1);
  assert.equal(clampRows(Number.NaN, DEFAULT_AUDIT_ROWS), DEFAULT_AUDIT_ROWS);
  assert.equal(clampRows(4.9, DEFAULT_AUDIT_ROWS), 4);
});

test('a configured default outside the bounds is clamped rather than trusted', () => {
  const admin = recordingAdmin([row()]);
  const svc = new AdminService(admin, fakeCatalog(), opts({ defaultRows: 10_000 }));
  svc.audit({ guildId: GUILD, page: 1, pageSize: svc.defaultAuditRows, filter: NO_FILTER });
  assert.equal(admin.asked.at(-1)?.limit, MAX_AUDIT_ROWS + 1);
});

test('an out-of-range limit is reported to the operator, not silently changed', async () => {
  const svc = new AdminService(recordingAdmin([row()]), fakeCatalog(), OPTS);
  const outcome = await command('admin audit', svc).handle(invocation({ options: { limit: MAX_AUDIT_ROWS + 1 } }));
  assert.equal(outcome.kind, 'fail', 'a value Discord should have rejected is a validation failure here');
});

// ---------------------------------------------------------------------------------------
// The audit card
// ---------------------------------------------------------------------------------------

test('an empty trail explains what would put a row there', () => {
  const view = present.audit(auditPage({ rows: [], matched: 0 }), NOW);
  const text = viewText(view);
  assert.match(text, /No audit rows/u);
  assert.match(text, /approval/u, 'an empty state that does not say what fills it is a dead end');
});

test('the card says whether it is showing one server or all of them', () => {
  assert.match(viewText(present.audit(auditPage({ rows: [row()] }), NOW)), /this server/u);
  assert.match(viewText(present.audit(auditPage({ rows: [row()], guildId: null }), NOW)), /every server/u);
});

test('the actor is the raw id, because that is what /access grant needs', () => {
  const view = present.audit(auditPage({ rows: [row({ actorId: MANAGER })] }), NOW);
  assert.match(viewText(view), new RegExp(MANAGER, 'u'));
});

// ---------------------------------------------------------------------------------------
// The manifest itself — every decision that is an omission somewhere else
// ---------------------------------------------------------------------------------------

test('every entry point declares its permission, its limits and its bot permissions', () => {
  const installed = install(recordingAdmin());
  assert.equal(installed.commands.length, 2, '/admin jobs and /admin audit');
  for (const c of installed.commands) {
    assert.equal(c.permission.moduleId, 'admin', `${c.name} must gate on this module's own key`);
    assert.equal(c.permission.key, 'view');
    assert.ok(c.limit.length > 0, `${c.name} must spend a bucket; NO_LIMIT would be a decision, not an omission`);
    assert.deepEqual(c.needs, [], `${c.name} replies ephemerally, so it needs no channel permission`);
    assert.equal(c.ack, 'defer-ephemeral', `${c.name} reads SQLite, so it cannot answer instantly`);
  }
});

test('the module declares no actions, forms, hooks or jobs — it can only be asked', () => {
  const installed = install(recordingAdmin());
  assert.deepEqual(installed.actions, []);
  assert.deepEqual(installed.forms, []);
  assert.deepEqual(installed.hooks, []);
  assert.deepEqual(installed.jobs, []);
  assert.deepEqual(installed.selects, []);
});

test('paging carries no state, because there is no component to carry it', () => {
  // The pager is `page:`, an argument. A button would have had to fit the whole query into one
  // 40-character `custom_id` segment, which an actor snowflake and an action prefix already
  // exceed together — so the choice was a pager that keeps your filter or one that quietly
  // drops it. See note (6) in present.ts.
  const installed = install(recordingAdmin());
  assert.deepEqual(installed.actions, [], 'no ActionSpec means no click can be stale, mis-scoped or lost');
  const audit = installed.commands.find((c) => c.name === 'admin audit');
  assert.ok(audit?.options.some((o) => o.name === 'page'), 'the pager is an option, and it is declared');
});

test('every preview compiles through the real renderer, which is what boot does', () => {
  const installed = install(recordingAdmin());
  const names = Object.keys(installed.previews);
  assert.ok(names.length >= 8, 'the previews are the boot-time proof that these cards render');
  for (const [name, view] of Object.entries(installed.previews)) {
    const rendered = renderView(view);
    assert.ok(rendered.ok, rendered.ok ? '' : `preview "${name}" does not render: ${rendered.error.kind}`);
  }
});

test('the previews cover the shapes an incident produces, not only the quiet one', () => {
  const installed = install(recordingAdmin());
  for (const name of ['jobsWedged', 'auditPaged', 'auditFiltered', 'auditNoMatch']) {
    assert.ok(name in installed.previews, `boot must compile the "${name}" card too`);
  }
  assert.equal(installed.previews['jobsWedged']?.accent, 'warn', 'and the wedged one must read as wedged');
});

test('the module id equals its folder name, which is also its table prefix', () => {
  assert.equal(adminModule.manifest.id, 'admin');
  assert.equal(adminModule.manifest.migrations, false, 'this module owns no table; it only reads core ones');
});

test('the one text option is the action filter, and it answers no autocomplete', () => {
  // WHY AUTOCOMPLETE IS ABSENT AND WORTH A TEST: the router answers an autocomplete WITHOUT
  // checking the command's permission. A handler suggesting the actions present in this guild's
  // audit log would therefore be an ungated read of the table this whole command is gated on.
  const svc = new AdminService(recordingAdmin(), fakeCatalog(), OPTS);
  for (const c of adminCommands(svc, { view: permissionRef('admin', 'view') })) {
    assert.equal(c.autocomplete, undefined, `${c.name} must not answer autocomplete`);
    for (const o of c.options) {
      if (o.type === 'text') {
        assert.ok(
          o.name === 'action' || o.choices !== undefined,
          `${c.name} declares a free text option "${o.name}"; only a validated or chosen one belongs here`,
        );
      }
      assert.notEqual(o.autocomplete, true, 'autocomplete here would be an ungated read of the audit table');
    }
  }
  // And the wrapper the router would have used is exercised here so the import cannot rot away.
  assert.equal(typeof wrapUserText('x', 'command-option'), 'object');
});

// ---------------------------------------------------------------------------------------
// THE SEAM BETWEEN THIS MODULE AND THE PORT IT DOES NOT OWN
//
// EVERY OTHER TEST IN THIS FILE HANDS THE MODULE A `JobStats` LITERAL, which means every other
// test in this file agrees with itself about the shape. That is exactly how the two halves of
// this round were first written and exactly how they failed to meet: `#core/ports` shipped
// `RunningJob` as `{ moduleId, type, startedAtMs }` and this module read `.name` and `.ageMs`
// off it, so `readOldestRunning` answered "nothing is running" for every wedged job in
// production while both sides' suites stayed green. The TYPE system caught it here — but only
// because the field was required; had it stayed optional, or had the names merely overlapped,
// nothing would have.
//
// So this test builds no fixture. It runs a real job on the real durable-job runner, leaves it
// running, and asks the SHIPPED module's `health()` what it thinks — the whole path an operator
// depends on, with nobody's fixture in the middle.
// ---------------------------------------------------------------------------------------

test('a really-wedged job on the REAL runner degrades the REAL module health, end to end', async () => {
  const db = createTestDb();
  const clock = manualClock();
  const logger = silentLogger();
  const jobs = createJobSystem({ db, clock, logger });

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  jobs.registerJobs(
    new Map([
      [
        'builder:build',
        {
          moduleId: 'builder',
          type: 'build',
          maxAttempts: 3,
          deadlineMs: 6 * 3_600_000,
          backoff: { initialMs: 1_000, factor: 2, maxMs: 10_000, jitter: 0 },
          needs: [],
          schedule: null,
          run: async () => {
            await held;
            return { kind: 'done' as const };
          },
          onDead: async () => undefined,
          onUnparseable: async () => undefined,
        },
      ],
    ]),
  );

  // The composition root's own wiring, copied because that is the thing under test.
  const admin: AdminPort = { recentAudit: () => [], jobStats: () => jobs.stats() };
  const installed = install(admin);

  const startedAt = clock.now();
  const enqueued = jobs.portFor('builder').enqueue({
    type: 'build',
    payload: {},
    runAfterMs: startedAt,
    deadlineAtMs: startedAt + 6 * 3_600_000,
    dedupeKey: 'rq_seam',
  });
  assert.ok(enqueued.ok);
  await jobs.tick();

  // Four seconds in, this is an ordinary build and `/status` must not cry wolf.
  clock.advance(4_000);
  assert.equal((await installed.health()).status, 'ok', 'a job that just started is not a finding');

  // Three days in, it is the thing an operator came looking for. `health()` is called with NO
  // time argument and this module declares no `clock` capability — so this assertion is only
  // reachable because the port reports a DURATION, which is the entire negotiation this seam
  // settled. A port that reported only `startedAtMs` would render the fact on the card and
  // leave `/status` saying `ok` forever.
  clock.advance(3 * 24 * 3_600_000);
  const wedged = await installed.health();
  assert.equal(wedged.status, 'degraded', '`/status` saying `ok` over a three-day job is the defect this round exists to remove');
  assert.match(wedged.detail, /builder:build/u, 'and it names the job, which is the difference between a signal and an alarm');
  assert.match(wedged.detail, /3d/u);

  release();
  await jobs.drain();
  assert.equal((await installed.health()).status, 'ok', 'and it clears when the job finishes');
});

test('the actor column shows a short label, and the label maps to a real mention under the table', () => {
  // A mention cannot render inside the code-fenced table, so the raw snowflake was all anyone saw.
  const other = '222222222222222222';
  const rows = [row({ actorId: OWNER }), row({ id: 2, actorId: other }), row({ id: 3, actorId: OWNER })];
  const labels = actorLabels(rows);
  assert.deepEqual([...labels.values()], ['A', 'B'], 'first-seen order, one label per person');
  assert.equal(auditRowCells(rows[1] ?? row(), NOW, labels.get(other))[AUDIT_COLUMNS.indexOf('actor')], 'B');
});
