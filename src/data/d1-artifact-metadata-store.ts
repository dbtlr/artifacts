import type { Artifact, ArtifactMetadataStore, ListArtifactsQuery } from '../artifacts/types.js';
import {
  artifactFromRow,
  findArtifact,
  insertArtifact,
  listArtifacts,
  removeArtifact,
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
  // on the way back. The port rejects only when nothing was stored, so a
  // failed insert resolves when this artifact's row is found in place. The
  // original error stands when the row is absent, belongs to another
  // artifact, or cannot be checked.
  async create(artifact: Artifact): Promise<void> {
    try {
      await this.statement(insertArtifact(artifact)).run();
    } catch (error) {
      const stored = await this.find(artifact.id).catch(() => null);
      if (stored === null || !sameArtifact(stored, artifact)) {
        throw error;
      }
    }
  }

  async find(id: string): Promise<Artifact | null> {
    const record = await this.statement(findArtifact(id)).first();
    return record === null ? null : artifactFromRow(record);
  }

  async list(query: ListArtifactsQuery = {}): Promise<Artifact[]> {
    const { results } = await this.statement(listArtifacts(query)).all();
    return results.map(artifactFromRow);
  }

  async remove(id: string): Promise<boolean> {
    const { meta } = await this.statement(removeArtifact(id)).run();
    return meta.changes > 0;
  }
}
