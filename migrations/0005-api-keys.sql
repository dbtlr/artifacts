-- API keys for /mcp, used only when an owner password is configured. A key
-- is stored as the SHA-256 of its secret, so the database never holds a
-- usable key. Revoking a key deletes its row.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
