/**
 * The golden path, part 5: the test. `npm test` runs it; `npm run check` is not green without it.
 *
 * Two layers, the same split the module itself makes:
 *  - `TagService` is pure logic over a `TagsRepo`, so most behaviour is tested against an
 *    in-memory repo with plain values - no SQL, no Discord, no clock;
 *  - the manifest is tested by INSTALLING the module the way the bot does, with the engine's
 *    fake ports, which proves the declared capabilities, permissions and commands line up.
 *
 * Test BEHAVIOUR, not shape: "set returns a tag" is worthless; "a second set of the same name
 * replaces it instead of counting against the limit" is the thing that would actually break.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createEventBus } from '#core/events';
import { tablePrefixFor } from '#core/sql';
import { userTextForTest } from '#core/text';
import { fakeAudit, fakeLogger, fakePorts } from '#testing/fakes';

import tagsModule from '#modules/tags/module';
import { TagService, type TagsConfig } from '#modules/tags/domain';
import type { Tag, TagsRepo } from '#modules/tags/repo';

const NOW = 1_700_000_000_000;
const GUILD = '400000000000000001';
const AUTHOR = '200000000000000001';

/** A `TagsRepo` over a Map: the contract `repo.ts` implements in SQL, without the SQL. */
function memoryRepo(): TagsRepo {
  const rows = new Map<string, Tag>();
  const inGuild = (g: string): Tag[] =>
    [...rows.entries()]
      .filter(([k]) => k.startsWith(`${g}/`))
      .map(([, t]) => t)
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    get: (g, n) => rows.get(`${g}/${n}`),
    upsert: (g, n, body, by) => {
      const tag = { name: n, body, authorId: by };
      rows.set(`${g}/${n}`, tag);
      return tag;
    },
    list: (g, limit) => inGuild(g).slice(0, limit),
    count: (g) => inGuild(g).length,
    countAll: () => rows.size,
  };
}

function service(cfg: TagsConfig = { maxPerGuild: 200, maxLength: 2000 }) {
  const audit = fakeAudit();
  return { svc: new TagService(memoryRepo(), audit, cfg), audit };
}

test('set slugs the name, keeps the body, and audits the slug - never the raw user text', () => {
  const { svc, audit } = service();
  const r = svc.set(GUILD, userTextForTest('Deploy Notes!'), userTextForTest('Run `npm run check` first.'), AUTHOR, NOW);

  assert.ok(r.ok, 'a normal name and body must be accepted');
  if (!r.ok) return;
  assert.equal(r.value.name, 'deploy-notes');
  assert.equal(r.value.authorId, AUTHOR);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0]?.action, 'tags.set');
  assert.equal(audit.entries[0]?.detail['name'], 'deploy-notes');
});

test('get finds a saved tag by any spelling of its name, and a missing one says how to look', () => {
  const { svc } = service();
  assert.ok(svc.set(GUILD, userTextForTest('deploy notes'), userTextForTest('body'), AUTHOR, NOW).ok);

  const found = svc.get(GUILD, userTextForTest('Deploy-Notes'));
  assert.ok(found.ok, 'the lookup slugs the name exactly as set did');

  const missing = svc.get(GUILD, userTextForTest('nope'));
  assert.ok(!missing.ok);
  if (missing.ok) return;
  assert.equal(missing.error.kind, 'not-found');
  assert.match(missing.error.nextStep, /\/tag get/u, 'the next step names the command that lists tags');

  const otherGuild = svc.get('400000000000000002', userTextForTest('deploy notes'));
  assert.ok(!otherGuild.ok, 'tags are per guild');
});

test('a full guild refuses a NEW tag, but replacing an existing one still works', () => {
  const { svc } = service({ maxPerGuild: 1, maxLength: 2000 });
  assert.ok(svc.set(GUILD, userTextForTest('one'), userTextForTest('first'), AUTHOR, NOW).ok);

  const second = svc.set(GUILD, userTextForTest('two'), userTextForTest('second'), AUTHOR, NOW);
  assert.ok(!second.ok, 'the limit applies to new names');
  if (!second.ok) assert.equal(second.error.kind, 'conflict');

  const replaced = svc.set(GUILD, userTextForTest('one'), userTextForTest('updated'), AUTHOR, NOW);
  assert.ok(replaced.ok, 'an existing name is a replacement, not a new tag');
  assert.equal(svc.list(GUILD, 10).length, 1);
});

test('a name with no letters or digits is refused instead of saved under an empty name', () => {
  const { svc, audit } = service();
  const r = svc.set(GUILD, userTextForTest('!!!'), userTextForTest('body'), AUTHOR, NOW);
  assert.ok(!r.ok);
  assert.equal(audit.entries.length, 0, 'nothing refused is audited as saved');
});

test('the module installs with exactly its declared ports and registers /tag get and /tag set', async () => {
  const r = tagsModule.install({
    ports: fakePorts(tablePrefixFor('tags')),
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger: fakeLogger(),
  });
  assert.ok(r.ok, 'the tags module must install from the fake ports with an empty config');
  if (!r.ok) return;
  const m = r.value;

  assert.deepEqual([...m.manifest.capabilities], ['db', 'audit', 'clock']);
  assert.equal(m.manifest.migrations, true, 'it ships migrations/0001_init.sql');
  assert.deepEqual(m.commands.map((c) => c.name), ['tag get', 'tag set']);

  // Reading is for everyone; writing falls back to server managers. The decision is in the
  // manifest, where a reviewer sees it, not defaulted somewhere else.
  assert.equal(m.manifest.permissions['read']?.fallback, 'everyone');
  assert.equal(m.manifest.permissions['write']?.fallback, 'guild-admin');
  const [get, set] = m.commands;
  assert.equal(get?.permission, m.perms['read']);
  assert.equal(set?.permission, m.perms['write']);

  assert.equal((await m.health()).status, 'ok');
});
