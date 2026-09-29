-- Rendered HTML of Markdown artifacts, stored so a view never parses
-- Markdown. Rows are derived data: a missing row, or one whose
-- renderer_version differs from the running renderer's, is rendered again
-- from the artifact's content. Removing an artifact drops its row.
CREATE TABLE artifact_renderings (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  renderer_version INTEGER NOT NULL,
  html TEXT NOT NULL,
  toc TEXT,
  has_mermaid INTEGER NOT NULL CHECK (has_mermaid IN (0, 1)),
  has_highlightable_code INTEGER NOT NULL CHECK (has_highlightable_code IN (0, 1))
);
