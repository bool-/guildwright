/**
 * MIGRATION 0005 AND THE ROWS IT COULD STRAND (RFC-001 PR 2.2).
 *
 * `0005_repo_key.sql` adds `repo_key TEXT NOT NULL DEFAULT 'default'` to every existing request.
 * That default is right under the single-repository shim, which names its repository `default`,
 * and wrong for an install whose `GITHUB_REPOS_JSON` has no key `default` - most plainly the
 * operator who moves from the shim to `GITHUB_REPOS_JSON` under a key like `main`, with requests
 * still in flight. The decision this file pins (`planRepoKeyAdoption`):
 *
 *   A ROW ON AN UNCONFIGURED KEY IS RE-KEYED ONLY ON EVIDENCE IT CARRIES - the repository its own
 *   issue URL names - or, with no issue URL at all, a `default` row goes to the set's default
 *   repository, where the previous version acted on every row. EVERYTHING ELSE IS LEFT ALONE AND
 *   REPORTED, never "moved to the default": an issue number means a different issue in every
 *   repository.
 *
 * EVERYTHING HERE IS REAL: the real migration files through the real ledger runner
 * (`runMigrations`, with its checksum plan and its namespace assertion) against in-memory SQLite,
 * rows written by the PREVIOUS schema, and the real builder installed over the result.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import builder, { buildRepo, issueRepositoryOf, planRepoKeyAdoption } from '#modules/builder/module';
import { openSqlite, type SqliteDb } from '#adapters/sqlite/db';
import { readMigrationDir, runMigrations } from '#adapters/sqlite/migrate';
import { createEventBus } from '#core/events';
import { newCardNonce, newFenceNonce, newRequestId, type RequestId } from '#core/ids';
import type { InstalledModule } from '#core/module';
import type { RepoSet } from '#core/ports/repos';
import {
  fakeAccess,
  fakeAudit,
  fakeBuilds,
  fakeClock,
  fakeDiscord,
  fakeIssues,
  fakeJobs,
  fakeRecordingLogger,
  fakeRepoSet,
  fakeRepos,
  fakeScoped,
  type FakeAudit,
  type FakeRecordingLogger,
} from '#testing/fakes';

const DIR = 'src/modules/builder/migrations';
const NOW = 1_700_000_000_000;
const GUILD = '222222222222222222';

/** The migration files, all of them or only those before `0005`. */
function files(upTo: 'before-0005' | 'all') {
  const read = readMigrationDir(DIR);
  assert.ok(read.ok, 'the builder ships readable migrations');
  if (!read.ok) throw new Error('unreachable');
  return upTo === 'all' ? read.value : read.value.filter((f) => f.name < '0005');
}

/** A database exactly as the PREVIOUS release left it: 0001-0004 applied through the ledger. */
function previousRelease(): SqliteDb {
  const opened = openSqlite(':memory:');
  assert.ok(opened.ok);
  if (!opened.ok) throw new Error('unreachable');
  const applied = runMigrations(opened.value, 'builder', files('before-0005'));
  assert.ok(applied.ok, applied.ok ? '' : applied.error.code);
  assert.deepEqual(applied.ok ? applied.value : [], ['0001_init.sql', '0002_expiry_and_links.sql', '0003_history.sql', '0004_approval_id.sql']);
  return opened.value;
}

/** A row written by the previous schema - which has no `repo_key` column to write. */
function legacyRow(db: SqliteDb, row: { state: string; issueNumber: number | null; issueUrl: string | null }): RequestId {
  const id = newRequestId(NOW);
  db.connection
    .prepare(
      `INSERT INTO m_builder_requests (id, state, version, guild_id, requester_id, nonce, fence_nonce, title,
                                       issue_number, issue_url, created_at, updated_at)
       VALUES (?, ?, 1, ?, '111111111111111111', ?, ?, 'legacy', ?, ?, ?, ?)`,
    )
    .run(id, row.state, GUILD, newCardNonce(), newFenceNonce(), row.issueNumber, row.issueUrl, NOW, NOW);
  return id;
}

function applyRepoKeyMigration(db: SqliteDb): void {
  const applied = runMigrations(db, 'builder', files('all'));
  assert.ok(applied.ok, applied.ok ? '' : applied.error.code);
  assert.deepEqual(applied.ok ? applied.value : [], ['0005_repo_key.sql'], 'only the new file is applied over the old ledger');
}

/** The real builder, installed over this database and this repository set. */
function install(db: SqliteDb, set: RepoSet): { installed: InstalledModule; audit: FakeAudit; logger: FakeRecordingLogger } {
  const audit = fakeAudit();
  const logger = fakeRecordingLogger();
  const r = builder.install({
    ports: {
      db: db.moduleDb('builder'),
      audit,
      clock: fakeClock(NOW),
      jobs: fakeJobs(),
      discord: fakeDiscord(),
      access: fakeAccess(),
      repos: fakeRepos(set),
      issues: fakeScoped(set, fakeIssues()),
      builds: fakeScoped(set, fakeBuilds()),
    },
    rawConfig: {},
    bus: createEventBus(() => undefined),
    logger,
  });
  assert.ok(r.ok, 'the builder installs - a stranded row never quarantines it');
  if (!r.ok) throw new Error('unreachable');
  return { installed: r.value, audit, logger };
}

