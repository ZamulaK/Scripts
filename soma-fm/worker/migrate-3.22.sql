-- Brings a database made from the 3.21 schema up to 3.22 (run once: wrangler d1 execute soma --remote --file migrate-3.22.sql)
ALTER TABLE plays ADD COLUMN added INTEGER NOT NULL DEFAULT 0;
UPDATE plays SET added = at;
CREATE INDEX IF NOT EXISTS plays_added ON plays (channel, added);
CREATE TABLE IF NOT EXISTS docs (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated INTEGER NOT NULL
);
