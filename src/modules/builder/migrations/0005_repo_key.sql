-- WHICH REPOSITORY A REQUEST LIVES IN (RFC-001 PR 2.2, section 7.3).
--
-- A guild's requests land in the repository `ReposPort.resolve(guild)` names at submission: the
-- guild's `/repo use` mapping, else the default repository. That answer is persisted HERE, on the
-- row, and every later step of the request (approve, dispatch, poll, reject, cancel, retry,
-- expire) reads it back through `ReposPort.byKey`. So re-linking a guild mid-build cannot move
-- a poll, a cancel or a retry into a repository where that issue number means something else.
--
-- THE DEFAULT IS CORRECT FOR EVERY ROW WRITTEN BEFORE THIS FILE when the bot runs the
-- single-repository shim, which names its one repository `default`. An install whose
-- GITHUB_REPOS_JSON has no key `default` is the one case it is not: those rows are re-keyed at
-- boot by the builder (`adoptRepoKeys` in module.ts, the rule in `planRepoKeyAdoption` in
-- ports.ts), by the evidence each row carries - the repository its own issue URL names - and
-- never by guessing.
ALTER TABLE m_builder_requests ADD COLUMN repo_key TEXT NOT NULL DEFAULT 'default';

-- `/status` and `/repo show` count what is in flight per repository, and PR 2.4's per-repository
-- concurrency claim counts the same (repo_key, state) pairs inside its INSERT.
CREATE INDEX IF NOT EXISTS m_builder_requests_repo_state
  ON m_builder_requests (repo_key, state);

-- ONE REQUEST PER ISSUE *PER REPOSITORY*.
--
-- 0001 made `issue_number` unique across the whole table, which was "one request per issue" while
-- there was one repository. An issue number is only unique WITHIN a repository: the first request
-- filed in a second repository gets issue #1 again, and the old index turned that into a
-- constraint error thrown AFTER the issue was filed and the approval card posted. The rule the
-- index exists for - a retry cannot fork a second request onto the same issue - is kept, scoped to
-- where an issue number means something. (`m_builder_requests_run` stays global: a workflow run id
-- is unique across GitHub.)
DROP INDEX IF EXISTS m_builder_requests_issue;
CREATE UNIQUE INDEX IF NOT EXISTS m_builder_requests_repo_issue
  ON m_builder_requests (repo_key, issue_number) WHERE issue_number IS NOT NULL;
