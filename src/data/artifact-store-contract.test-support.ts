import { describe, expect, it } from 'vite-plus/test';

import type { Artifact, ArtifactContentStore, ArtifactMetadataStore } from '../artifacts/types.js';

const first: Artifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'first',
  id: 'first',
  mediaType: 'text/plain',
  project: 'alpha',
  title: 'First',
};

const second: Artifact = {
  collection: 'Reports',
  createdAt: '2026-01-02T00:00:00.000Z',
  description: 'second',
  filename: 'notes.md',
  id: 'second',
  mediaType: 'text/markdown',
  project: 'beta',
  title: 'Second',
};

export function metadataStoreContract(
  name: string,
  createStore: () => Promise<ArtifactMetadataStore>,
): void {
  describe(`${name} metadata contract`, () => {
    it('creates, finds, lists, filters, and removes metadata', async () => {
      const store = await createStore();
      await store.create(first);
      await store.create(second);

      await expect(store.find(first.id)).resolves.toEqual(first);
      await expect(store.find('missing')).resolves.toBeNull();
      expect((await store.list()).map(({ id }) => id)).toEqual([second.id, first.id]);
      await expect(store.list({ project: 'alpha' })).resolves.toEqual([first]);
      await expect(store.list({ collection: 'reports' })).resolves.toEqual([second]);
      await expect(store.list({ collection: 'missing' })).resolves.toEqual([]);

      await expect(store.remove(first.id)).resolves.toBe(true);
      await expect(store.remove(first.id)).resolves.toBe(false);
    });
  });
}

export function contentStoreContract(name: string, createStore: () => ArtifactContentStore): void {
  describe(`${name} content contract`, () => {
    it('round-trips arbitrary bytes and supports idempotent removal', async () => {
      const store = createStore();
      const bytes = Uint8Array.from([0, 255, 1, 128, 10]);

      await store.write('asset', 'text/plain', bytes);
      expect([...((await store.read('asset', 'text/plain')) ?? [])]).toEqual([...bytes]);
      await expect(store.remove('asset', 'text/plain')).resolves.toBe(true);
      await expect(store.remove('asset', 'text/plain')).resolves.toBe(false);
    });

    it('reads missing content as null', async () => {
      await expect(createStore().read('missing', 'text/plain')).resolves.toBeNull();
    });
  });
}
