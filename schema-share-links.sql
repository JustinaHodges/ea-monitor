CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  hours INTEGER NOT NULL DEFAULT 24
);

CREATE INDEX IF NOT EXISTS idx_share_terminal ON share_links(terminal_id);
CREATE INDEX IF NOT EXISTS idx_share_expires ON share_links(expires_at);
