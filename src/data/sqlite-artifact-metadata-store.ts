import type { SQLOutputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

import { isMediaType } from '../artifacts/media.js';
import type {
  Artifact,
  ArtifactMetadataStore,
  ListArtifactsQuery,
  MediaType,
} from '../artifacts/types.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

type ArtifactRow = {
  collection: string | null;
  created_at: string;
  description: string;
  filename: string | null;
  id: string;
  media_type: MediaType;
  project: string;
  title: string;
};

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toArtifactRow(record: Record<string, SQLOutputValue>): ArtifactRow {
  const mediaType = String(record.media_type);
  if (!isMediaType(mediaType)) {
    throw new Error(`Corrupt artifacts row: unexpected media_type ${JSON.stringify(mediaType)}`);
  }
  return {
    collection: nullableString(record.collection),
    created_at: String(record.created_at),
    description: String(record.description),
    filename: nullableString(record.filename),
    id: String(record.id),
    media_type: mediaType,
    project: String(record.project),
    title: String(record.title),
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    ...(row.collection === null ? {} : { collection: row.collection }),
    createdAt: row.created_at,
    description: row.description,
    ...(row.filename === null ? {} : { filename: row.filename }),
    id: row.id,
    mediaType: row.media_type,
    project: row.project,
    title: row.title,
  };
}

export class SqliteArtifactMetadataStore implements ArtifactMetadataStore {
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  static async open(databasePath: string): Promise<SqliteArtifactMetadataStore> {
    const database = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      await runSqliteMigrations(database);
      return new SqliteArtifactMetadataStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async create(artifact: Artifact): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO artifacts
          (id, title, project, description, media_type, collection, filename, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.title,
        artifact.project,
        artifact.description,
        artifact.mediaType,
        artifact.collection ?? null,
        artifact.filename ?? null,
        artifact.createdAt,
      );
  }

  async find(id: string): Promise<Artifact | null> {
    const record = this.database.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    return record === undefined ? null : toArtifact(toArtifactRow(record));
  }

  async list(query: ListArtifactsQuery = {}): Promise<Artifact[]> {
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
    const records = this.database
      .prepare(`SELECT * FROM artifacts${where} ORDER BY created_at DESC, rowid DESC`)
      .all(...values);
    return records.map((record) => toArtifact(toArtifactRow(record)));
  }

  async remove(id: string): Promise<boolean> {
    return this.database.prepare('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0;
  }
}
