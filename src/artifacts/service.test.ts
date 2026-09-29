import type { nanoid } from 'nanoid';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { MarkdownRenderer } from '../markdown.js';
import { EMBED_EXTRACTOR_VERSION } from './embeds.js';
import { CreateOutcomeUnknownError } from './errors.js';
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
    findRendering: async () => null,
    list: async () => [artifact],
    remove: async () => false,
    saveEmbedTemplate: async () => undefined,
    saveRendering: async () => undefined,
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

  // Content without a row is invisible; a row without content fails every
  // read. When the store cannot tell which happened, the content stays.
  it('keeps the content when the metadata create has an unknown outcome', async () => {
    const stores = createMemoryStores();
    const unknown = new CreateOutcomeUnknownError('artifact-id', new Error('D1 timed out'));
    const service = createArtifactService(
      {
        ...stores.metadata,
        create: async (created) => {
          await stores.metadata.create(created);
          throw unknown;
        },
      },
      stores.content,
    );

    await expect(
      service.createArtifact({
        content: new TextEncoder().encode('content'),
        description: 'description',
        mediaType: 'text/plain',
        project: 'artifacts',
        title: 'Title',
      }),
    ).rejects.toThrow(unknown);

    const [stored] = stores.rows.values();
    await expect(service.getArtifact(stored!.id)).resolves.toMatchObject({
      content: new TextEncoder().encode('content'),
    });
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

// A stand-in renderer whose output names its version and source, and which
// records every source it is asked to parse.
function countingRenderer(version: number) {
  const parsed: string[] = [];
  const renderer: MarkdownRenderer = {
    render: (markdown) => {
      parsed.push(markdown);
      return {
        hasHighlightableCode: false,
        hasMermaid: false,
        html: `<p>v${String(version)}: ${markdown}</p>`,
        toc: undefined,
      };
    },
    version,
  };
  return { parsed, renderer };
}

const markdownInput: CreateArtifactInput = {
  content: new TextEncoder().encode('# Notes'),
  description: 'description',
  mediaType: 'text/markdown',
  project: 'artifacts',
  title: 'Notes',
};

describe('ArtifactService Markdown renderings', () => {
  it('renders Markdown once, at create, so views parse nothing', async () => {
    const stores = createMemoryStores();
    const { parsed, renderer } = countingRenderer(1);
    const service = createArtifactService(stores.metadata, stores.content, renderer);

    const created = await service.createArtifact(markdownInput);
    expect(parsed).toEqual(['# Notes']);

    await expect(service.getRenderedMarkdown(created.id)).resolves.toMatchObject({
      html: '<p>v1: # Notes</p>',
    });
    await service.getRenderedMarkdown(created.id);
    expect(parsed).toEqual(['# Notes']);
  });

  it('renders and stores a missing rendering on its first view only', async () => {
    const stores = createMemoryStores([
      { artifact: { ...artifact, mediaType: 'text/markdown' }, bytes: markdownInput.content },
    ]);
    const { parsed, renderer } = countingRenderer(1);
    const service = createArtifactService(stores.metadata, stores.content, renderer);

    await expect(service.getRenderedMarkdown(artifact.id)).resolves.toMatchObject({
      html: '<p>v1: # Notes</p>',
    });
    await service.getRenderedMarkdown(artifact.id);

    expect(parsed).toEqual(['# Notes']);
  });

  it('renders again a rendering stored by another renderer version', async () => {
    const stores = createMemoryStores();
    const older = createArtifactService(
      stores.metadata,
      stores.content,
      countingRenderer(1).renderer,
    );
    const created = await older.createArtifact(markdownInput);
    const { parsed, renderer } = countingRenderer(2);
    const newer = createArtifactService(stores.metadata, stores.content, renderer);

    await expect(newer.getRenderedMarkdown(created.id)).resolves.toMatchObject({
      html: '<p>v2: # Notes</p>',
    });
    await newer.getRenderedMarkdown(created.id);

    expect(parsed).toEqual(['# Notes']);
  });

  it('renders nothing for other media types, and resolves null for them', async () => {
    const stores = createMemoryStores();
    const { parsed, renderer } = countingRenderer(1);
    const service = createArtifactService(stores.metadata, stores.content, renderer);

    const created = await service.createArtifact(input);

    await expect(service.getRenderedMarkdown(created.id)).resolves.toBeNull();
    await expect(service.getRenderedMarkdown('missing')).resolves.toBeNull();
    expect(parsed).toEqual([]);
  });

  it('keeps a created artifact when storing its rendering fails', async () => {
    const stores = createMemoryStores();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { parsed, renderer } = countingRenderer(1);
    const service = createArtifactService(
      {
        ...stores.metadata,
        saveRendering: async () => {
          throw new Error('rendering write failed');
        },
      },
      stores.content,
      renderer,
    );

    const created = await service.createArtifact(markdownInput);

    await expect(service.findArtifact(created.id)).resolves.toEqual(created);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('rendering write failed'));
    // Nothing was stored, so the view renders it again.
    await expect(service.getRenderedMarkdown(created.id)).resolves.toMatchObject({
      html: '<p>v1: # Notes</p>',
    });
    expect(parsed).toEqual(['# Notes', '# Notes']);
    stderr.mockRestore();
  });

  it('renders the content again when reading the stored rendering fails', async () => {
    const stores = createMemoryStores([
      { artifact: { ...artifact, mediaType: 'text/markdown' }, bytes: markdownInput.content },
    ]);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const service = createArtifactService(
      {
        ...stores.metadata,
        findRendering: async () => {
          throw new Error('rendering read failed');
        },
      },
      stores.content,
      countingRenderer(1).renderer,
    );

    await expect(service.getRenderedMarkdown(artifact.id)).resolves.toMatchObject({
      html: '<p>v1: # Notes</p>',
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('rendering read failed'));
    stderr.mockRestore();
  });
});
