import { nanoid } from 'nanoid';

import { createKeyedLane } from './keyed-lane.js';
import { hasValidSignature, isMediaType, MAX_ARTIFACT_BYTES, mediaDefinition } from './media.js';
import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  ArtifactService,
  ArtifactWithContent,
  CreateArtifactInput,
  FromCurrent,
  MediaType,
  UpdateArtifactInput,
} from './types.js';

const ID_LENGTH = 10;
const MAX_ID_ATTEMPTS = 5;
const SAFE_FILENAME = /^[^/\\]+$/u;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function assertValidMediaType(mediaType: MediaType): void {
  if (!isMediaType(mediaType)) {
    throw new Error(`Unsupported artifact media type ${JSON.stringify(mediaType)}`);
  }
}

type BlankableField = 'collection' | 'description' | 'project' | 'title';

function assertNonBlank(field: BlankableField, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid artifact ${field} ${JSON.stringify(value)}: must not be blank`);
  }
}

function assertValidFilename(mediaType: MediaType, filename: string | undefined): void {
  const definition = mediaDefinition(mediaType);
  if (definition.renderingMode === 'binary' && filename === undefined) {
    throw new Error(`Artifact filename is required for ${mediaType}`);
  }
  if (filename === undefined) {
    return;
  }
  if (
    filename !== filename.trim() ||
    filename === '.' ||
    filename === '..' ||
    filename.length > 255 ||
    !SAFE_FILENAME.test(filename) ||
    hasControlCharacter(filename)
  ) {
    throw new Error(
      `Invalid artifact filename ${JSON.stringify(filename)}: must be a safe filename`,
    );
  }
  const dot = filename.lastIndexOf('.');
  const extension = dot < 1 ? '' : filename.slice(dot + 1).toLowerCase();
  if (!definition.filenameExtensions.includes(extension)) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} does not match media type ${mediaType}`,
    );
  }
}

