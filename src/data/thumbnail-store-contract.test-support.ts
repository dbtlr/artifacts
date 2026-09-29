import { describe, expect, it } from 'vite-plus/test';

import type { ThumbnailStore } from '../thumbnails/types.js';

export function thumbnailStoreContract(name: string, createStore: () => ThumbnailStore): void {
  describe(`${name} thumbnail contract`, () => {
    it('round-trips bytes and reports presence', async () => {
      const store = createStore();
      const bytes = Uint8Array.from([255, 216, 255, 1, 2, 3]);

      await expect(store.has('abc123')).resolves.toBe(false);
      await expect(store.read('abc123')).resolves.toBeNull();

      await store.write('abc123', bytes);

      await expect(store.has('abc123')).resolves.toBe(true);
      await expect(store.read('abc123')).resolves.toEqual(bytes);
    });

    it('replaces an existing thumbnail in place', async () => {
      const store = createStore();

      await store.write('abc123', Uint8Array.from([1]));
      await store.write('abc123', Uint8Array.from([2, 3]));

      await expect(store.read('abc123')).resolves.toEqual(Uint8Array.from([2, 3]));
    });

    it('removes a thumbnail and tolerates removing a missing one', async () => {
      const store = createStore();
      await store.write('abc123', Uint8Array.from([1]));

      await store.remove('abc123');
      await store.remove('abc123');

      await expect(store.has('abc123')).resolves.toBe(false);
      await expect(store.read('abc123')).resolves.toBeNull();
    });

    // Ids reach the stores from URL parameters, so every adapter refuses
    // anything but a plain id segment, whatever its backend would accept.
    it.each(['../x', 'a/b', '', 'a.b', 'a b'])('rejects the unsafe id %j', async (id) => {
      const store = createStore();

      await expect(store.has(id)).rejects.toThrow('Invalid thumbnail id');
      await expect(store.read(id)).rejects.toThrow('Invalid thumbnail id');
      await expect(store.write(id, Uint8Array.from([1]))).rejects.toThrow('Invalid thumbnail id');
      await expect(store.remove(id)).rejects.toThrow('Invalid thumbnail id');
    });
  });
}
