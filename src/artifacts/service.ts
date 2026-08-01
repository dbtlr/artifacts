import { nanoid } from 'nanoid';

import { hasValidSignature, isMediaType, MAX_ARTIFACT_BYTES, mediaDefinition } from './media.js';
import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  ArtifactService,
  CreateArtifactInput,
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

function runRollback(action: string, rollback: (() => void) | undefined): void {
  if (rollback === undefined) {
    return;
  }
  try {
    rollback();
  } catch (error) {
    reportCleanupFailure(`${action} rollback`, error);
  }
}

export function createArtifactService(
  metadata: ArtifactMetadataStore,
  content: ArtifactContentStore,
): ArtifactService {
  function generateId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = nanoid(ID_LENGTH);
      if (!metadata.find(id)) {
        return id;
      }
    }
    throw new Error(
      `Failed to generate a unique artifact id after ${String(MAX_ID_ATTEMPTS)} attempts`,
    );
  }

  function createArtifact(input: CreateArtifactInput): Artifact {
    assertValidMediaType(input.mediaType);
    assertNonBlank('title', input.title);
    assertNonBlank('project', input.project);
    assertNonBlank('description', input.description);
    if (input.collection !== undefined) {
      assertNonBlank('collection', input.collection);
    }
    assertValidFilename(input.mediaType, input.filename);
    assertValidContent(input.mediaType, input.content);

    const id = generateId();
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

    content.write(id, input.mediaType, input.content);
    try {
      metadata.create(artifact);
    } catch (error) {
      try {
        content.remove(id, input.mediaType);
      } catch (cleanupError) {
        reportCleanupFailure('create', cleanupError);
      }
      throw error;
    }
    return artifact;
  }

  function getArtifact(id: string) {
    const artifact = metadata.find(id);
    return artifact === null
      ? null
      : { ...artifact, content: content.read(id, artifact.mediaType) };
  }

  function updateArtifact(id: string, patch: UpdateArtifactInput): Artifact | null {
    const previous = metadata.find(id);
    if (!previous) {
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

    let rollbackContent: (() => void) | undefined;
    if (patch.content !== undefined) {
      const previousBytes = content.read(id, previous.mediaType);
      content.write(id, next.mediaType, patch.content);
      rollbackContent = () => {
        content.write(id, previous.mediaType, previousBytes);
        if (next.mediaType !== previous.mediaType) {
          content.remove(id, next.mediaType);
        }
      };
      if (next.mediaType !== previous.mediaType) {
        try {
          content.remove(id, previous.mediaType);
        } catch (error) {
          runRollback('update', () => content.remove(id, next.mediaType));
          throw error;
        }
      }
    }

    try {
      if (!metadata.update(next)) {
        runRollback('update', rollbackContent);
        return null;
      }
    } catch (error) {
      runRollback('update', rollbackContent);
      throw error;
    }
    return next;
  }

  function removeArtifact(id: string): boolean {
    const artifact = metadata.find(id);
    if (!artifact || !metadata.remove(id)) {
      return false;
    }
    try {
      content.remove(id, artifact.mediaType);
    } catch (error) {
      reportCleanupFailure('remove', error);
    }
    return true;
  }

  return {
    createArtifact,
    getArtifact,
    listArtifacts: (query) => metadata.list(query),
    removeArtifact,
    updateArtifact,
  };
}
