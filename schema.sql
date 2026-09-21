-- migration: groups + terminal grouping
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  terminal_id TEXT PRIMARY KEY,
  api_secret TEXT NOT NULL,
  name TEXT,
  note TEXT,
  group_id TEXT,
  computer_id TEXT,
  computer_name TEXT,
  platform TEXT,
  mt_build INTEGER,
  broker TEXT,
  server TEXT,
  account TEXT,
  account_name TEXT,
  currency TEXT,
  leverage INTEGER,
  report_interval INTEGER DEFAULT 30,
  online INTEGER DEFAULT 0,
  last_seen INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  float_profit_alert REAL DEFAULT 0,
  float_loss_alert REAL DEFAULT 0,
  float_profit_latched INTEGER DEFAULT 0,
  float_loss_latched INTEGER DEFAULT 0,
  display_unit TEXT DEFAULT '',
  share_intro TEXT DEFAULT '',
  share_contact TEXT DEFAULT '',
  broker_gmt_offset INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eas (
  ea_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  computer_id TEXT,
  account TEXT,
  ea_name TEXT,
  ea_version TEXT,
  strategy_tag TEXT,
  magic INTEGER,
  symbol TEXT,
  timeframe TEXT,
  started_at INTEGER,
  last_heartbeat INTEGER,
  status TEXT,
  last_error TEXT,
  position_count INTEGER DEFAULT 0,
  pending_count INTEGER DEFAULT 0,
  floating_pl REAL DEFAULT 0,
  balance REAL,
  equity REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (terminal_id) REFERENCES terminals(terminal_id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT NOT NULL,
  ea_id TEXT,
  computer_id TEXT,
  account TEXT,
  ts INTEGER NOT NULL,
  balance REAL,
  equity REAL,
  floating_pl REAL,
  margin REAL,
  free_margin REAL,
  margin_level REAL,
  position_count INTEGER,
  pending_count INTEGER
);

CREATE TABLE IF NOT EXISTS positions_latest (
  terminal_id TEXT NOT NULL,
  ticket TEXT NOT NULL,
  ea_id TEXT,
  magic INTEGER,
  symbol TEXT,
  kind TEXT NOT NULL,
  side TEXT,
  volume REAL,
  price_open REAL,
  price_current REAL,
  sl REAL,
  tp REAL,
  profit REAL,
  comment TEXT,
  open_time INTEGER,
  updated_at INTEGER,
  spread REAL DEFAULT 0,
  PRIMARY KEY (terminal_id, ticket, kind)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT NOT NULL,
  computer_id TEXT,
  account TEXT,
  ea_id TEXT,
  ea_name TEXT,
  ticket TEXT,
  magic INTEGER,
  symbol TEXT,
  side TEXT,
  entry TEXT,
  volume REAL,
  price REAL,
  sl REAL,
  tp REAL,
  profit REAL,
  commission REAL,
  swap REAL,
  comment TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT NOT NULL,
  ea_id TEXT,
  ea_name TEXT,
  magic INTEGER,
  level TEXT,
  message TEXT,
  r2_key TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id TEXT,
  ea_id TEXT,
  computer_id TEXT,
  type TEXT NOT NULL,
  severity TEXT DEFAULT 'warn',
  message TEXT NOT NULL,
  acked INTEGER DEFAULT 0,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eas_terminal ON eas(terminal_id);
CREATE INDEX IF NOT EXISTS idx_eas_magic ON eas(magic);
CREATE INDEX IF NOT EXISTS idx_eas_symbol ON eas(symbol);
CREATE INDEX IF NOT EXISTS idx_eas_strategy ON eas(strategy_tag);
CREATE INDEX IF NOT EXISTS idx_eas_heartbeat ON eas(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_snap_ea_ts ON snapshots(ea_id, ts);
CREATE INDEX IF NOT EXISTS idx_snap_term_ts ON snapshots(terminal_id, ts);
CREATE INDEX IF NOT EXISTS idx_trades_term_ts ON trades(terminal_id, ts);
CREATE INDEX IF NOT EXISTS idx_trades_magic ON trades(magic, ts);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, ts);
CREATE INDEX IF NOT EXISTS idx_logs_term_ts ON logs(terminal_id, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
CREATE INDEX IF NOT EXISTS idx_alerts_acked ON alerts(acked, ts);
CREATE INDEX IF NOT EXISTS idx_term_computer ON terminals(computer_id);
CREATE INDEX IF NOT EXISTS idx_term_seen ON terminals(last_seen);
CREATE INDEX IF NOT EXISTS idx_term_group ON terminals(group_id);
CREATE INDEX IF NOT EXISTS idx_groups_sort ON groups(sort_order);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  hours INTEGER NOT NULL DEFAULT 24,
  show_calendar INTEGER NOT NULL DEFAULT 1,
  show_books INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_share_terminal ON share_links(terminal_id);
CREATE INDEX IF NOT EXISTS idx_share_expires ON share_links(expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires_at);


