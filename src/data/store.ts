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

// Re-exported so importers of the store module keep one place to look.
export { adaptLegacyArtifactStore } from '../artifacts/legacy-adapter.js';

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

function isLegacyText(artifact: Artifact): boolean {
  return legacyTypeFromMediaType(artifact.mediaType) !== undefined;
}

// The composition root is the only place that knows which persistence
// adapters back the service. There is intentionally no backend registry.
export async function createByteNativeArtifactService({
  databasePath,
  filesDir,
}: Pick<StoragePaths, 'databasePath' | 'filesDir'>): Promise<ArtifactService> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const metadata = await SqliteArtifactMetadataStore.open(databasePath);
  const content = new FilesystemArtifactContentStore(filesDir);
  return createArtifactService(metadata, content);
}

export async function createArtifactStore({
  databasePath,
  filesDir,
}: Pick<StoragePaths, 'databasePath' | 'filesDir'>): Promise<ArtifactStore> {
  const service = await createByteNativeArtifactService({ databasePath, filesDir });
  return legacyArtifactStoreFromService(service);
}

export function legacyArtifactStoreFromService(service: ArtifactService): ArtifactStore {
  return {
    createArtifact: async (input) => {
      const { content: text, type, ...metadataFields } = input;
      assertLegacyType(type);
      return toLegacyArtifact(
        await service.createArtifact({
          ...metadataFields,
          content: new TextEncoder().encode(text),
          mediaType: mediaTypeFromLegacyType(type),
        }),
      )!;
    },
    getArtifact: async (id) => {
      const artifact = await service.getArtifact(id);
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
    listArtifacts: async (query) =>
      (await service.listArtifacts(query))
        .map(toLegacyArtifact)
        .filter((artifact) => artifact !== null),
    // Text-only view: a binary artifact is invisible here, as if missing. An
    // artifact's media type never changes, so checking it first is safe.
    removeArtifact: async (id) => {
      const artifact = await service.findArtifact(id);
      return artifact !== null && isLegacyText(artifact) && service.removeArtifact(id);
    },
  };
}

let defaultStore: Promise<ArtifactStore> | undefined;
let defaultByteNativeService: Promise<ArtifactService> | undefined;

async function createDefaultArtifactStore(): Promise<ArtifactStore> {
  try {
    return legacyArtifactStoreFromService(await getDefaultByteNativeArtifactService());
  } catch (error) {
    defaultStore = undefined;
    throw error;
  }
}

export function getDefaultArtifactStore(): Promise<ArtifactStore> {
  defaultStore ??= createDefaultArtifactStore();
  return defaultStore;
}

async function createDefaultByteNativeArtifactService(): Promise<ArtifactService> {
  try {
    return await createByteNativeArtifactService(resolveStoragePaths());
  } catch (error) {
    defaultByteNativeService = undefined;
    throw error;
  }
}

export function getDefaultByteNativeArtifactService(): Promise<ArtifactService> {
  defaultByteNativeService ??= createDefaultByteNativeArtifactService();
  return defaultByteNativeService;
}
