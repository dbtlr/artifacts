-- Artifacts are immutable, so a last-change time would always equal the
-- creation time. The edit times of rows changed before this migration are
-- discarded. A downgrade restores the column from created_at.
ALTER TABLE artifacts DROP COLUMN updated_at;