function assertValidContent(mediaType: MediaType, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact content is ${String(bytes.byteLength)} bytes; maximum is ${String(MAX_ARTIFACT_BYTES)} bytes`,
    );
  }
  const definition = mediaDefinition(mediaType);
  if (definition.renderingMode === 'binary' && bytes.byteLength === 0) {
    throw new Error('Binary artifact content must not be empty');
  }
  if (!hasValidSignature(mediaType, bytes)) {
    if (definition.renderingMode !== 'binary') {
      throw new Error(`Artifact content is not valid UTF-8 for media type ${mediaType}`);
    }
    throw new Error(`Artifact content signature does not match media type ${mediaType}`);
  }
}

function reportCleanupFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`Artifact ${action} cleanup failed: ${message}\n`);
  } catch {
    // Reporting must not replace the operation result being preserved.
  }
}

async function runRollback(
  action: string,
  rollback: (() => Promise<void>) | undefined,
): Promise<void> {
  if (rollback === undefined) {
    return;
  }
  try {
    await rollback();
  } catch (error) {
    reportCleanupFailure(`${action} rollback`, error);
  }
}

// Every operation that reads and then writes, or touches both stores, runs
// in its artifact's lane: create, update, and remove change content and
// metadata in a fixed order with compensating rollback, awaiting each step,
// and get reads metadata then content. The lane keeps another operation on
// the same artifact from running between those steps. It orders operations
// within this service instance only; it cannot coordinate other processes
// sharing the same stores, which need their own consistency design.
// Single metadata reads (find, list) stay outside it.
export function createArtifactService(
  metadata: ArtifactMetadataStore,
  content: ArtifactContentStore,
): ArtifactService {
  const lane = createKeyedLane();

  // Stores the artifact under a fresh id. Checking that the id is unused and
  // writing it happen in that id's lane; a taken id resolves null.
  async function storeUnderId(id: string, input: CreateArtifactInput): Promise<Artifact | null> {
    if (await metadata.find(id)) {
      return null;
    }
    const now = new Date().toISOString();
    const artifact: Artifact = {
      ...(input.collection === undefined ? {} : { collection: input.collection }),
      createdAt: now,
      description: input.description,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      id,
      mediaType: input.mediaType,
      project: input.project,
      title: input.title,
      updatedAt: now,
    };

    await content.write(id, input.mediaType, input.content);
    try {
      await metadata.create(artifact);
    } catch (error) {
      try {
        await content.remove(id, input.mediaType);
      } catch (cleanupError) {
        reportCleanupFailure('create', cleanupError);
      }
      throw error;
    }
    return artifact;
  }

  // Tries up to MAX_ID_ATTEMPTS fresh ids, one at a time.
  async function storeNew(input: CreateArtifactInput, attempt = 0): Promise<Artifact> {
    if (attempt >= MAX_ID_ATTEMPTS) {
      throw new Error(
        `Failed to generate a unique artifact id after ${String(MAX_ID_ATTEMPTS)} attempts`,
      );
    }
    const id = nanoid(ID_LENGTH);
    const created = await lane.run(id, () => storeUnderId(id, input));
    return created ?? storeNew(input, attempt + 1);
  }

  async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    assertValidMediaType(input.mediaType);
    assertNonBlank('title', input.title);
    assertNonBlank('project', input.project);
    assertNonBlank('description', input.description);
    if (input.collection !== undefined) {
      assertNonBlank('collection', input.collection);
    }
    assertValidFilename(input.mediaType, input.filename);
    assertValidContent(input.mediaType, input.content);
    return storeNew(input);
  }

  async function getArtifact(id: string): Promise<ArtifactWithContent | null> {
    const artifact = await metadata.find(id);
    return artifact === null
      ? null
      : { ...artifact, content: await content.read(id, artifact.mediaType) };
  }

  async function updateArtifact(
    id: string,
    patchOrPlan: UpdateArtifactInput | FromCurrent<UpdateArtifactInput | null>,
  ): Promise<Artifact | null> {
    const previous = await metadata.find(id);
    if (!previous) {
      return null;
    }
    const patch = typeof patchOrPlan === 'function' ? patchOrPlan(previous) : patchOrPlan;
    if (patch === null) {
      return null;
    }
    const nextMediaType = patch.mediaType ?? previous.mediaType;
    assertValidMediaType(nextMediaType);
    if (
      patch.mediaType !== undefined &&
      patch.mediaType !== previous.mediaType &&
      patch.content === undefined
    ) {
      throw new Error('Changing artifact mediaType requires replacement content');
    }
    if (patch.title !== undefined) {
      assertNonBlank('title', patch.title);
    }
    if (patch.project !== undefined) {
      assertNonBlank('project', patch.project);
    }
    if (patch.description !== undefined) {
      assertNonBlank('description', patch.description);
    }
    if (patch.collection !== undefined && patch.collection !== null) {
      assertNonBlank('collection', patch.collection);
    }

    const nextFilename =
      patch.filename === null ? undefined : (patch.filename ?? previous.filename);
    assertValidFilename(nextMediaType, nextFilename);
    if (patch.content !== undefined) {
      assertValidContent(nextMediaType, patch.content);
    }

    const next: Artifact = {
      ...(patch.collection === null ? {} : { collection: patch.collection ?? previous.collection }),
      createdAt: previous.createdAt,
      description: patch.description ?? previous.description,
      ...(nextFilename === undefined ? {} : { filename: nextFilename }),
      id: previous.id,
      mediaType: nextMediaType,
      project: patch.project ?? previous.project,
      title: patch.title ?? previous.title,
      updatedAt: new Date().toISOString(),
    };

    let rollbackContent: (() => Promise<void>) | undefined;
    if (patch.content !== undefined) {
      const previousBytes = await content.read(id, previous.mediaType);
      await content.write(id, next.mediaType, patch.content);
      rollbackContent = async () => {
        await content.write(id, previous.mediaType, previousBytes);
        if (next.mediaType !== previous.mediaType) {
          await content.remove(id, next.mediaType);
        }
      };
      if (next.mediaType !== previous.mediaType) {
        try {
          await content.remove(id, previous.mediaType);
        } catch (error) {
          await runRollback('update', async () => {
            await content.remove(id, next.mediaType);
          });
          throw error;
        }
      }
    }

    try {
      if (!(await metadata.update(next))) {
        await runRollback('update', rollbackContent);
        return null;
      }
    } catch (error) {
      await runRollback('update', rollbackContent);
      throw error;
    }
    return next;
  }

  async function removeArtifact(id: string, when?: FromCurrent<boolean>): Promise<boolean> {
    const artifact = await metadata.find(id);
    if (!artifact || (when !== undefined && !when(artifact)) || !(await metadata.remove(id))) {
      return false;
    }
    try {
      await content.remove(id, artifact.mediaType);
    } catch (error) {
      reportCleanupFailure('remove', error);
    }
    return true;
  }

  return {
    createArtifact,
    findArtifact: (id) => metadata.find(id),
    getArtifact: (id) => lane.run(id, () => getArtifact(id)),
    listArtifacts: (query) => metadata.list(query),
    removeArtifact: (id, when) => lane.run(id, () => removeArtifact(id, when)),
    updateArtifact: (id, patch) => lane.run(id, () => updateArtifact(id, patch)),
  };
}
