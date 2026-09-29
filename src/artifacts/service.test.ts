import type { nanoid } from 'nanoid';
import { describe, expect, it, vi } from 'vite-plus/test';

import { EMBED_EXTRACTOR_VERSION } from './embeds.js';
import { createMemoryStores } from './memory-stores.test-support.js';
import { createArtifactService } from './service.js';
import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  CreateArtifactInput,
} from './types.js';

// Ids queued here are handed out by nanoid before it generates fresh ones.
const ids = vi.hoisted(() => ({ next: [] as string[] }));

vi.mock('nanoid', async (importOriginal) => {
  const actual = await importOriginal<{ nanoid: typeof nanoid }>();
  return { ...actual, nanoid: (size?: number) => ids.next.shift() ?? actual.nanoid(size) };
});

const artifact: Artifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'description',
  id: 'artifact-id',
  mediaType: 'text/plain',
  project: 'artifacts',
  title: 'Title',
};

function createRaceFixture() {
  let removed = false;
  const metadata: ArtifactMetadataStore = {
    create: async () => undefined,
    find: async () => artifact,
    findEmbedTemplate: async () => null,
    list: async () => [artifact],
    remove: async () => false,
    saveEmbedTemplate: async () => undefined,
  };
  const content: ArtifactContentStore = {
    read: async () => new TextEncoder().encode('original'),
    remove: async () => {
      removed = true;
      return true;
    },
    write: async () => undefined,
  };
  return { content, metadata, removed: () => removed };
}

describe('ArtifactService lost metadata races', () => {
  it('does not remove content when metadata disappears during removal', async () => {
    const fixture = createRaceFixture();
    const service = createArtifactService(fixture.metadata, fixture.content);

    await expect(service.removeArtifact(artifact.id)).resolves.toBe(false);
    expect(fixture.removed()).toBe(false);
  });

  it('preserves a create error when compensating content cleanup also fails', async () => {
    const fixture = createRaceFixture();
    const createError = new Error('metadata create failed');
    const cleanupError = new Error('content cleanup failed');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const service = createArtifactService(
      {
        ...fixture.metadata,
        create: async () => {
          throw createError;
        },
        find: async () => null,
      },
      {
        ...fixture.content,
        remove: async () => {
          throw cleanupError;
        },
      },
    );

    await expect(
      service.createArtifact({
        content: new TextEncoder().encode('content'),
        description: 'description',
        mediaType: 'text/plain',
        project: 'artifacts',
        title: 'Title',
      }),
    ).rejects.toThrow(createError);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(cleanupError.message));
    stderr.mockRestore();
  });

  it('reports orphan cleanup but returns success after metadata removal commits', async () => {
    const fixture = createRaceFixture();
    const cleanupError = new Error('content cleanup failed');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const service = createArtifactService(
      { ...fixture.metadata, remove: async () => true },
      {
        ...fixture.content,
        remove: async () => {
          throw cleanupError;
        },
      },
    );

    await expect(service.removeArtifact(artifact.id)).resolves.toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(cleanupError.message));
    stderr.mockRestore();
  });
});

const bytes = new TextEncoder().encode('text');
const input: CreateArtifactInput = {
  content: bytes,
  description: 'description',
  mediaType: 'text/plain',
  project: 'artifacts',
  title: 'Title',
};

