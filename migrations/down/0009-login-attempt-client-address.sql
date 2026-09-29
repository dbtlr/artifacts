DROP INDEX idx_login_attempts_client_address;
ALTER TABLE login_attempts DROP COLUMN client_address;
