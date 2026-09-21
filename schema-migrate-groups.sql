-- run on existing local/remote DBs that already have terminals
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- SQLite: add columns if missing (ignore errors when re-run)
-- Wrangler may fail on duplicate columns; apply once per DB.
ALTER TABLE terminals ADD COLUMN note TEXT;
ALTER TABLE terminals ADD COLUMN group_id TEXT;

CREATE INDEX IF NOT EXISTS idx_term_group ON terminals(group_id);
CREATE INDEX IF NOT EXISTS idx_groups_sort ON groups(sort_order);
