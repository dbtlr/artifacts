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
import { readObject } from './r2-bucket.js';
import type { R2BucketBinding } from './r2-bucket.js';
import { isSafeId } from './safe-id.js';

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

// What a rendering blob holds. The renderer version is repeated here so a
// reader can tell that the blob and the row come from the same write.
type RenderingBlob = { html: string; rendererVersion: number; toc?: string };

function parseRenderingBlob(bytes: Uint8Array): RenderingBlob | null {
  try {
    const blob: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof blob !== 'object' || blob === null) {
      return null;
    }
    const html: unknown = Reflect.get(blob, 'html');
    const rendererVersion: unknown = Reflect.get(blob, 'rendererVersion');
    const toc: unknown = Reflect.get(blob, 'toc');
    if (
      typeof html !== 'string' ||
      !Number.isSafeInteger(rendererVersion) ||
      (toc !== undefined && typeof toc !== 'string')
    ) {
      return null;
    }
    return { html, rendererVersion: Number(rendererVersion), toc };
  } catch {
    return null;
  }
}

// Artifact metadata in D1, running the same statements as the node:sqlite
// adapter. The schema comes from the shared migrations, which
// `wrangler d1 migrations apply` runs before the Worker serves requests.
//
// A Markdown rendering's HTML and table of contents do not fit a D1 row,
// which holds about 2 MB while an artifact may be 10 MB, so they live in R2
// as `renderings/<id>`, a prefix apart from content (`files/`) and
// thumbnails (`thumbs/`) in a shared bucket. The `artifact_renderings` row
// keeps the renderer version and the flags, with an empty `html` and a null
// `toc`, because the schema is shared with SQLite.
//
// Saving writes the blob before the row, as content goes before metadata, and
// deletes the blob again when no artifact has the id. Reading treats a
// missing row, a missing or unparseable blob, and a blob whose renderer
// version differs from the row's as no rendering. Writers at different
// renderer versions can interleave so the row names one version and the blob
// holds another's HTML, and artifacts are immutable, so serving that pair
// would never correct itself. Removing drops the row first, then the blob; a
// blob that cannot be deleted is reported and left behind, as content is, since
// no row points at it and the next save under that id overwrites it.
export class D1ArtifactMetadataStore implements ArtifactMetadataStore {
  private readonly database: D1DatabaseBinding;
  private readonly renderings: R2BucketBinding;

  constructor(database: D1DatabaseBinding, renderings: R2BucketBinding) {
    this.database = database;
    this.renderings = renderings;
  }

  private renderingKey(id: string): string {
    if (!isSafeId(id)) {
      throw new Error(
        `Invalid artifact id ${JSON.stringify(id)}: must be a plain filename segment`,
      );
    }
    return `renderings/${id}`;
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
    if (record === null) {
      return null;
    }
    const row = renderingFromRow(record);
    const bytes = await readObject(this.renderings, this.renderingKey(id));
    const blob = bytes === null ? null : parseRenderingBlob(bytes);
    if (blob === null || blob.rendererVersion !== row.rendererVersion) {
      return null;
    }
    return { ...row, html: blob.html, toc: blob.toc };
  }

  async list(query: ListArtifactsQuery = {}): Promise<Artifact[]> {
    const { results } = await this.statement(listArtifacts(query)).all();
    return results.map(artifactFromRow);
  }

  // The embed template and rendering row go with the artifact row: their
  // foreign keys cascade. The rendering blob is deleted after the row.
  async remove(id: string): Promise<boolean> {
    const { meta } = await this.statement(removeArtifact(id)).run();
    if (meta.changes === 0) {
      return false;
    }
    try {
      await this.renderings.delete(this.renderingKey(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Rendering blob delete for ${id} failed: ${message}`);
    }
    return true;
  }

  async saveEmbedTemplate(id: string, template: EmbedTemplate): Promise<void> {
    await this.statement(saveEmbedTemplate(id, template)).run();
  }

  async saveRendering(id: string, rendering: StoredMarkdownRendering): Promise<void> {
    const key = this.renderingKey(id);
    const blob: RenderingBlob = {
      html: rendering.html,
      rendererVersion: rendering.rendererVersion,
      toc: rendering.toc,
    };
    await this.renderings.put(key, new TextEncoder().encode(JSON.stringify(blob)));
    const { meta } = await this.statement(
      saveRendering(id, { ...rendering, html: '', toc: undefined }),
    ).run();
    if (meta.changes === 0) {
      await this.renderings.delete(key);
    }
  }
}
