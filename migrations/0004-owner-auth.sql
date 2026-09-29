-- Owner auth, used only when an owner password is configured. A session is
-- stored under an HMAC-SHA-256 of its cookie token keyed by the password, so
-- the database never holds a usable token and a new password ends every
-- session. login_attempts backs the login rate limit: every
-- attempt is recorded, and a successful login clears the table.
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_owner_sessions_expires_at ON owner_sessions(expires_at);
CREATE TABLE login_attempts (
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_attempted_at ON login_attempts(attempted_at);
