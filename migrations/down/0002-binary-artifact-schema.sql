-- Guard: refuse to downgrade while any row is not representable by the legacy
-- schema. The failing CHECK constraint aborts the downgrade, and its name is
-- the error message.
CREATE TABLE migration_guard (
  passed INTEGER NOT NULL
    CONSTRAINT "Cannot downgrade binary artifact schema: current data is not representable by the legacy schema, restore a pre-migration snapshot instead"
    CHECK (passed)
);
INSERT INTO migration_guard (passed)
SELECT NOT EXISTS (
  SELECT 1 FROM artifacts
  WHERE media_type NOT IN ('text/html', 'text/markdown', 'text/plain')
     OR collection IS NOT NULL
     OR filename IS NOT NULL
);
DROP TABLE migration_guard;

CREATE TABLE artifacts_legacy (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('html','md','txt')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO artifacts_legacy
  (id, title, project, description, type, created_at, updated_at)
SELECT id, title, project, description,
  CASE media_type
    WHEN 'text/html' THEN 'html'
    WHEN 'text/markdown' THEN 'md'
    WHEN 'text/plain' THEN 'txt'
  END,
  created_at, updated_at
FROM artifacts;
DROP INDEX IF EXISTS idx_artifacts_collection;
DROP INDEX IF EXISTS idx_artifacts_created_at;
DROP INDEX IF EXISTS idx_artifacts_project;
DROP TABLE artifacts;
ALTER TABLE artifacts_legacy RENAME TO artifacts;
CREATE INDEX idx_artifacts_project ON artifacts(project);
CREATE INDEX idx_artifacts_created_at ON artifacts(created_at);
