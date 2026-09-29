import { DatabaseSync } from 'node:sqlite';

import type {
  Artifact,
  ArtifactMetadataStore,
  EmbedTemplate,
  ListArtifactsQuery,
  StoredMarkdownRendering,
} from '../artifacts/types.js';
import {
  artifactFromRow,
  embedTemplateFromRow,
  findArtifact,
  findEmbedTemplate,
  findRendering,
  insertArtifact,
  listArtifacts,
  removeArtifact,
  renderingFromRow,
  saveEmbedTemplate,
  saveRendering,
} from './artifact-metadata-sql.js';
import type { SqlStatement } from './artifact-metadata-sql.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

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

  private run({ sql, values }: SqlStatement) {
    return this.database.prepare(sql).run(...values);
  }

  // node:sqlite runs the insert synchronously in its own transaction, so a
  // failed insert stored nothing and the outcome is never unknown.
  async create(artifact: Artifact): Promise<void> {
    this.run(insertArtifact(artifact));
  }

  async find(id: string): Promise<Artifact | null> {
    const { sql, values } = findArtifact(id);
    const record = this.database.prepare(sql).get(...values);
    return record === undefined ? null : artifactFromRow(record);
  }

  async findEmbedTemplate(id: string): Promise<EmbedTemplate | null> {
    const { sql, values } = findEmbedTemplate(id);
    const record = this.database.prepare(sql).get(...values);
    return record === undefined ? null : embedTemplateFromRow(record);
  }

  async findRendering(id: string): Promise<StoredMarkdownRendering | null> {
    const { sql, values } = findRendering(id);
    const record = this.database.prepare(sql).get(...values);
    return record === undefined ? null : renderingFromRow(record);
  }

  async list(query: ListArtifactsQuery = {}): Promise<Artifact[]> {
    const { sql, values } = listArtifacts(query);
    return this.database
      .prepare(sql)
      .all(...values)
      .map((record) => artifactFromRow(record));
  }

  // The embed template and rendering go with the row: their foreign keys
  // cascade.
  async remove(id: string): Promise<boolean> {
    return this.run(removeArtifact(id)).changes > 0;
  }

  async saveEmbedTemplate(id: string, template: EmbedTemplate): Promise<void> {
    this.run(saveEmbedTemplate(id, template));
  }

  async saveRendering(id: string, rendering: StoredMarkdownRendering): Promise<void> {
    this.run(saveRendering(id, rendering));
  }
}
