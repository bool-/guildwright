-- 0002_jobs_started_at.sql - WHEN THE CURRENT ATTEMPT OF A RUNNING JOB STARTED.
--
-- WHAT WAS WRONG WITHOUT IT. `JobStats` was counts and nothing else, so `/admin jobs` said
-- "1 running" for a build that started four seconds ago and for a build wedged since Tuesday -
-- the same sentence for the healthy case and the one an operator is looking for. The command
-- existed and answered nothing.
--
-- WHY A NEW COLUMN AND NOT `updated_at_ms`, WHICH WAS ALREADY THERE. That column is a LEASE
-- liveness signal, not a work one: the runner writes it on every lease renewal (every tick, for
-- every in-flight job) and again on every `heartbeat()`. A job hung on a socket renews its lease
-- perfectly happily, so `updated_at_ms` reads as "just now" for exactly the job an operator
-- needs to find. A duration computed from it would be reassuring and false, which is worse than
-- no duration at all.
--
-- IT IS NULLABLE, and it has to be: `ALTER TABLE ... ADD COLUMN` fills every existing row with
-- NULL, and SQLite will not add a NOT NULL column without a constant default. There is no
-- honest constant here - inventing "now" for rows claimed by a process that is already gone
-- would fabricate the very number this file exists to make true. Rows written before this
-- migration therefore report no start time, and `stats()` skips them explicitly rather than
-- letting NULL sort to the front of an ORDER BY. The first `recover()` after this deploys
-- re-queues every running row anyway, and the next claim writes a real value.
--
-- WHY IT IS SET AT CLAIM AND NEVER TOUCHED AGAIN: "how long has this attempt been running" is
-- the question, and any later write is a different question's answer.
--
-- NEVER EDIT THIS FILE once it has shipped. Its sha256 is in `core_migrations`, and
-- `planMigrations` aborts boot when a checksum moves. Add 0003 instead.

ALTER TABLE core_jobs ADD COLUMN started_at_ms INTEGER;

-- The index the oldest-running lookup reads: one row, straight off the index, no scan of a
-- table whose `done` rows outnumber the running ones by orders of magnitude.
CREATE INDEX IF NOT EXISTS core_jobs_running_started_idx ON core_jobs (state, started_at_ms);
