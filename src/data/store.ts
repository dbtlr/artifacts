import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { legacyTypeFromMediaType, mediaTypeFromLegacyType } from '../artifacts/media.js';
import { createArtifactService } from '../artifacts/service.js';
import type { Artifact, ArtifactService, ArtifactStore } from '../artifacts/types.js';
import { resolveStoragePaths } from '../data-dir.js';
import type { StoragePaths } from '../data-dir.js';
import { FilesystemArtifactContentStore } from './filesystem-artifact-content-store.js';
import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';

export type * from '../artifacts/types.js';

function assertLegacyType(type: string): asserts type is 'html' | 'md' | 'txt' {
  if (type !== 'html' && type !== 'md' && type !== 'txt') {
    throw new Error(`Invalid artifact type ${JSON.stringify(type)}, expected one of html, md, txt`);
  }
}

function toLegacyArtifact(artifact: Artifact) {
  const type = legacyTypeFromMediaType(artifact.mediaType);
  if (type === undefined) {
    return null;
  }
  const {
    collection: _collection,
    filename: _filename,
    mediaType: _mediaType,
    ...metadataFields
  } = artifact;
  return { ...metadataFields, type };
}

// The composition root is the only place that knows which persistence
// adapters back the service. There is intentionally no backend registry.
export async function createByteNativeArtifactService({
  databasePath,
  filesDir,
}: StoragePaths): Promise<ArtifactService> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const metadata = await SqliteArtifactMetadataStore.open(databasePath);
  const content = new FilesystemArtifactContentStore(filesDir);
  return createArtifactService(metadata, content);
}

export async function createArtifactStore({
  databasePath,
  filesDir,
}: StoragePaths): Promise<ArtifactStore> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const metadata = await SqliteArtifactMetadataStore.open(databasePath);
  const content = new FilesystemArtifactContentStore(filesDir);
  const service = createArtifactService(metadata, content);
  return {
    createArtifact: (input) => {
      const { content: text, type, ...metadataFields } = input;
      assertLegacyType(type);
      return toLegacyArtifact(
        service.createArtifact({
          ...metadataFields,
          content: new TextEncoder().encode(text),
          mediaType: mediaTypeFromLegacyType(type),
        }),
      )!;
    },
    getArtifact: (id) => {
      const artifact = service.getArtifact(id);
      if (artifact === null) {
        return null;
      }
      const { content: bytes, ...metadataFields } = artifact;
      const legacy = toLegacyArtifact(metadataFields);
      if (legacy === null) {
        return null;
      }
      return {
        ...legacy,
        content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      };
    },
    listArtifacts: (query) =>
      service
        .listArtifacts(query)
        .map(toLegacyArtifact)
        .filter((artifact) => artifact !== null),
    removeArtifact: (id) => {
      const artifact = metadata.find(id);
      if (artifact === null || legacyTypeFromMediaType(artifact.mediaType) === undefined) {
        return false;
      }
      return service.removeArtifact(id);
    },
    updateArtifact: (id, patch) => {
      const { content: text, type, ...metadataFields } = patch;
      if (type !== undefined) {
        assertLegacyType(type);
      }
      const existing = metadata.find(id);
      if (existing === null || legacyTypeFromMediaType(existing.mediaType) === undefined) {
        return null;
      }
      const updated = service.updateArtifact(id, {
        ...metadataFields,
        ...(text === undefined ? {} : { content: new TextEncoder().encode(text) }),
        ...(type === undefined ? {} : { mediaType: mediaTypeFromLegacyType(type) }),
      });
      return updated === null ? null : toLegacyArtifact(updated);
    },
  };
}

let defaultStore: Promise<ArtifactStore> | undefined;

async function createDefaultArtifactStore(): Promise<ArtifactStore> {
  try {
    return await createArtifactStore(resolveStoragePaths());
  } catch (error) {
    defaultStore = undefined;
    throw error;
  }
}

export function getDefaultArtifactStore(): Promise<ArtifactStore> {
  defaultStore ??= createDefaultArtifactStore();
  return defaultStore;
}
