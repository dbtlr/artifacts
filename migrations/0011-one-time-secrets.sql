-- One-time secrets (ADR-0008). No table holds a secret's contents or its
-- key: a secret keeps only AES-256-GCM ciphertext under a key that lives in
-- its view link or handle. Reading a secret drops its ciphertext and keeps
-- the row as a tombstone, so its status still says "read", until a sweep
-- removes it a day later. Times are ISO 8601 UTC text; binary values are
-- base64url text.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  filename TEXT,
  ciphertext TEXT,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  read_at TEXT,
  CHECK (read_at IS NULL OR ciphertext IS NULL)
);

CREATE INDEX idx_secrets_expires_at ON secrets(expires_at);

-- An upload URL. It names the secret its upload will create. The token is
-- stored as its SHA-256. An upload marks the row used, so it keeps its place
-- under the limit, and deletes it once the secret is stored.
CREATE TABLE secret_upload_slots (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  filename TEXT,
  ttl_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX idx_secret_upload_slots_expires_at ON secret_upload_slots(expires_at);

-- An unused download URL for a claimed secret. The secret's key is stored
-- only encrypted under a key derived from the claim token, which is stored
-- as its SHA-256. The row is deleted when it is used.
CREATE TABLE secret_claims (
  token_hash TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_secret_claims_expires_at ON secret_claims(expires_at);
