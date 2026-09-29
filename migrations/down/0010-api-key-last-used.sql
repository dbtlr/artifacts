-- Dropping the column loses only when keys were last used.
ALTER TABLE api_keys DROP COLUMN last_used_at;
