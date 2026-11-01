-- The 3.21 schema, for testing migrate-3.22.sql
-- SomaFM recorder (soma-fm/worker): every play and break it has seen, and how its last look went
CREATE TABLE IF NOT EXISTS plays (
  channel TEXT NOT NULL,
  at INTEGER NOT NULL,              -- start, unix seconds
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NOT NULL DEFAULT '',
  gap INTEGER NOT NULL DEFAULT 0,   -- 1 on the first play after a stretch the recorder missed
  PRIMARY KEY (channel, at, artist, title)
);
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
