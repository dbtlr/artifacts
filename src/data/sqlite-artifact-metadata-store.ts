import type { SQLOutputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

import type {
  Artifact,
  ArtifactMetadataStore,
  ArtifactType,
  ListArtifactsQuery,
} from '../artifacts/types.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

type ArtifactRow = {
  created_at: string;
  description: string;
  id: string;
  project: string;
  title: string;
  type: ArtifactType;
  updated_at: string;
};

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

function isArtifactType(value: string): value is ArtifactType {
  return value === 'html' || value === 'md' || value === 'txt';
}

function toArtifactRow(record: Record<string, SQLOutputValue>): ArtifactRow {
  const type = String(record.type);
  if (!isArtifactType(type)) {
    throw new Error(`Corrupt artifacts row: unexpected type ${JSON.stringify(type)}`);
  }
  return {
    created_at: String(record.created_at),
    description: String(record.description),
    id: String(record.id),
    project: String(record.project),
    title: String(record.title),
    type,
    updated_at: String(record.updated_at),
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    project: row.project,
    title: row.title,
    type: row.type,
    updatedAt: row.updated_at,
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

  create(artifact: Artifact): void {
    this.database
      .prepare(
        'INSERT INTO artifacts (id, title, project, description, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        artifact.id,
        artifact.title,
        artifact.project,
        artifact.description,
        artifact.type,
        artifact.createdAt,
        artifact.updatedAt,
      );
  }

  find(id: string): Artifact | null {
    const record = this.database.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    return record === undefined ? null : toArtifact(toArtifactRow(record));
  }

  list(query: ListArtifactsQuery = {}): Artifact[] {
    const records =
      query.project === undefined
        ? this.database
            .prepare('SELECT * FROM artifacts ORDER BY created_at DESC, rowid DESC')
            .all()
        : this.database
            .prepare(
              'SELECT * FROM artifacts WHERE project = ? ORDER BY created_at DESC, rowid DESC',
            )
            .all(query.project);
    return records.map((record) => toArtifact(toArtifactRow(record)));
  }

  remove(id: string): boolean {
    return this.database.prepare('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0;
  }

  update(artifact: Artifact): boolean {
    return (
      this.database
        .prepare(
          'UPDATE artifacts SET title = ?, project = ?, description = ?, type = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          artifact.title,
          artifact.project,
          artifact.description,
          artifact.type,
          artifact.updatedAt,
          artifact.id,
        ).changes > 0
    );
  }
}
