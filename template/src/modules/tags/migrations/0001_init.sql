-- The tags table. Every object MUST be named m_tags_*; boot asserts it.
--
-- This module is the exemplar AGENTS.md points contributors at, and it shipped with
-- `migrations: true` and no migrations directory — so copying it produced a module whose every
-- command threw. Fixed here, and a boot check now refuses that mismatch instead of booting
-- healthy into a broken state.

CREATE TABLE IF NOT EXISTS m_tags_tags (
  guild_id   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  author_id  TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Matches the ON CONFLICT (guild_id, name) target in repo.ts: a tag name is unique per guild,
  -- and re-setting one is an update rather than a duplicate row.
  PRIMARY KEY (guild_id, name)
);

-- `list` orders by name within a guild; the primary key already covers that prefix, so no
-- second index is warranted at this size.
