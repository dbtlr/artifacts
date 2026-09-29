-- Guard: refuse to migrate while any row has a type the new schema cannot
-- map. The failing CHECK constraint aborts the migration, and its name is the
-- error message.
CREATE TABLE migration_guard (
  passed INTEGER NOT NULL
    CONSTRAINT "Cannot migrate artifacts: a row has a type other than html, md, or txt"
    CHECK (passed)
);
INSERT INTO migration_guard (passed)
SELECT NOT EXISTS (
  SELECT 1 FROM artifacts WHERE type IS NULL OR type NOT IN ('html', 'md', 'txt')
);
DROP TABLE migration_guard;

CREATE TABLE artifacts_binary (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  description TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN (
    'text/html', 'text/markdown', 'text/plain',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'image/svg+xml', 'application/pdf'
  )),
  collection TEXT COLLATE NOCASE,
  filename TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO artifacts_binary
  (id, title, project, description, media_type, collection, filename, created_at, updated_at)
SELECT id, title, project, description,
  CASE type
    WHEN 'html' THEN 'text/html'
    WHEN 'md' THEN 'text/markdown'
    WHEN 'txt' THEN 'text/plain'
  END,
  NULL, NULL, created_at, updated_at
FROM artifacts ORDER BY rowid;
DROP INDEX IF EXISTS idx_artifacts_created_at;
DROP INDEX IF EXISTS idx_artifacts_project;
DROP TABLE artifacts;
ALTER TABLE artifacts_binary RENAME TO artifacts;
CREATE INDEX idx_artifacts_project ON artifacts(project);
CREATE INDEX idx_artifacts_created_at ON artifacts(created_at);
CREATE INDEX idx_artifacts_collection ON artifacts(collection COLLATE NOCASE);
