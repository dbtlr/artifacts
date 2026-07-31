import { nanoid } from 'nanoid';

import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  ArtifactService,
  ArtifactType,
  CreateArtifactInput,
  UpdateArtifactInput,
} from './types.js';

const ARTIFACT_TYPES: readonly ArtifactType[] = ['html', 'md', 'txt'];
const ID_LENGTH = 10;
const MAX_ID_ATTEMPTS = 5;

function isArtifactType(value: string): value is ArtifactType {
  return value === 'html' || value === 'md' || value === 'txt';
}

function assertValidType(type: ArtifactType): void {
  if (!isArtifactType(type)) {
    throw new Error(
      `Invalid artifact type ${JSON.stringify(type)}, expected one of ${ARTIFACT_TYPES.join(', ')}`,
    );
  }
}

type BlankableField = 'description' | 'project' | 'title';

function assertNonBlank(field: BlankableField, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid artifact ${field} ${JSON.stringify(value)}: must not be blank`);
  }
}

function encodeText(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function decodeText(content: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
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
    assertValidType(input.type);
    assertNonBlank('title', input.title);
    assertNonBlank('project', input.project);
    assertNonBlank('description', input.description);

    const id = generateId();
    const now = new Date().toISOString();
    const artifact: Artifact = {
      createdAt: now,
      description: input.description,
      id,
      project: input.project,
      title: input.title,
      type: input.type,
      updatedAt: now,
    };

    content.write(id, input.type, encodeText(input.content));
    try {
      metadata.create(artifact);
    } catch (error) {
      content.remove(id, input.type);
      throw error;
    }
    return artifact;
  }

  function getArtifact(id: string) {
    const artifact = metadata.find(id);
    if (!artifact) {
      return null;
    }
    return { ...artifact, content: decodeText(content.read(id, artifact.type)) };
  }

  function updateArtifact(id: string, patch: UpdateArtifactInput): Artifact | null {
    const previous = metadata.find(id);
    if (!previous) {
      return null;
    }
    if (patch.type !== undefined) {
      assertValidType(patch.type);
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

    const next: Artifact = {
      ...previous,
      description: patch.description ?? previous.description,
      project: patch.project ?? previous.project,
      title: patch.title ?? previous.title,
      type: patch.type ?? previous.type,
      updatedAt: new Date().toISOString(),
    };

    let rollbackContent: (() => void) | undefined;
    if (patch.content !== undefined) {
      const previousBytes = content.read(id, previous.type);
      content.write(id, next.type, encodeText(patch.content));
      if (next.type !== previous.type) {
        content.remove(id, previous.type);
      }
      rollbackContent = () => {
        content.write(id, previous.type, previousBytes);
        if (next.type !== previous.type) {
          content.remove(id, next.type);
        }
      };
    } else if (next.type !== previous.type) {
      content.move(id, previous.type, next.type);
      rollbackContent = () => content.move(id, next.type, previous.type);
    }

    try {
      metadata.update(next);
    } catch (error) {
      rollbackContent?.();
      throw error;
    }
    return next;
  }

  function removeArtifact(id: string): boolean {
    const artifact = metadata.find(id);
    if (!artifact) {
      return false;
    }
    metadata.remove(id);
    content.remove(id, artifact.type);
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
