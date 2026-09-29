import { CreateOutcomeUnknownError } from '../artifacts/errors.js';
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
import type { D1DatabaseBinding, D1PreparedStatementBinding } from './d1-database.js';

const ARTIFACT_FIELDS = [
  'collection',
  'createdAt',
  'description',
  'filename',
  'id',
  'mediaType',
  'project',
  'title',
] as const satisfies readonly (keyof Artifact)[];

function sameArtifact(left: Artifact, right: Artifact): boolean {
  return ARTIFACT_FIELDS.every((field) => left[field] === right[field]);
}

// Artifact metadata in D1, running the same statements as the node:sqlite
// adapter. The schema comes from the shared migrations, which
// `wrangler d1 migrations apply` runs before the Worker serves requests.
export class D1ArtifactMetadataStore implements ArtifactMetadataStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  private statement({ sql, values }: SqlStatement): D1PreparedStatementBinding {
    return this.database.prepare(sql).bind(...values);
  }

  // A D1 call can fail after its write committed, for example by timing out
  // on the way back, so a failed insert checks for its row. It resolves when
  // this artifact's row is in place, and the insert error stands when the row
  // is absent or belongs to another artifact. When the row cannot be checked,
  // the outcome is unknown and the create rejects with
  // CreateOutcomeUnknownError.
  async create(artifact: Artifact): Promise<void> {
    try {
      await this.statement(insertArtifact(artifact)).run();
    } catch (error) {
      let stored: Artifact | null;
      try {
        stored = await this.find(artifact.id);
      } catch {
        throw new CreateOutcomeUnknownError(artifact.id, error);
      }
      if (stored === null || !sameArtifact(stored, artifact)) {
        throw error;
      }
    }
  }

  async find(id: string): Promise<Artifact | null> {
    const record = await this.statement(findArtifact(id)).first();
    return record === null ? null : artifactFromRow(record);
  }

  async findEmbedTemplate(id: string): Promise<EmbedTemplate | null> {
    const record = await this.statement(findEmbedTemplate(id)).first();
    return record === null ? null : embedTemplateFromRow(record);
  }

  async findRendering(id: string): Promise<StoredMarkdownRendering | null> {
    const record = await this.statement(findRendering(id)).first();
    return record === null ? null : renderingFromRow(record);
  }

  async list(query: ListArtifactsQuery = {}): Promise<Artifact[]> {
    const { results } = await this.statement(listArtifacts(query)).all();
    return results.map(artifactFromRow);
  }

  // The embed template and rendering go with the row: their foreign keys
  // cascade.
  async remove(id: string): Promise<boolean> {
    const { meta } = await this.statement(removeArtifact(id)).run();
    return meta.changes > 0;
  }

  async saveEmbedTemplate(id: string, template: EmbedTemplate): Promise<void> {
    await this.statement(saveEmbedTemplate(id, template)).run();
  }

  async saveRendering(id: string, rendering: StoredMarkdownRendering): Promise<void> {
    await this.statement(saveRendering(id, rendering)).run();
  }
}