const MOVED_TO_JSON = () =>
  fakeRepoSet([
    { key: 'main', owner: 'Acme', repo: 'Bot-Modules', isDefault: true },
    { key: 'events', owner: 'acme', repo: 'events-modules', isDefault: false },
  ]);

// ---------------------------------------------------------------------------------------
// The migration itself
// ---------------------------------------------------------------------------------------

test('0005 applies cleanly over a database the previous migrations created, and every old row reads `default`', () => {
  const db = previousRelease();
  try {
    const old = legacyRow(db, { state: 'running', issueNumber: 42, issueUrl: 'https://github.com/o/r/issues/42' });
    applyRepoKeyMigration(db);

    const row = buildRepo(db.moduleDb('builder')).get(old);
    assert.equal(row?.repoKey, 'default', 'the shim names its one repository `default`, so this is right for a phase-1 install');
    assert.equal(row?.state, 'running', 'nothing else about the row changed');

    const indexes = db.connection.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'm_builder_requests'`).all().map((r) => String(r['name']));
    assert.ok(indexes.includes('m_builder_requests_repo_state'), 'in-flight counts per repository are indexed');
    assert.ok(indexes.includes('m_builder_requests_repo_issue'), 'one request per issue, per repository');
    assert.ok(!indexes.includes('m_builder_requests_issue'), 'the table-wide issue index is gone');

    // Applying again is a no-op: the ledger has it.
    const again = runMigrations(db, 'builder', files('all'));
    assert.deepEqual(again.ok ? again.value : null, []);
  } finally {
    db.close();
  }
});

test('0005: the same issue number in two repositories is two requests; twice in one repository is still refused', () => {
  const db = previousRelease();
  try {
    applyRepoKeyMigration(db);
    const insert = (key: string): void => {
      db.connection
        .prepare(
          `INSERT INTO m_builder_requests (id, state, version, guild_id, repo_key, requester_id, nonce, fence_nonce,
                                           issue_number, created_at, updated_at)
           VALUES (?, 'awaiting_approval', 1, ?, ?, '1', 'n', 'f', 1, ?, ?)`,
        )
        .run(newRequestId(NOW), GUILD, key, NOW, NOW);
    };
    insert('main');
    insert('events');
    assert.throws(() => insert('main'), /UNIQUE/u);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------------------
// The stranded-row decision
// ---------------------------------------------------------------------------------------

test('SHIM -> GITHUB_REPOS_JSON under new keys: in-flight rows follow their issue URL, case-insensitively, at boot', () => {
  const db = previousRelease();
  try {
    const inMain = legacyRow(db, { state: 'running', issueNumber: 42, issueUrl: 'https://github.com/acme/bot-modules/issues/42' });
    const inEvents = legacyRow(db, { state: 'awaiting_approval', issueNumber: 7, issueUrl: 'https://github.com/acme/events-modules/issues/7' });
    const doneInMain = legacyRow(db, { state: 'failed', issueNumber: 9, issueUrl: 'https://github.com/acme/bot-modules/issues/9' });
    const draft = legacyRow(db, { state: 'draft', issueNumber: null, issueUrl: null });
    applyRepoKeyMigration(db);

    const { audit, logger } = install(db, MOVED_TO_JSON());
    const repo = buildRepo(db.moduleDb('builder'));
    assert.equal(repo.get(inMain)?.repoKey, 'main', 'Acme/Bot-Modules is acme/bot-modules: GitHub names are case-insensitive');
    assert.equal(repo.get(inEvents)?.repoKey, 'events', 'evidence, not the default: this one lives in events');
    assert.equal(repo.get(doneInMain)?.repoKey, 'main', 'terminal rows too, so /request retry finds the right repository');
    assert.equal(repo.get(draft)?.repoKey, 'main', 'no URL yet: a `default` row goes where the previous version acted on it');
    assert.equal(repo.get(inEvents)?.version, 1, 're-keying is not a state transition: an Approve racing it still wins its CAS');
    assert.equal(repo.get(inEvents)?.updatedAt, NOW, 'and it does not buy an unclicked request a second TTL');

    const adopted = audit.entries.find((e) => e.action === 'builder.repo_key.adopted');
    assert.ok(adopted !== undefined, 'audited once');
    assert.equal(adopted.detail['count'], 4);
    assert.deepEqual(adopted.detail['moves'], ['default->events', 'default->main']);
    assert.match(logger.text(), /requests re-keyed to the repository their issue lives in/u);
    assert.equal(audit.entries.filter((e) => e.action === 'builder.repo_key.stranded').length, 0);
  } finally {
    db.close();
  }
});

test('STRANDED: a row whose issue is in a repository no longer configured is LEFT ALONE, reported at boot and in /status', async () => {
  const db = previousRelease();
  try {
    const gone = legacyRow(db, { state: 'running', issueNumber: 5, issueUrl: 'https://github.com/someone/else/issues/5' });
    const goneButFinished = legacyRow(db, { state: 'done', issueNumber: 6, issueUrl: 'https://github.com/someone/else/issues/6' });
    applyRepoKeyMigration(db);

    const { installed, audit, logger } = install(db, MOVED_TO_JSON());
    const repo = buildRepo(db.moduleDb('builder'));
    assert.equal(repo.get(gone)?.repoKey, 'default', 'NOT moved to the default: #5 there is somebody else\'s issue');
    assert.equal(repo.get(goneButFinished)?.repoKey, 'default');

    const stranded = audit.entries.find((e) => e.action === 'builder.repo_key.stranded');
    assert.ok(stranded !== undefined, 'the operator is told, once, at boot');
    assert.equal(stranded.detail['count'], 1, 'only the request still in flight is news; a finished one strands nothing');
    assert.deepEqual(stranded.detail['requestIds'], [gone]);
    assert.match(logger.text(), new RegExp(`no longer configured for.*${gone}`, 'u'), 'the boot log names the request');

    const health = await installed.health();
    assert.equal(health.status, 'degraded');
    assert.match(health.detail, /1 request\(s\) in flight are filed in repositories this bot is no longer configured for \(default\)/u);
  } finally {
    db.close();
  }
});

test('STRANDED with NO default: a `default` row with no issue URL has no evidence and no default - left alone', () => {
  const db = previousRelease();
  try {
    const draft = legacyRow(db, { state: 'draft', issueNumber: null, issueUrl: null });
    applyRepoKeyMigration(db);
    install(
      db,
      fakeRepoSet([
        { key: 'a', owner: 'acme', repo: 'a', isDefault: false },
        { key: 'b', owner: 'acme', repo: 'b', isDefault: false },
      ]),
    );
    assert.equal(buildRepo(db.moduleDb('builder')).get(draft)?.repoKey, 'default');
  } finally {
    db.close();
  }
});

test('THE SHIM ITSELF: key `default` is configured, so nothing is re-keyed and nothing is reported', () => {
  const db = previousRelease();
  try {
    const row = legacyRow(db, { state: 'running', issueNumber: 42, issueUrl: 'https://github.com/elsewhere/entirely/issues/42' });
    applyRepoKeyMigration(db);
    const { audit } = install(db, fakeRepoSet());
    assert.equal(buildRepo(db.moduleDb('builder')).get(row)?.repoKey, 'default', 'a configured key is authoritative');
    assert.deepEqual(audit.entries.map((e) => e.action).filter((a) => a.startsWith('builder.repo_key')), []);
  } finally {
    db.close();
  }
});

test('re-keying never forks an issue: a row whose issue the target repository already holds stays put', () => {
  const db = previousRelease();
  try {
    applyRepoKeyMigration(db);
    const repo = buildRepo(db.moduleDb('builder'));
    const insert = (key: string): RequestId => {
      const id = newRequestId(NOW);
      db.connection
        .prepare(
          `INSERT INTO m_builder_requests (id, state, version, guild_id, repo_key, requester_id, nonce, fence_nonce,
                                           issue_number, issue_url, created_at, updated_at)
           VALUES (?, 'failed', 1, ?, ?, '1', 'n', 'f', 42, 'https://github.com/acme/bot-modules/issues/42', ?, ?)`,
        )
        .run(id, GUILD, key, NOW, NOW);
      return id;
    };
    insert('main');
    const stale = insert('old-name');
    install(db, MOVED_TO_JSON());
    assert.equal(repo.get(stale)?.repoKey, 'old-name', 'no constraint error out of setup, and no second request on #42 in main');
  } finally {
    db.close();
  }
});

test('planRepoKeyAdoption and issueRepositoryOf, as pure functions', () => {
  assert.equal(issueRepositoryOf('https://github.com/Acme/Repo/issues/12'), 'acme/repo');
  assert.equal(issueRepositoryOf('https://github.com/acme/repo/pull/12'), null, 'a pull request URL is not issue evidence');
  assert.equal(issueRepositoryOf('not a url'), null);

  const set = MOVED_TO_JSON();
  const plan = planRepoKeyAdoption(
    [
      { id: 'a', repoKey: 'main', issueUrl: 'https://github.com/x/y/issues/1', state: 'running' },
      { id: 'b', repoKey: 'renamed', issueUrl: 'https://github.com/acme/events-modules/issues/2', state: 'running' },
      { id: 'c', repoKey: 'renamed', issueUrl: null, state: 'draft' },
    ],
    set.refs,
  );
  assert.deepEqual(plan.adopted, [{ id: 'b', from: 'renamed', to: 'events', evidence: 'issue-url' }], 'a renamed key is followed by evidence too');
  assert.deepEqual(plan.stranded, [{ id: 'c', repoKey: 'renamed', state: 'draft' }], 'only `default` falls back to the default repository');
});
