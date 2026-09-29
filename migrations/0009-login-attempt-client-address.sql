-- Login attempts are limited per client address as well as in total
-- (docs/decisions/0005-per-client-login-limit.md). An empty address means the
-- request's address was unknown; attempts recorded before this migration have
-- one and expire with the window. A successful login clears only the attempts
-- from its own address.
ALTER TABLE login_attempts ADD COLUMN client_address TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_login_attempts_client_address ON login_attempts(client_address, attempted_at);
