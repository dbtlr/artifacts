import { isMediaType } from '../artifacts/media.js';
import type { Artifact, EmbedTemplate, ListArtifactsQuery } from '../artifacts/types.js';

// The metadata statements that every SQLite-dialect adapter runs, so the
// node:sqlite and D1 adapters differ only in how they execute them. Values
// bind to `?` placeholders in the order given.
export type SqlStatement = { sql: string; values: (number | string | null)[] };

export function insertArtifact(artifact: Artifact): SqlStatement {
  return {
    sql: `INSERT INTO artifacts
      (id, title, project, description, media_type, collection, filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [
      artifact.id,
      artifact.title,
      artifact.project,
      artifact.description,
      artifact.mediaType,
      artifact.collection ?? null,
      artifact.filename ?? null,
      artifact.createdAt,
    ],
  };
}

export function findArtifact(id: string): SqlStatement {
  return { sql: 'SELECT * FROM artifacts WHERE id = ?', values: [id] };
}

// Newest first. rowid breaks ties between artifacts created in the same
// millisecond, so the later insert lists first.
export function listArtifacts(query: ListArtifactsQuery = {}): SqlStatement {
  const clauses: string[] = [];
  const values: string[] = [];
  if (query.project !== undefined) {
    clauses.push('project = ?');
    values.push(query.project);
  }
  if (query.collection !== undefined) {
    clauses.push('collection = ? COLLATE NOCASE');
    values.push(query.collection);
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  return {
    sql: `SELECT * FROM artifacts${where} ORDER BY created_at DESC, rowid DESC`,
    values,
  };
}

export function removeArtifact(id: string): SqlStatement {
  return { sql: 'DELETE FROM artifacts WHERE id = ?', values: [id] };
}

export function findEmbedTemplate(id: string): SqlStatement {
  return {
    sql: 'SELECT extractor_version, embeds FROM artifact_embed_templates WHERE artifact_id = ?',
    values: [id],
  };
}

// One statement, so the existence check and the write cannot be split by a
// remove from another process: an id without an artifact stores nothing.
export function saveEmbedTemplate(id: string, template: EmbedTemplate): SqlStatement {
  return {
    sql: `INSERT INTO artifact_embed_templates (artifact_id, extractor_version, embeds)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ?)
     ON CONFLICT (artifact_id) DO UPDATE SET
       extractor_version = excluded.extractor_version,
       embeds = excluded.embeds`,
    values: [id, template.extractorVersion, JSON.stringify(template.references), id],
  };
}

function requiredString(record: Record<string, unknown>, column: string): string {
  const value = record[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Corrupt artifacts row: ${column} is not text`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, column: string): string | undefined {
  const value = record[column];
  return value === null || value === undefined ? undefined : requiredString(record, column);
}

// Maps an `artifacts` row to an Artifact, leaving out null optional columns.
export function artifactFromRow(record: Record<string, unknown>): Artifact {
  const mediaType = requiredString(record, 'media_type');
  if (!isMediaType(mediaType)) {
    throw new Error(`Corrupt artifacts row: unexpected media_type ${JSON.stringify(mediaType)}`);
  }
  const collection = optionalString(record, 'collection');
  const filename = optionalString(record, 'filename');
  return {
    ...(collection === undefined ? {} : { collection }),
    createdAt: requiredString(record, 'created_at'),
    description: requiredString(record, 'description'),
    ...(filename === undefined ? {} : { filename }),
    id: requiredString(record, 'id'),
    mediaType,
    project: requiredString(record, 'project'),
    title: requiredString(record, 'title'),
  };
}

function isEmbedReference(value: unknown): value is EmbedTemplate['references'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'start' in value &&
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.start)
  );
}

// Maps an `artifact_embed_templates` row to its template.
export function embedTemplateFromRow(record: Record<string, unknown>): EmbedTemplate {
  const version = record.extractor_version;
  const references: unknown = JSON.parse(requiredString(record, 'embeds'));
  if (
    !Number.isSafeInteger(version) ||
    !Array.isArray(references) ||
    !references.every(isEmbedReference)
  ) {
    throw new Error('Corrupt artifact_embed_templates row');
  }
  return { extractorVersion: Number(version), references };
}
