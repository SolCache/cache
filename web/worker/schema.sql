CREATE TABLE IF NOT EXISTS users (
  wallet TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_sig TEXT,
  last_sync INTEGER NOT NULL DEFAULT 0,
  last_sweep_request INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trades (
  sig TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT,
  description TEXT,
  value_usd REAL NOT NULL,
  roundup_usd REAL NOT NULL,
  multiplier INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_wallet_ts ON trades (wallet, ts DESC);

CREATE TABLE IF NOT EXISTS sweeps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  ts INTEGER NOT NULL,
  mint TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  expected_out TEXT,
  sig TEXT,
  status TEXT NOT NULL,
  error TEXT,
  lvbh INTEGER
);
CREATE INDEX IF NOT EXISTS sweeps_wallet_ts ON sweeps (wallet, ts DESC);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  wallet TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL
);
