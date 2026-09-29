-- When each API key last opened /mcp, as an ISO 8601 UTC string, or NULL
-- for a key never used. It is recorded at most once a minute per key, so
-- it is coarse by design: it tells the owner which keys are still in use.
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
