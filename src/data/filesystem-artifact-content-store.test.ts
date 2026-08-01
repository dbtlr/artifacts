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
  it.each(['../escape', 'nested/escape', String.raw`nested\escape`, '.', ''])(
    'rejects unsafe id %j',
    (id) => {
      const store = new FilesystemArtifactContentStore(join(directory, 'artifacts'));

      expect(() => store.write(id, 'text/plain', new Uint8Array())).toThrow('Invalid artifact id');
    },
  );

  it('atomically replaces the target without leaving temporary files', () => {
    const filesDir = join(directory, 'artifacts');
    const store = new FilesystemArtifactContentStore(filesDir);

    store.write('safe-id', 'text/plain', Uint8Array.from([1, 2]));
    store.write('safe-id', 'text/plain', Uint8Array.from([3, 4]));

    expect([...store.read('safe-id', 'text/plain')]).toEqual([3, 4]);
    expect(readdirSync(filesDir)).toEqual(['safe-id.txt']);
  });
});
