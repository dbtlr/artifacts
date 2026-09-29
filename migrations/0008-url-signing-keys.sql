-- Keys that sign artifact URLs, used only when an owner password is
-- configured. There is one key per clock hour, where bucket is the Unix time
-- in seconds divided by 3600, rounded down. The first process to need an
-- hour's key inserts it and every other process reads that row, so all of
-- them sign alike. A key signs URLs in its own hour and verifies them into
-- the next; older keys are deleted. Keys are 256 random bits in base64url.
CREATE TABLE url_signing_keys (
  bucket INTEGER PRIMARY KEY,
  signing_key TEXT NOT NULL
);
