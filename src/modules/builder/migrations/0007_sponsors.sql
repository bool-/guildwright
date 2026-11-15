-- SPONSORS: somebody other than the requester pays for a build, by clicking Sponsor on its card.
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0006: `planMigrations` recomputes the checksum of every
-- applied file at boot and REFUSES TO START if one changed. New columns go in a new numbered file.
--
-- Every object here is still named m_builder_*; boot asserts that.

-- WHO PAYS, when it is not the requester. Written only by that person's own Sponsor click, in a
-- compare-and-set on the row's version, and cleared whenever the row is re-armed (a revision, a
-- retry, an expired request put back), because nobody's bill may grow from a click they made for
-- an earlier build. Null: the requester pays.
ALTER TABLE m_builder_requests ADD COLUMN sponsor_id TEXT;

-- WHETHER THE CARD OFFERS SPONSORING: 1 when, the last time the row was armed, the requester had
-- no build credentials. The Approve click re-checks and sets it when a requester's credential
-- disappears later, so a request is never stuck with nobody able to pay and no button to fix it.
ALTER TABLE m_builder_requests ADD COLUMN needs_sponsor INTEGER NOT NULL DEFAULT 0;

-- WHAT THE APPROVAL CARD SHOWED, so a Sponsor click can redraw it. Stored ALREADY SANITISED -
-- `toMarkdown` output, re-scrubbed by `sanitizeStored` on the way out, which is idempotent on it -
-- for the reason `title` is: a column is a plain string and re-blessing one is the laundering hole
-- this codebase refuses to open. The full text lives in the GitHub issue, fenced, as before.
ALTER TABLE m_builder_requests ADD COLUMN card_excerpt TEXT;
ALTER TABLE m_builder_requests ADD COLUMN card_excerpt_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE m_builder_requests ADD COLUMN card_kind TEXT;
ALTER TABLE m_builder_requests ADD COLUMN card_success TEXT;
