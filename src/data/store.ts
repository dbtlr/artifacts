import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createArtifactService } from '../artifacts/service.js';
import type { ArtifactService } from '../artifacts/types.js';
import { resolveStoragePaths } from '../data-dir.js';
import type { StoragePaths } from '../data-dir.js';
import { FilesystemArtifactContentStore } from './filesystem-artifact-content-store.js';
import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';

export type * from '../artifacts/types.js';

// The composition root is the only place that knows which persistence
// adapters back the service. There is intentionally no backend registry.
export async function createArtifactStore({
  databasePath,
  filesDir,
}: StoragePaths): Promise<ArtifactService> {
  mkdirSync(dirname(databasePath), { recursive: true });
  const metadata = await SqliteArtifactMetadataStore.open(databasePath);
  const content = new FilesystemArtifactContentStore(filesDir);
  return createArtifactService(metadata, content);
}

let defaultStore: Promise<ArtifactService> | undefined;

export function getDefaultArtifactStore(): Promise<ArtifactService> {
  defaultStore ??= createArtifactStore(resolveStoragePaths());
  return defaultStore;
}
