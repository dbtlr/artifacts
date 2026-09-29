import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { FilesystemThumbnailStore } from './filesystem-thumbnail-store.js';
import { thumbnailStoreContract } from './thumbnail-store-contract.test-support.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artifacts-thumbs-'));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

// A nested, not-yet-existing directory: the store creates it on demand.
thumbnailStoreContract('filesystem', () => new FilesystemThumbnailStore(join(dir, 'thumbs')));

describe('FilesystemThumbnailStore', () => {
  it('keeps one JPEG per artifact and no temporary files', async () => {
    const store = new FilesystemThumbnailStore(join(dir, 'thumbs'));

    await store.write('abc123', Uint8Array.from([1]));
    await store.write('abc123', Uint8Array.from([2, 3]));

    await expect(readdir(join(dir, 'thumbs'))).resolves.toEqual(['abc123.jpg']);
  });
});
