-- Embed templates of HTML artifacts: the positions where an artifact's text
-- loads other artifacts of this instance by /a/:id URL, as a JSON array of
-- {"id", "start"} objects. With owner auth on, a view signs each of those
-- URLs without parsing the HTML again. Rows are derived data: a missing row,
-- or one whose extractor_version differs from the running extractor's, is
-- extracted again from the artifact's content. Removing an artifact drops
-- its row.
CREATE TABLE artifact_embed_templates (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  extractor_version INTEGER NOT NULL,
  embeds TEXT NOT NULL
);
