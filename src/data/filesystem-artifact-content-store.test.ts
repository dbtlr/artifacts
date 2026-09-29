import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

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

describe('FilesystemArtifactContentStore hardening', () => {
  it('atomically replaces the target without leaving temporary files', async () => {
    const filesDir = join(directory, 'artifacts');
    const store = new FilesystemArtifactContentStore(filesDir);

    await store.write('safe-id', 'text/plain', Uint8Array.from([1, 2]));
    await store.write('safe-id', 'text/plain', Uint8Array.from([3, 4]));

    expect([...((await store.read('safe-id', 'text/plain')) ?? [])]).toEqual([3, 4]);
    expect(readdirSync(filesDir)).toEqual(['safe-id.txt']);
  });
});
