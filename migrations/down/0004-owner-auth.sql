-- Sessions and login attempts are disposable: dropping them only signs the
-- owner out.
DROP TABLE login_attempts;
DROP TABLE owner_sessions;
