import { describe, expect, it } from 'vite-plus/test';

import type { Artifact, ArtifactContentStore, ArtifactMetadataStore } from '../artifacts/types.js';

const first: Artifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'first',
  id: 'first',
  project: 'alpha',
  title: 'First',
  type: 'txt',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const second: Artifact = {
  createdAt: '2026-01-02T00:00:00.000Z',
  description: 'second',
  id: 'second',
  project: 'beta',
  title: 'Second',
  type: 'md',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

export function metadataStoreContract(
  name: string,
  createStore: () => Promise<ArtifactMetadataStore>,
): void {
  describe(`${name} metadata contract`, () => {
    it('creates, finds, updates, lists, filters, and removes metadata', async () => {
      const store = await createStore();
      store.create(first);
      store.create(second);

      expect(store.find(first.id)).toEqual(first);
      expect(store.find('missing')).toBeNull();
      expect(store.list().map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(store.list({ project: 'alpha' })).toEqual([first]);

      const updated = { ...first, title: 'Updated', updatedAt: '2026-01-03T00:00:00.000Z' };
      expect(store.update(updated)).toBe(true);
      expect(store.find(first.id)).toEqual(updated);
      expect(store.remove(first.id)).toBe(true);
      expect(store.remove(first.id)).toBe(false);
    });
  });
}

export function contentStoreContract(name: string, createStore: () => ArtifactContentStore): void {
  describe(`${name} content contract`, () => {
    it('round-trips arbitrary bytes and supports move and idempotent removal', () => {
      const store = createStore();
      const bytes = Uint8Array.from([0, 255, 1, 128, 10]);

      store.write('asset', 'txt', bytes);
      expect([...store.read('asset', 'txt')]).toEqual([...bytes]);
      store.move('asset', 'txt', 'md');
      expect([...store.read('asset', 'md')]).toEqual([...bytes]);
      expect(store.remove('asset', 'md')).toBe(true);
      expect(store.remove('asset', 'md')).toBe(false);
    });
  });
}
