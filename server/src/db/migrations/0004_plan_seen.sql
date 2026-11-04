-- When a stored plan reading was last confirmed unchanged; null means only at ts.
-- Readings are stored only on change, so this lets the Plan chart draw a held value up to the last reading.
ALTER TABLE plan_snapshots ADD COLUMN seen_ts INTEGER;
