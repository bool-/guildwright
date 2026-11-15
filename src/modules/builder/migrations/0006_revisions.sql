-- REVISIONS: `/request revise` puts an open pull request back in front of the agent.
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0005: `planMigrations` recomputes the checksum of every
-- applied file at boot and REFUSES TO START if one changed. New columns go in a new numbered file.
--
-- Every object here is still named m_builder_*; boot asserts that.

-- HOW MANY REVISIONS THIS REQUEST HAS ASKED FOR, and whether the CURRENT build is one.
--
-- Three jobs. It bounds re-spend (`modules.builder.maxRevisions`); it numbers the next
-- `## Revision <k>` section appended to the issue body; and while the row is in an active state
-- (`awaiting_approval`, `dispatching`, `running`) a non-zero count means that work is a revision
-- of an open pull request, so a Reject, an expiry or a cancel hands the row back to `pr_open`
-- instead of closing the issue under a live PR.
--
-- NOT NULL DEFAULT 0 is a constant default, the only kind SQLite accepts on ADD COLUMN; every
-- existing row is "never revised", which is true.
ALTER TABLE m_builder_requests ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
