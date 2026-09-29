ALTER TABLE artifacts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE artifacts SET updated_at = created_at;
