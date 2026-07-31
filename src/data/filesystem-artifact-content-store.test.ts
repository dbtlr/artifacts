import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vite-plus/test';

import { contentStoreContract } from './artifact-store-contract.test-support.js';
import { FilesystemArtifactContentStore } from './filesystem-artifact-content-store.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artifacts-content-contract-'));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

contentStoreContract(
  'filesystem',
  () => new FilesystemArtifactContentStore(join(directory, 'artifacts')),
);
