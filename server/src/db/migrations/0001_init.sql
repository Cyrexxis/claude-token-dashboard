-- All timestamps are INTEGER ms UTC.
CREATE TABLE installations (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  server_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  host TEXT,
  distro TEXT,
  root_path TEXT NOT NULL UNIQUE,
  last_scan_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  path TEXT NOT NULL UNIQUE,
  file_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER,
  session_id TEXT,
  last_ingest_at INTEGER,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id),
  parent_session_id TEXT,
  cwd TEXT,
  project TEXT,
  title TEXT,
  ai_title TEXT,
  agent_name TEXT,
  agent_color TEXT,
  agent_setting TEXT,
  tag TEXT,
  entrypoint TEXT,
  cc_version TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  desktop_meta_json TEXT
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '', -- NULL would defeat the UNIQUE constraint
  session_id TEXT,
  agent_id TEXT,
  ts INTEGER NOT NULL,
  model TEXT,
  source_id INTEGER REFERENCES sources(id),
  file_id INTEGER REFERENCES files(id),
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  thinking INTEGER NOT NULL DEFAULT 0,
  web_search INTEGER NOT NULL DEFAULT 0,
  web_fetch INTEGER NOT NULL DEFAULT 0,
  service_tier TEXT,
  speed TEXT,
  inference_geo TEXT,
  effort TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  price_period_id TEXT,
  unpriced INTEGER NOT NULL DEFAULT 0,
  usage_raw_json TEXT,
  UNIQUE (message_id, request_id)
);
CREATE INDEX requests_ts ON requests(ts);
CREATE INDEX requests_session ON requests(session_id);
CREATE INDEX requests_model_ts ON requests(model, ts);

CREATE TABLE price_periods (
  id TEXT PRIMARY KEY, -- <model>@<effective_from|release>@<origin>
  model_id TEXT NOT NULL,
  effective_from INTEGER,
  effective_to INTEGER,
  origin TEXT NOT NULL, -- shipped | local
  values_json TEXT NOT NULL
);

-- One row per Claude Code process and model; a later snapshot of the same process replaces it.
CREATE TABLE cost_states (
  session_id TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  thinking INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  web_search INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  total_cost_usd REAL,
  has_unknown_model_cost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, start_time, model)
);

CREATE TABLE daily_rollups (
  day TEXT NOT NULL, -- server-local date
  source_id INTEGER,
  model TEXT,
  project TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  thinking INTEGER NOT NULL DEFAULT 0,
  web_search INTEGER NOT NULL DEFAULT 0,
  web_fetch INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source_id, model, project)
);

-- Phase 3 (mod); created now so no migration is needed later.
CREATE TABLE plan_snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  org_id TEXT,
  kind TEXT NOT NULL,
  percent_used REAL,
  resets_at INTEGER,
  session_cost_usd REAL,
  origin TEXT NOT NULL -- mod | desktop
);
CREATE INDEX plan_snapshots_org_kind_ts ON plan_snapshots(org_id, kind, ts);

CREATE TABLE plan_windows (
  org_id TEXT,
  kind TEXT NOT NULL,
  resets_at INTEGER NOT NULL,
  peak_percent REAL,
  tokens_in_window INTEGER,
  cost_in_window REAL,
  PRIMARY KEY (org_id, kind, resets_at)
);

CREATE TABLE live_usage (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, turn_id, step_index)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
