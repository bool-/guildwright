-- Expiry, an honest attempt counter, and the links every card was missing.
--
-- WHY A SECOND FILE AND NOT AN EDIT TO 0001: `planMigrations` recomputes the checksum of every
-- applied file at boot and REFUSES TO START if one changed, because an edited applied migration
-- means two environments hold different schemas under the same ledger entry. New columns go in a
-- new numbered file, always.
--
-- Every object here is still named m_builder_*; boot asserts that diff and would refuse the
-- deploy otherwise.

-- WHERE THE CARD LINKS COME FROM.
--
-- `links: []` on every card meant every diagnosis started with three manual hops: find the
-- channel, read the issue number off the card, search GitHub for it, then find the run. The URLs
-- were always available - `IssuesPort.create` returns one and `RunStatus`/`RunRef` carry the
-- other - but nothing kept them, and the poll job that renders the "failed" card thirty minutes
-- later holds neither. They are persisted for the same reason `surface_json` is: the frame that
-- needs them runs long after the frame that had them.
ALTER TABLE m_builder_requests ADD COLUMN issue_url TEXT;
ALTER TABLE m_builder_requests ADD COLUMN run_url   TEXT;

-- THE DIFFERENCE BETWEEN "REFUSED ON PURPOSE" AND "BROKE".
--
-- The agent has three legitimate endings, and the poller could only recognise one of them. A
-- deliberate refusal - the request asked for something forbidden, so the agent made NO changes
-- and commented on the issue - produces a successful run and no pull request, which looked
-- exactly like "the PR has not appeared yet" and was retried until the six-hour deadline turned
-- it into "Build failed".
--
-- Telling them apart needs one fact the poller cannot recompute: WHEN the run first reported
-- success. After a short grace period from that moment, "no PR" stops meaning "not yet" and
-- starts meaning "there was never going to be one".
ALTER TABLE m_builder_requests ADD COLUMN succeeded_at INTEGER;

-- The hourly expiry sweep asks exactly one question: which `awaiting_approval` rows are older
-- than the TTL? A partial index answers it without walking the terminal rows, which are the
-- overwhelming majority of this table on any server that has been running a while.
CREATE INDEX IF NOT EXISTS m_builder_requests_awaiting
  ON m_builder_requests (updated_at) WHERE state = 'awaiting_approval';
