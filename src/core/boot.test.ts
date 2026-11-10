/**
 * Runtime proof that the boot-time guarantees are real, not just typed.
 *
 * The type system says a module cannot NAME an undeclared port. These tests say the object it
 * actually receives does not CONTAIN one - which is what turns the "someone widened the
 * capability tuple" hole from a silent capability escape into a `TypeError`, and it is the one
 * thing the earlier designs asserted and did not do.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import { defineModule, type ModuleDescriptor } from '#core/module';
import { buildRegistry, buildCatalog, describeProblem, loadModules, orphanedJobKeys } from '#core/registry';
import { createEventBus } from '#core/events';
import { PUBLIC } from '#core/policy';
import { NO_LIMIT } from '#core/ratelimit';
import { checkTableOwnership, ident, renderSql, sql, tablePrefixFor } from '#core/sql';
import { assertOwnership, planMigrations } from '#core/migrate';
import { missingPermissions, permissionInteger, PERMISSION_BITS } from '#core/permissions';
import { fakeAudit, fakeCatalog, fakeClock, fakeDb, fakeLogger, fakePortsOnly } from '#testing/fakes';
import type { InstalledModule } from '#core/module';

const bus = createEventBus(() => undefined);
const logger = fakeLogger();

function io(prefix = 'm_probe_') {
  return { ports: fakePortsOnly(prefix, ['db', 'audit', 'clock', 'catalog']), rawConfig: {}, bus, logger };
}

// ---------------------------------------------------------------------------------------
// Capability narrowing, at RUNTIME
// ---------------------------------------------------------------------------------------

test('ctx.ports contains exactly the declared capabilities, and nothing else', () => {
  let seen: readonly string[] = [];
  const m = defineModule({
    id: 'narrow',
    summary: 'x',
    capabilities: ['db', 'audit'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup(ctx) {
      seen = Object.keys(ctx.ports).sort();
      return {
        commands: [],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
  const r = m.install(io());
  assert.ok(r.ok, 'install must succeed');
  assert.deepEqual(seen, ['audit', 'db'], 'clock and catalog were wired but not declared');
});

test('a declared-but-unwired capability fails the module at boot, naming it', () => {
  const m = defineModule({
    id: 'greedy',
    summary: 'x',
    capabilities: ['db', 'builds'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
  const r = m.install(io());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error.internal ?? '', /builds/u);
});

test('a module that throws in setup is quarantined, not fatal', () => {
  const bad = defineModule({
    id: 'explodes',
    summary: 'x',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      throw new Error('boom');
    },
  });
  const r = bad.install(io());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error.internal ?? '', /setup\(\) threw: boom/u);
});

// ---------------------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------------------

/**
 * WHY `const Id`: `publishes` is typed `PublishSchemas<Id>`, which requires a zod schema for
 * every event named `<id>.*`. That is the guarantee that makes a declared-but-unschema'd event
 * a compile error - and it FAILS CLOSED: if `Id` widens to `string`, every event in the app
 * becomes required and `publishes: {}` stops compiling. A module id must therefore be a
 * literal, which it always is in a real module folder.
 */
