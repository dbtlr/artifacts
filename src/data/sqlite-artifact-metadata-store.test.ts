import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vite-plus/test';

import { metadataStoreContract } from './artifact-store-contract.test-support.js';
import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artifacts-metadata-contract-'));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

metadataStoreContract('sqlite', async () => {
  const databaseDirectory = join(directory, 'database');
  mkdirSync(databaseDirectory, { recursive: true });
  return SqliteArtifactMetadataStore.open(join(databaseDirectory, 'artifacts.db'));
});
