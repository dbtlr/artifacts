import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { FilesystemThumbnailStore } from './filesystem-thumbnail-store.js';

describe('FilesystemThumbnailStore', () => {
  let dir: string;
  let store: FilesystemThumbnailStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artifacts-thumbs-'));
    // A nested, not-yet-existing directory: the store creates it on demand.
    store = new FilesystemThumbnailStore(join(dir, 'thumbs'));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it('round-trips bytes and reports presence', async () => {
    const bytes = Uint8Array.from([255, 216, 255, 1, 2, 3]);

    await expect(store.has('abc123')).resolves.toBe(false);
    await expect(store.read('abc123')).resolves.toBeNull();

    await store.write('abc123', bytes);

    await expect(store.has('abc123')).resolves.toBe(true);
    await expect(store.read('abc123')).resolves.toEqual(bytes);
    await expect(readdir(join(dir, 'thumbs'))).resolves.toEqual(['abc123.jpg']);
  });

  it('replaces an existing thumbnail in place', async () => {
    await store.write('abc123', Uint8Array.from([1]));
    await store.write('abc123', Uint8Array.from([2, 3]));

    await expect(store.read('abc123')).resolves.toEqual(Uint8Array.from([2, 3]));
  });

  it('removes a thumbnail and tolerates removing a missing one', async () => {
    await store.write('abc123', Uint8Array.from([1]));

    await store.remove('abc123');
    await store.remove('abc123');

    await expect(store.has('abc123')).resolves.toBe(false);
  });

  it.each(['../x', 'a/b', '', 'a.b', 'a b'])('rejects the unsafe id %j', async (id) => {
    await expect(store.read(id)).rejects.toThrow('Invalid thumbnail id');
    await expect(store.write(id, Uint8Array.from([1]))).rejects.toThrow('Invalid thumbnail id');
  });
});
