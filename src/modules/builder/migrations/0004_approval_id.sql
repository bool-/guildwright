-- WHICH APPROVAL THIS DISPATCH SPENDS.
--
-- `newApprovalId()` was minted on every Approve click, written to the audit log and the job
-- payload, and then used for nothing: it was not in the signed tuple and not a dispatch input.
-- That left the approval MAC a NON-EXPIRING BEARER TOKEN - `workflow_dispatch` inputs print in
-- plaintext in the run title, the REST API and the job log, so anybody with repository read
-- access could copy `approval_token` out of a finished run and re-dispatch it until the daily
-- cap stopped them (docs/KNOWN-ISSUES.md, "The approval MAC is a non-expiring bearer token").
--
-- Persisting the id is what lets it be (a) signed into the token and re-sent on every dispatch
-- attempt, and (b) refused by the workflow when it has already been used once.
ALTER TABLE m_builder_requests ADD COLUMN approval_id TEXT;

-- When the token for the CURRENT attempt was signed, epoch ms. Re-stamped on every attempt,
-- because the workflow compares it to the run's own creation time and refuses a token older
-- than APPROVAL_MAX_AGE_SECONDS; a request that waited behind the daily cap must be signed
-- seconds before dispatch, not at the Approve click hours earlier.
ALTER TABLE m_builder_requests ADD COLUMN approval_issued_at INTEGER;

-- When the FIRST dispatch attempt for this approval was made, epoch ms. Written once per
-- approval_id and never re-stamped: it is where the bot starts looking for an earlier run of
-- the same approval when the workflow reports a replay, and attempts 1 and 2 can be separated
-- by a long GitHub outage.
ALTER TABLE m_builder_requests ADD COLUMN first_dispatch_at INTEGER;

-- One approval, one row. A partial index because every row approved before this migration, and
-- every row that has not been approved yet, legitimately holds NULL.
CREATE UNIQUE INDEX IF NOT EXISTS m_builder_requests_approval
  ON m_builder_requests (approval_id) WHERE approval_id IS NOT NULL;