function moduleWithCommand<const Id extends string>(id: Id, name: string): ModuleDescriptor {
  return defineModule({
    id,
    summary: 'x',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [
          {
            name,
            description: 'd',
            surface: 'guild',
            options: [],
            permission: PUBLIC,
            limit: NO_LIMIT,
            needs: [],
            ack: 'instant',
            async handle() {
              return { kind: 'silent' };
            },
          },
        ],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
}

function install(d: ModuleDescriptor): InstalledModule {
  const r = d.install(io());
  if (!r.ok) throw new Error(`install failed: ${r.error.internal ?? r.error.code}`);
  return r.value;
}

test('a duplicate command name is fatal and names BOTH modules', () => {
  const r = buildRegistry([install(moduleWithCommand('dup-a', 'ping')), install(moduleWithCommand('dup-b', 'ping'))]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  const line = r.error.map(describeProblem).join('\n');
  assert.match(line, /dup-a/u);
  assert.match(line, /dup-b/u);
  assert.match(line, /rename one/u);
});

test('a permission a module does not declare is refused, on every surface', () => {
  const thief = defineModule({
    id: 'thief',
    summary: 'x',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      // A ref for another module's key, obtained by importing the loader-only minter. The
      // type system cannot stop this; the registry does.
      const foreign = foreignRef();
      return {
        commands: [
          {
            name: 'steal',
            description: 'd',
            surface: 'guild',
            options: [],
            permission: foreign,
            limit: NO_LIMIT,
            needs: [],
            ack: 'instant',
            async handle() {
              return { kind: 'silent' };
            },
          },
        ],
        actions: [
          {
            name: 'approve',
            permission: foreign,
            limit: NO_LIMIT,
            needs: [],
            ack: 'defer-update',
            idempotency: { kind: 'naturally-idempotent', why: 'probe' },
            async handle() {
              return { kind: 'silent' };
            },
          },
        ],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
  const r = buildRegistry([install(thief)]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  const kinds = r.error.filter((p) => p.kind === 'undeclared-permission');
  assert.equal(kinds.length, 2, 'both the command and the ACTION must be checked');
});

test('two modules cannot both own $request, and a shadowing prefix is refused too', () => {
  const hook = <const Id extends string>(id: Id, prefix: string): ModuleDescriptor =>
    defineModule({
      id,
      summary: 'x',
      capabilities: ['clock'],
      config: z.object({}),
      permissions: {},
      publishes: {},
      migrations: false,
      setup() {
        return {
          commands: [],
          hooks: [
            {
              source: 'message',
              prefix,
              permission: PUBLIC,
              limit: NO_LIMIT,
              needs: [],
              async handle() {
                return { kind: 'silent' };
              },
            },
          ],
          async health() {
            return { status: 'ok', detail: '' };
          },
        };
      },
    });

  const same = buildRegistry([install(hook('h-a', '$request')), install(hook('h-b', '$request'))]);
  assert.equal(same.ok, false);

  const shadow = buildRegistry([install(hook('h-c', '$request')), install(hook('h-d', '$req'))]);
  assert.equal(shadow.ok, false);
  if (shadow.ok) return;
  assert.ok(shadow.error.some((p) => p.kind === 'shadowing-prefix'));
});

test('an autocomplete option with no handler is a boot failure', () => {
  const m = defineModule({
    id: 'ac',
    summary: 'x',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [
          {
            name: 'thing',
            description: 'd',
            surface: 'guild',
            options: [{ name: 'name', description: 'd', type: 'text', required: true, autocomplete: true }],
            permission: PUBLIC,
            limit: NO_LIMIT,
            needs: [],
            ack: 'defer',
            async handle() {
              return { kind: 'silent' };
            },
          },
        ],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
  const r = buildRegistry([install(m)]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.error.some((p) => p.kind === 'missing-autocomplete'));
});

test('an action whose name cannot fit a live custom_id is refused at BOOT', () => {
  const m = defineModule({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    summary: 'x',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [],
        actions: [
          {
            name: 'approve-this-request-right-now-please-x',
            permission: PUBLIC,
            limit: NO_LIMIT,
            needs: [],
            ack: 'defer-update',
            idempotency: { kind: 'naturally-idempotent', why: 'probe' },
            async handle() {
              return { kind: 'silent' };
            },
          },
        ],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
  const r = buildRegistry([install(m)]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.error.some((p) => p.kind === 'custom-id-budget'));
});

test('loadModules quarantines one bad module and still boots the rest', () => {
  const good = moduleWithCommand('good', 'ping');
  const bad = defineModule({
    id: 'bad',
    summary: 'x',
    capabilities: ['builds'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [],
        async health() {
          return { status: 'ok', detail: '' };
        },
      };
    },
  });
  const r = loadModules(
    [
      { source: 'src/modules/good/module.ts', descriptor: good },
      { source: 'src/modules/bad/module.ts', descriptor: bad },
    ],
    { ports: fakePortsOnly('m_probe_', ['db', 'audit', 'clock', 'catalog']), bus, logger, configFor: () => ({}), disabled: new Set() },
  );
  assert.ok(r.ok, 'a broken module must not take the boot down');
  if (!r.ok) return;
  assert.equal(r.value.quarantined.length, 1);
  assert.equal(r.value.quarantined[0]?.moduleId, 'bad');
  assert.ok(r.value.registry.commands.has('ping'), 'the healthy module still registered');
});

test('the catalog renders the registry, quarantines included, with a health deadline', async () => {
  const slow = defineModule({
    id: 'slow',
    summary: 'never answers',
    capabilities: ['clock'],
    config: z.object({}),
    permissions: {},
    publishes: {},
    migrations: false,
    setup() {
      return {
        commands: [],
        health() {
          return new Promise(() => undefined);
        },
      };
    },
  });
  const r = loadModules(
    [
      { source: 'a', descriptor: moduleWithCommand('good2', 'pong') },
      { source: 'b', descriptor: slow },
      { source: 'c', descriptor: defineModule({ id: 'dead', summary: 'x', capabilities: ['builds'], config: z.object({}), permissions: {}, publishes: {}, migrations: false, setup: () => ({ commands: [], health: async () => ({ status: 'ok', detail: '' }) }) }) },
    ],
    { ports: fakePortsOnly('m_probe_', ['db', 'audit', 'clock', 'catalog']), bus, logger, configFor: () => ({}), disabled: new Set() },
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  const catalog = buildCatalog(r.value, 25);
  assert.ok(catalog.commands().some((c) => c.name === 'pong'));
  assert.ok(catalog.modules().some((m) => m.id === 'dead' && m.quarantineReason !== null));
  const health = await catalog.health();
  const slowRow = health.find((h) => h.moduleId === 'slow');
  assert.equal(slowRow?.status, 'down');
  assert.equal(slowRow?.detail, 'health check timed out');
});

test('an orphaned job type is reported rather than silently dropped', () => {
  const r = buildRegistry([install(moduleWithCommand('orph', 'x'))]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(orphanedJobKeys(r.value, ['gone:build', 'gone:build']), ['gone:build']);
});

// ---------------------------------------------------------------------------------------
// SQL ownership - the bounded `db` capability
// ---------------------------------------------------------------------------------------

test('the sql tag binds values and splices only minted identifiers', () => {
  const t = ident('m_tags_tags');
  const q = sql`SELECT * FROM ${t} WHERE name = ${'evil\x27); DROP TABLE x; --'}`;
  const { text, params } = renderSql(q);
  assert.equal(text, 'SELECT * FROM m_tags_tags WHERE name = ?');
  assert.deepEqual(params, ['evil\x27); DROP TABLE x; --']);
});

test('ident refuses anything that is not a bare identifier', () => {
  assert.throws(() => ident('name) OR 1=1 --'));
  assert.throws(() => ident('m_tags_tags; DROP TABLE x'));
  assert.throws(() => ident(''));
});

test('a module holding `db` cannot reach core_access or another module tables', () => {
  const prefix = tablePrefixFor('tags');
  assert.equal(prefix, 'm_tags_');

  const own = checkTableOwnership(sql`SELECT * FROM ${ident('m_tags_tags')}`, prefix);
  assert.ok(own.ok, 'its own table is allowed');

  const escalate = checkTableOwnership(
    sql`INSERT INTO ${ident('core_access')} (guild_id) VALUES (${'1'})`,
    prefix,
  );
  assert.equal(escalate.ok, false, 'core_access must be refused');

  const foreign = checkTableOwnership(sql`SELECT body FROM ${ident('m_builder_requests')}`, prefix);
  assert.equal(foreign.ok, false, 'another module table must be refused');

  const ddl = checkTableOwnership(sql`DROP TABLE ${ident('core_audit')}`, prefix);
  assert.equal(ddl.ok, false, 'DDL must be refused outright');

  const core = checkTableOwnership(sql`SELECT * FROM ${ident('core_audit')}`, prefix, { allowCore: true });
  assert.ok(core.ok, 'the core-owned ports may touch core_*');
});

test('an UPSERT on the module own table is allowed — "DO UPDATE SET" is not a table called "set"', () => {
  // THE BUG THIS PINS DOWN: TABLE_REF matches `UPDATE\s+<name>`, and SQLite's upsert is
  // `INSERT ... ON CONFLICT (...) DO UPDATE SET col = excluded.col`. So "set" was recorded as a
  // referenced table, did not start with the module prefix, and EVERY upsert was refused —
  // including the one in the `tags` exemplar AGENTS.md tells contributors to copy, and the one
  // the scaffolder generates. The guard meant to bound a module's reach was blocking its own
  // table. The old test only ever exercised SELECT, which is why it survived.
  const prefix = tablePrefixFor('tags');

  const upsert = checkTableOwnership(
    sql`
      INSERT INTO ${ident('m_tags_tags')} (guild_id, name, body) VALUES (${'g'}, ${'n'}, ${'b'})
      ON CONFLICT (guild_id, name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    prefix,
  );
  assert.ok(upsert.ok, 'a module must be able to upsert into its own table');
});

test('the SET exemption does not open a hole: an upsert into a FOREIGN table is still refused', () => {
  const prefix = tablePrefixFor('tags');

  const foreignUpsert = checkTableOwnership(
    sql`
      INSERT INTO ${ident('core_access')} (guild_id, role_id) VALUES (${'g'}, ${'r'})
      ON CONFLICT (guild_id) DO UPDATE SET role_id = excluded.role_id`,
    prefix,
  );
  assert.equal(foreignUpsert.ok, false, 'the target table is still checked; only the SET keyword is skipped');

  const otherModuleUpsert = checkTableOwnership(
    sql`INSERT INTO ${ident('m_builder_requests')} (id) VALUES (${'x'}) ON CONFLICT (id) DO UPDATE SET state = ${'done'}`,
    prefix,
  );
  assert.equal(otherModuleUpsert.ok, false, 'another module table stays unreachable through an upsert too');
});

test('a plain UPDATE still has its table checked', () => {
  const prefix = tablePrefixFor('tags');

  assert.ok(
    checkTableOwnership(sql`UPDATE ${ident('m_tags_tags')} SET body = ${'x'}`, prefix).ok,
    'own table',
  );
  assert.equal(
    checkTableOwnership(sql`UPDATE ${ident('core_jobs')} SET state = ${'queued'}`, prefix).ok,
    false,
    'UPDATE <foreign> SET must still be refused — the exemption is the NAME "set", not the verb',
  );
});

// ---------------------------------------------------------------------------------------
// Migrations and permissions
// ---------------------------------------------------------------------------------------

test('an edited applied migration aborts the boot', () => {
  const files = [{ name: '0001_init.sql', sha256: 'bbb', sql: 'CREATE TABLE m_tags_tags (x)' }];
  const applied = [{ moduleId: 'tags', name: '0001_init.sql', sha256: 'aaa', appliedAt: 0 }];
  const r = planMigrations('tags', files, applied);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error.internal ?? '', /checksum changed/u);
});

test('a migration that creates an object outside its namespace is refused', () => {
  const ok = assertOwnership('tags', 'm_tags_', ['core_meta'], ['core_meta', 'm_tags_tags']);
  assert.ok(ok.ok);
  const bad = assertOwnership('tags', 'm_tags_', ['core_meta'], ['core_meta', 'tags']);
  assert.equal(bad.ok, false);
});

test('the Discord permission bits are the real ones', () => {
  // The exact defect one earlier design shipped: CreatePublicThreads set to ManageThreads.
  assert.notEqual(PERMISSION_BITS.CreatePublicThreads, PERMISSION_BITS.ManageThreads);
  assert.equal(PERMISSION_BITS.CreatePublicThreads, 1n << 35n);
  assert.equal(PERMISSION_BITS.ManageThreads, 1n << 34n);

  const granted = PERMISSION_BITS.ViewChannel | PERMISSION_BITS.SendMessages;
  assert.deepEqual(missingPermissions(granted, ['ViewChannel', 'SendMessages']), []);
  assert.deepEqual(missingPermissions(granted, ['SendMessages', 'EmbedLinks']), ['EmbedLinks']);
  assert.equal(permissionInteger(['ViewChannel', 'SendMessages']), granted);
});

// ---------------------------------------------------------------------------------------
// The event bus
// ---------------------------------------------------------------------------------------

test('a throwing subscriber cannot take the publisher down', () => {
  const failures: string[] = [];
  const b = createEventBus((f) => void failures.push(f.event));
  b.on('core.module_ready', () => {
    throw new Error('subscriber exploded');
  });
  let delivered = 0;
  b.on('core.module_ready', () => {
    delivered += 1;
  });
  b.emit('core.module_ready', { moduleId: 'x', at: 0 });
  assert.equal(delivered, 1, 'the second subscriber still ran');
  assert.deepEqual(failures, ['core.module_ready']);
});

test('unsubscribe actually unsubscribes, and once fires once', () => {
  const b = createEventBus(() => undefined);
  let n = 0;
  const off = b.on('core.module_ready', () => {
    n += 1;
  });
  b.emit('core.module_ready', { moduleId: 'x', at: 0 });
  off();
  b.emit('core.module_ready', { moduleId: 'x', at: 0 });
  assert.equal(n, 1);

  let m = 0;
  b.once('core.module_ready', () => {
    m += 1;
  });
  b.emit('core.module_ready', { moduleId: 'x', at: 0 });
  b.emit('core.module_ready', { moduleId: 'x', at: 0 });
  assert.equal(m, 1);
});

// ---------------------------------------------------------------------------------------
// Fakes are honest
// ---------------------------------------------------------------------------------------

test('the in-memory fakes satisfy the ports with no adapter imports', () => {
  const db = fakeDb('m_probe_');
  db.query(sql`SELECT 1 FROM ${db.table('t')}`);
  assert.equal(db.statements.length, 1);
  assert.match(db.statements[0] ?? '', /m_probe_t/u);

  const audit = fakeAudit();
  audit.record({ action: 'probe.x', actorId: '1', guildId: null, detail: { ok: true } });
  assert.equal(audit.entries.length, 1);

  const clock = fakeClock(1000);
  assert.equal(clock.now(), 1000);
  clock.set(2000);
  assert.equal(clock.now(), 2000);

  assert.deepEqual(fakeCatalog().commands(), []);
});

/** WHY it is a separate function: it is the one thing the type system genuinely cannot stop,
 *  so the test has to do it deliberately to prove the registry catches it. */
function foreignRef(): import('#core/policy').PermissionRef {
  return permissionRefFromLoader('builder', 'approve');
}

import { permissionRef as permissionRefFromLoader } from '#core/policy';