describe('ArtifactService concurrent operations', () => {
  it('writes content before metadata, so a listed artifact always has content', async () => {
    const stores = createMemoryStores();
    const service = createArtifactService(stores.metadata, stores.content);
    const metadataCreate = stores.hold('metadataCreate');

    const create = service.createArtifact(input);
    await metadataCreate.reached;

    expect(stores.files.size).toBe(1);
    await expect(service.listArtifacts()).resolves.toEqual([]);
    metadataCreate.release();
    const created = await create;
    await expect(service.getArtifact(created.id)).resolves.toMatchObject({ content: bytes });
  });

  it('removes metadata before content, so a get mid-remove finds nothing', async () => {
    const stores = createMemoryStores([{ artifact, bytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    const contentRemove = stores.hold('contentRemove');

    const remove = service.removeArtifact(artifact.id);
    await contentRemove.reached;

    await expect(service.getArtifact(artifact.id)).resolves.toBeNull();
    contentRemove.release();
    await expect(remove).resolves.toBe(true);
    expect(stores.files.size).toBe(0);
  });

  it('resolves a get to null when a remove lands between its metadata and content reads', async () => {
    const stores = createMemoryStores([{ artifact, bytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    const contentRead = stores.hold('contentRead');

    const get = service.getArtifact(artifact.id);
    await contentRead.reached;
    await expect(service.removeArtifact(artifact.id)).resolves.toBe(true);
    contentRead.release();

    await expect(get).resolves.toBeNull();
  });

  it('rejects a get whose metadata remains but whose content is missing', async () => {
    const stores = createMemoryStores([{ artifact, bytes }]);
    stores.files.clear();
    const service = createArtifactService(stores.metadata, stores.content);

    await expect(service.getArtifact(artifact.id)).rejects.toThrow('content is missing');
  });

  it('reports one removal when two removes of the same artifact race', async () => {
    const stores = createMemoryStores([{ artifact, bytes }]);
    const service = createArtifactService(stores.metadata, stores.content);

    const results = await Promise.all([
      service.removeArtifact(artifact.id),
      service.removeArtifact(artifact.id),
    ]);

    expect(results.filter((removed) => removed)).toEqual([true]);
    expect(stores.rows.size).toBe(0);
    expect(stores.files.size).toBe(0);
  });

  it('stores concurrent creates as distinct artifacts', async () => {
    const stores = createMemoryStores();
    const service = createArtifactService(stores.metadata, stores.content);

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.createArtifact({ ...input, title: `Title ${String(index)}` }),
      ),
    );

    expect(new Set(created.map(({ id }) => id)).size).toBe(10);
    expect(stores.rows.size).toBe(10);
    expect(stores.files.size).toBe(10);
  });
});

describe('ArtifactService ids', () => {
  it('draws a new id instead of overwriting an existing artifact', async () => {
    const stores = createMemoryStores([{ artifact, bytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    ids.next.push(artifact.id);

    const created = await service.createArtifact({
      ...input,
      content: new TextEncoder().encode('new'),
    });

    expect(created.id).not.toBe(artifact.id);
    await expect(service.getArtifact(artifact.id)).resolves.toMatchObject({ content: bytes });
  });
});

const htmlPage = '<p>Chart</p><img src="/a/chart-id" alt="chart">';
const chartStart = htmlPage.indexOf('/a/chart-id');

const htmlInput: CreateArtifactInput = {
  content: new TextEncoder().encode(htmlPage),
  description: 'description',
  mediaType: 'text/html',
  project: 'artifacts',
  title: 'Page',
};

describe('ArtifactService embed templates', () => {
  it('extracts an HTML artifact’s embed template when it is created', async () => {
    const stores = createMemoryStores();
    const service = createArtifactService(stores.metadata, stores.content);

    const created = await service.createArtifact(htmlInput);

    expect(stores.templates.get(created.id)).toEqual({
      extractorVersion: EMBED_EXTRACTOR_VERSION,
      references: [{ id: 'chart-id', start: chartStart }],
    });
  });

  it('answers from the stored template without reading the content', async () => {
    const stores = createMemoryStores();
    const service = createArtifactService(stores.metadata, stores.content);
    const created = await service.createArtifact(htmlInput);
    stores.files.clear();

    await expect(service.getEmbedReferences(created.id)).resolves.toEqual([
      { id: 'chart-id', start: chartStart },
    ]);
  });

  it.each([
    ['a missing', undefined],
    ['an outdated', { extractorVersion: EMBED_EXTRACTOR_VERSION + 1, references: [] }],
  ])('extracts and stores %s template on its first view', async (_state, stored) => {
    const page = { ...artifact, mediaType: 'text/html' as const };
    const stores = createMemoryStores([{ artifact: page, bytes: htmlInput.content }]);
    if (stored !== undefined) {
      stores.templates.set(page.id, stored);
    }
    const service = createArtifactService(stores.metadata, stores.content);

    await expect(service.getEmbedReferences(page.id)).resolves.toEqual([
      { id: 'chart-id', start: chartStart },
    ]);
    expect(stores.templates.get(page.id)?.extractorVersion).toBe(EMBED_EXTRACTOR_VERSION);
  });

  it('has no template for other media types or a missing id', async () => {
    const stores = createMemoryStores();
    const service = createArtifactService(stores.metadata, stores.content);

    const created = await service.createArtifact({ ...input, content: htmlInput.content });

    expect(stores.templates.size).toBe(0);
    await expect(service.getEmbedReferences(created.id)).resolves.toBeNull();
    await expect(service.getEmbedReferences('missing')).resolves.toBeNull();
  });

  it('keeps a created artifact when storing its template fails', async () => {
    const stores = createMemoryStores();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const service = createArtifactService(
      {
        ...stores.metadata,
        saveEmbedTemplate: async () => {
          throw new Error('template write failed');
        },
      },
      stores.content,
    );

    const created = await service.createArtifact(htmlInput);

    await expect(service.findArtifact(created.id)).resolves.toEqual(created);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('template write failed'));
    await expect(service.getEmbedReferences(created.id)).resolves.toEqual([
      { id: 'chart-id', start: chartStart },
    ]);
    stderr.mockRestore();
  });
});
