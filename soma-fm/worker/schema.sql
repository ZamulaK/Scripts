-- SomaFM recorder (soma-fm/worker): every play and break it has seen, how its last look went, and Dan's synced data
CREATE TABLE IF NOT EXISTS plays (
  channel TEXT NOT NULL,
  at INTEGER NOT NULL,              -- start, unix seconds
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NOT NULL DEFAULT '',
  gap INTEGER NOT NULL DEFAULT 0,   -- 1 on the first play after a stretch nobody recorded
  added INTEGER NOT NULL DEFAULT 0, -- when this row was stored or last changed (unix seconds); devices ask by this
  PRIMARY KEY (channel, at, artist, title)
);
CREATE INDEX IF NOT EXISTS plays_added ON plays (channel, added);
CREATE TABLE IF NOT EXISTS breaks (
  channel TEXT NOT NULL,
  at INTEGER NOT NULL,              -- start of a station ID or break
  PRIMARY KEY (channel, at)
);
CREATE TABLE IF NOT EXISTS runs (
  channel TEXT PRIMARY KEY,
  at INTEGER NOT NULL,              -- last look, unix seconds
  ok INTEGER NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  last_ok INTEGER NOT NULL DEFAULT 0
);
-- Synced data (3.22): one JSON document (marks, dislikes, favorites, categories, notes, remembered playlist songs,
-- original order, removals), replaced only by a device that has seen the current version
CREATE TABLE IF NOT EXISTS docs (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated INTEGER NOT NULL
);
