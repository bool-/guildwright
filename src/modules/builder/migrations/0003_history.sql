-- HISTORY, WITHDRAWAL AND RE-DISPATCH: the three columns that make a request something a human
-- can look up, take back, or try again.
--
-- WHY A THIRD FILE AND NOT AN EDIT TO 0002: `planMigrations` recomputes the checksum of every
-- applied file at boot and REFUSES TO START if one changed, because an edited applied migration
-- means two environments hold different schemas under the same ledger entry. New columns go in a
-- new numbered file, always.
--
-- Every object here is still named m_builder_*; boot asserts that and would refuse the deploy
-- otherwise.

-- WHAT WAS ASKED FOR.
--
-- The title reached `approvalCard` as a parameter and was thrown away after rendering, so from
-- the moment the card scrolled off screen the request was an integer. `/request list` cannot be
-- built on integers: "you have #42, #47 and #51" tells a requester nothing about which one was
-- the dark-mode idea and which one they should cancel. It is stored ALREADY SANITISED - the
-- value written is `toPlainName(...)` output, which has been through NFKC, invisible-character
-- removal, mention defanging and markup neutralisation - and it is still re-scrubbed with
-- `sanitizeStored` on the way back out, because a column is a plain string and re-blessing one
-- is the laundering hole this codebase refuses to open.
ALTER TABLE m_builder_requests ADD COLUMN title TEXT;

-- THE OUTCOME, NOT JUST THE INPUT.
--
-- `issue_url` and `run_url` are both about how the build was made; neither is what the requester
-- actually wanted. The PR URL was in hand exactly once, in the poll frame that drew the "Pull
-- request opened" card, and was never written down - so `/request list` could show a finished
-- build with nothing to open, which is the same "three manual hops" problem `issue_url` was
-- added to close.
ALTER TABLE m_builder_requests ADD COLUMN pr_url TEXT;

-- HOW MANY TIMES THIS HAS BEEN RE-ARMED.
--
-- Two jobs. It bounds re-spend (`modules.builder.maxRetries`), because a failure that can be
-- retried without retyping is a failure that can be retried in a loop; and it is half of the
-- durable job's dedupe key, because one live job per (module, dedupeKey) means a retry reusing
-- the dead job's key would be dropped on the floor and the row would sit in `dispatching` with
-- nothing polling it.
--
-- NOT NULL DEFAULT 0 is a constant default, which is the only kind SQLite accepts on ADD COLUMN;
-- every existing row is therefore "never retried", which is true.
ALTER TABLE m_builder_requests ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

-- `/request list` asks exactly one question: what are THIS person's most recent requests in THIS
-- guild? Without this index that is a full scan of every request the server has ever made,
-- executed inside a three-second interaction deadline.
CREATE INDEX IF NOT EXISTS m_builder_requests_requester
  ON m_builder_requests (guild_id, requester_id, created_at);
