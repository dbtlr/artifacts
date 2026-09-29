import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { extractEmbedReferences } from '../artifacts/embeds.js';
import { legacyTypeFromMediaType, mediaTypeFromLegacyType } from '../artifacts/media.js';
import { createArtifactService } from '../artifacts/service.js';
import type {
  Artifact,
  ArtifactService,
  ArtifactStore,
  ArtifactWithContent,
  LegacyArtifact,
} from '../artifacts/types.js';
import { resolveStoragePaths } from '../data-dir.js';
import type { StoragePaths } from '../data-dir.js';
import { resolvePublicBaseUrl } from '../urls.js';
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

function isLegacyText(artifact: Artifact): boolean {
  return legacyTypeFromMediaType(artifact.mediaType) !== undefined;
}

// Copies only the fields of the current model: a caller-supplied store may
// still hand back fields this model has dropped.
function fromLegacyArtifact(artifact: LegacyArtifact): Artifact {
  return {
    createdAt: artifact.createdAt,
    description: artifact.description,
    id: artifact.id,
    mediaType: mediaTypeFromLegacyType(artifact.type),
    project: artifact.project,
    title: artifact.title,
  };
}

// Preserve createApp(store)'s established one-argument embedding API. Its MCP
// surface remains text-only, as the supplied legacy store is, but both the UI
// and MCP operate on the same caller-owned data rather than silently splitting
// across that store and the process default.
export function adaptLegacyArtifactStore(store: ArtifactStore): ArtifactService {
  return {
    createArtifact: async (input) => {
      const type = legacyTypeFromMediaType(input.mediaType);
      if (type === undefined) {
        throw new Error('This configured artifact store only supports text media types');
      }
      if (input.collection !== undefined || input.filename !== undefined) {
        throw new Error('This configured artifact store does not support collection or filename');
      }
      return fromLegacyArtifact(
        await store.createArtifact({
          content: new TextDecoder('utf-8', { fatal: true }).decode(input.content),
          description: input.description,
          project: input.project,
          title: input.title,
          type,
        }),
      );
    },
    findArtifact: async (id) => {
      const artifact = (await store.listArtifacts()).find((candidate) => candidate.id === id);
      return artifact === undefined ? null : fromLegacyArtifact(artifact);
    },
    getArtifact: async (id): Promise<ArtifactWithContent | null> => {
      const artifact = await store.getArtifact(id);
      if (artifact === null) {
        return null;
      }
      const { content, ...metadata } = artifact;
      return { ...fromLegacyArtifact(metadata), content: new TextEncoder().encode(content) };
    },
    // A caller-supplied store has nowhere to keep derived data, so an HTML
    // artifact's references are extracted on every view.
    getEmbedReferences: async (id) => {
      const artifact = await store.getArtifact(id);
      return artifact?.type === 'html'
        ? extractEmbedReferences(artifact.content, resolvePublicBaseUrl())
        : null;
    },
    listArtifacts: async (query) => (await store.listArtifacts(query)).map(fromLegacyArtifact),
    removeArtifact: (id) => store.removeArtifact(id),
  };
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
