import { isMediaType } from '../artifacts/media.js';
import type { Artifact, ListArtifactsQuery } from '../artifacts/types.js';

// The metadata statements that every SQLite-dialect adapter runs, so the
// node:sqlite and D1 adapters differ only in how they execute them. Values
// bind to `?` placeholders in the order given.
export type SqlStatement = { sql: string; values: (string | null)[] };

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
