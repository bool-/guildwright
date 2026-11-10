-- The builder's request table.
--
-- Every object MUST be named m_builder_*. Boot asserts it, so a stray name fails the deploy
-- rather than colliding with another module later.
--
-- WHY THIS FILE DID NOT EXIST UNTIL IT WAS AUDITED: the module declared `migrations: true`, and
-- `readMigrationDir` returns Ok([]) for a MISSING directory by design (a module with no
-- migrations is legal). So "declared migrations, shipped none" was indistinguishable from
-- "needs no migrations", the table was never created, and the bot booted reporting healthy while
-- the flagship feature could not execute a single query. There is now a boot check for exactly
-- that mismatch, and an integration test that runs this file against a real database.

CREATE TABLE IF NOT EXISTS m_builder_requests (
  id                TEXT    PRIMARY KEY,
  state             TEXT    NOT NULL,
  -- Optimistic concurrency. Every transition is a guarded UPDATE on (id, version); the loser of
  -- a double-clicked Approve changes 0 rows and is treated as a benign no-op.
  version           INTEGER NOT NULL DEFAULT 1,

  guild_id          TEXT    NOT NULL,
  requester_id      TEXT    NOT NULL,
  -- Supersedes a stale card: a click carrying an older nonce is ignored.
  nonce             TEXT    NOT NULL,
  -- Per-issue fence nonce, so user text in the issue body sits inside an unguessable delimiter.
  fence_nonce       TEXT    NOT NULL,

  issue_number      INTEGER,
  run_id            INTEGER,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  -- Where to deliver the outcome. Persisted at request time precisely BECAUSE the interaction
  -- token dies at ~15 minutes and a build can take 30 — the PR link is sent as a fresh REST
  -- call against this, never through the interaction webhook.
  surface_json      TEXT,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  CHECK (state IN ('draft','awaiting_approval','dispatching','running',
                   'pr_open','done','failed','rejected','expired','cancelled')),
  CHECK (dispatch_attempts >= 0)
);

-- The reconciler sweeps by (state, updated_at) looking for rows whose job was lost.
CREATE INDEX IF NOT EXISTS m_builder_requests_state_updated
  ON m_builder_requests (state, updated_at);

-- The per-guild concurrency cap counts active rows per guild on every request.
CREATE INDEX IF NOT EXISTS m_builder_requests_guild_state
  ON m_builder_requests (guild_id, state);

-- One request per issue, and one per run. Both are how a retry is prevented from forking:
-- a duplicate issue or a duplicate run correlation becomes a constraint error, not a second
-- paid build.
CREATE UNIQUE INDEX IF NOT EXISTS m_builder_requests_issue
  ON m_builder_requests (issue_number) WHERE issue_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS m_builder_requests_run
  ON m_builder_requests (run_id) WHERE run_id IS NOT NULL;
