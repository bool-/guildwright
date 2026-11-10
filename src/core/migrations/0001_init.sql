-- 0001_init.sql - the CORE schema, as migration 0001 of the pseudo-module `@core`.
--
-- THIS FILE IS THE FORMER `CORE_SCHEMA_SQL` CONSTANT, MOVED VERBATIM. Every statement below is
-- the one that shipped, character for character; nothing was added, renamed or reordered.
--
-- WHY IT MOVED. Modules have had a real ledger since day one - checksummed files, one
-- transaction each, ownership asserted against `m_<id>_`. Core had a single string re-executed
-- on every boot, so no core column could ever be added, renamed or dropped: an ALTER has
-- nowhere to live when the only schema step is an idempotent CREATE blob. Two fixes already on
-- the roadmap need exactly that, and both were blocked on this file not existing.
--
-- WHY THERE IS NO DATA MIGRATION HERE, AND WHY AN EXISTING DATABASE IS SAFE. Every statement is
-- `IF NOT EXISTS`, which is what made re-running it on every boot correct in the first place.
-- On a database that already has these tables, applying 0001 executes them all as no-ops and
-- the only lasting effect is the ledger row that records it - which is precisely the point:
-- from the next boot onward, 0002 can be an ALTER.
--
-- FROM HERE ON, THE ORDINARY MIGRATION RULES APPLY, and the first is the one that bites:
-- NEVER EDIT THIS FILE. Its sha256 is in `core_migrations`, and `planMigrations` aborts boot
-- when a checksum moves - because an edited applied migration means two environments have
-- different schemas under the same ledger entry, and every diagnosis after that is wrong. Add
-- `0002_<what>.sql` instead.
--
-- Objects created here MUST be named `core_*`. `assertOwnership` diffs `sqlite_master` around
-- this file and refuses anything else, exactly as it does for a module's `m_<id>_*`.

CREATE TABLE IF NOT EXISTS core_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms          INTEGER NOT NULL,
  module_id      TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  actor_id       TEXT    NOT NULL,
  guild_id       TEXT,
  decision_layer TEXT,
  detail_json    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS core_audit_at_idx ON core_audit (at_ms);
CREATE INDEX IF NOT EXISTS core_audit_guild_idx ON core_audit (guild_id, at_ms);
CREATE INDEX IF NOT EXISTS core_audit_actor_idx ON core_audit (actor_id, at_ms);

CREATE TABLE IF NOT EXISTS core_jobs (
  id             TEXT    PRIMARY KEY,
  module_id      TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  run_after_ms   INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  dedupe_key     TEXT,
  state          TEXT    NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  lease_owner    TEXT,
  lease_until_ms INTEGER,
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS core_jobs_due_idx ON core_jobs (state, run_after_ms);
CREATE INDEX IF NOT EXISTS core_jobs_lease_idx ON core_jobs (state, lease_until_ms);

-- Fixed-window rate limiting. One row per (bucket, window); an expired window is simply never
-- read again, so expiry needs no sweeper. prune() only keeps the table small.
--
-- WHY IT IS PERSISTED: an in-memory counter resets on restart, which turns "3 builds per hour"
-- into unlimited for anyone who can make the bot restart. This is the table that bounds spend.
CREATE TABLE IF NOT EXISTS core_ratelimits (
  bucket       TEXT    NOT NULL,
  window_index INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_index)
);
CREATE INDEX IF NOT EXISTS core_ratelimits_updated_idx ON core_ratelimits (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS core_jobs_live_dedupe_idx
  ON core_jobs (module_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS core_settings (
  guild_id      TEXT    NOT NULL,
  key           TEXT    NOT NULL,
  value_json    TEXT    NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE IF NOT EXISTS core_access (
  guild_id      TEXT    NOT NULL,
  perm_key      TEXT    NOT NULL,
  subject_kind  TEXT    NOT NULL,
  subject_id    TEXT    NOT NULL,
  granted_by    TEXT    NOT NULL,
  granted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (guild_id, perm_key, subject_kind, subject_id)
);
CREATE INDEX IF NOT EXISTS core_access_guild_idx ON core_access (guild_id);
