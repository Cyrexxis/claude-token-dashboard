-- Cost split by token type (plus web search), so cost can be grouped like tokens.
ALTER TABLE requests ADD COLUMN cost_input REAL;
ALTER TABLE requests ADD COLUMN cost_output REAL;
ALTER TABLE requests ADD COLUMN cost_cache_read REAL;
ALTER TABLE requests ADD COLUMN cost_cache_write_5m REAL;
ALTER TABLE requests ADD COLUMN cost_cache_write_1h REAL;
ALTER TABLE requests ADD COLUMN cost_web_search REAL;
ALTER TABLE daily_rollups ADD COLUMN cost_input REAL NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cost_output REAL NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cost_cache_read REAL NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cost_cache_write_5m REAL NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cost_cache_write_1h REAL NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cost_web_search REAL NOT NULL DEFAULT 0;
-- Makes the next syncPrices reprice every request (filling the new columns) and rebuild rollups.
DELETE FROM settings WHERE key = 'prices_hash';
