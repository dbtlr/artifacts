import { describe, expect, it } from 'vite-plus/test';

import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  EmbedTemplate,
  StoredMarkdownRendering,
} from '../artifacts/types.js';

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

const template: EmbedTemplate = {
  extractorVersion: 1,
  references: [
    { id: 'image-one', start: 10 },
    { id: 'image-two', start: 42 },
  ],
};

const newerTemplate: EmbedTemplate = { extractorVersion: 2, references: [] };

const rendering: StoredMarkdownRendering = {
  hasHighlightableCode: false,
  hasMermaid: true,
  html: '<p>first</p>',
  rendererVersion: 1,
  toc: undefined,
};

const renderingWithToc: StoredMarkdownRendering = {
  hasHighlightableCode: true,
  hasMermaid: false,
  html: '<h2 id="heading-a">A</h2>',
  rendererVersion: 2,
  toc: '<nav class="toc"></nav>',
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

    it('rejects a create under a taken id and keeps the stored row', async () => {
      const store = await createStore();
      await store.create(first);

      await expect(store.create({ ...second, id: first.id })).rejects.toThrow();

      await expect(store.list()).resolves.toEqual([first]);
    });

    it('stores, replaces, and drops an embed template with its artifact', async () => {
      const store = await createStore();
      await store.create(first);

      await expect(store.findEmbedTemplate(first.id)).resolves.toBeNull();
      await store.saveEmbedTemplate(first.id, template);
      await expect(store.findEmbedTemplate(first.id)).resolves.toEqual(template);
      await store.saveEmbedTemplate(first.id, newerTemplate);
      await expect(store.findEmbedTemplate(first.id)).resolves.toEqual(newerTemplate);

      await store.remove(first.id);
      await expect(store.findEmbedTemplate(first.id)).resolves.toBeNull();
    });

    // A save that loses a race with a remove must not leave an orphan.
    it('stores no embed template for an id without an artifact', async () => {
      const store = await createStore();

      await store.saveEmbedTemplate('missing', template);

      await expect(store.findEmbedTemplate('missing')).resolves.toBeNull();
    });

    it('stores, replaces, and drops a rendering with its artifact', async () => {
      const store = await createStore();
      await store.create(second);

      await expect(store.findRendering(second.id)).resolves.toBeNull();
      await store.saveRendering(second.id, rendering);
      await expect(store.findRendering(second.id)).resolves.toEqual(rendering);
      await store.saveRendering(second.id, renderingWithToc);
      await expect(store.findRendering(second.id)).resolves.toEqual(renderingWithToc);

      await store.remove(second.id);
      await expect(store.findRendering(second.id)).resolves.toBeNull();
    });

    // A save that loses a race with a remove must not leave an orphan.
    it('stores no rendering for an id without an artifact', async () => {
      const store = await createStore();

      await store.saveRendering('missing', rendering);

      await expect(store.findRendering('missing')).resolves.toBeNull();
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

    // Ids reach the stores from URL parameters, so every adapter refuses
    // anything but a plain id segment, whatever its backend would accept.
    it.each(['../escape', 'nested/escape', String.raw`nested\escape`, '.', ''])(
      'rejects the unsafe id %j',
      async (id) => {
        const store = createStore();

        await expect(store.write(id, 'text/plain', new Uint8Array())).rejects.toThrow(
          'Invalid artifact id',
        );
        await expect(store.read(id, 'text/plain')).rejects.toThrow('Invalid artifact id');
        await expect(store.remove(id, 'text/plain')).rejects.toThrow('Invalid artifact id');
      },
    );
  });
}
