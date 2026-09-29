import { setImmediate } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vite-plus/test';

import { createMemoryStores } from './memory-stores.test-support.js';
import { createArtifactService } from './service.js';
import type { Artifact, ArtifactContentStore, ArtifactMetadataStore } from './types.js';

const artifact: Artifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'description',
  id: 'artifact-id',
  mediaType: 'text/plain',
  project: 'artifacts',
  title: 'Title',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function createRaceFixture() {
  const writes: Uint8Array[] = [];
  let removed = false;
  const metadata: ArtifactMetadataStore = {
    create: async () => undefined,
    find: async () => artifact,
    list: async () => [artifact],
    remove: async () => false,
    update: async () => false,
  };
  const content: ArtifactContentStore = {
    read: async () => new TextEncoder().encode('original'),
    remove: async () => {
      removed = true;
      return true;
    },
    write: async (_id, _type, bytes) => {
      writes.push(bytes);
    },
  };
  return { content, metadata, removed: () => removed, writes };
}

describe('ArtifactService lost metadata races', () => {
  it('rolls content back and returns null when metadata disappears during update', async () => {
    const fixture = createRaceFixture();
    const service = createArtifactService(fixture.metadata, fixture.content);

    await expect(
      service.updateArtifact(artifact.id, { content: new TextEncoder().encode('replacement') }),
    ).resolves.toBeNull();
    expect(fixture.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      'replacement',
      'original',
    ]);
  });

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

  it('removes replacement content when deleting the old media path fails', async () => {
    const previous: Artifact = { ...artifact, filename: 'old.png', mediaType: 'image/png' };
    const writes: string[] = [];
    const removals: string[] = [];
    const service = createArtifactService(
      {
        create: async () => undefined,
        find: async () => previous,
        list: async () => [previous],
        remove: async () => false,
        update: async () => {
          throw new Error('metadata update must not run');
        },
      },
      {
        read: async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        remove: async (_id, mediaType) => {
          removals.push(mediaType);
          if (mediaType === 'image/png') {
            throw new Error('old path removal failed');
          }
          return true;
        },
        write: async (_id, mediaType) => {
          writes.push(mediaType);
          if (mediaType === 'image/png') {
            throw new Error('redundant old-path rewrite must not run');
          }
        },
      },
    );

    await expect(
      service.updateArtifact(previous.id, {
        content: new TextEncoder().encode('%PDF-1.7'),
        filename: 'new.pdf',
        mediaType: 'application/pdf',
      }),
    ).rejects.toThrow('old path removal failed');
    expect(writes).toEqual(['application/pdf']);
    expect(removals).toEqual(['image/png', 'application/pdf']);
  });
});

const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pdfBytes = new TextEncoder().encode('%PDF-1.7');
const png: Artifact = { ...artifact, filename: 'old.png', mediaType: 'image/png' };
const toPdf = { content: pdfBytes, filename: 'new.pdf', mediaType: 'application/pdf' } as const;

describe('ArtifactService concurrent operations', () => {
  it('does not start a remove until an in-flight update has finished', async () => {
    const stores = createMemoryStores([{ artifact: png, bytes: pngBytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    const write = stores.hold('contentWrite');

    const update = service.updateArtifact(png.id, toPdf);
    await write.reached;
    const remove = service.removeArtifact(png.id);
    write.release();

    // Interleaved, the remove would delete the row mid-update, and the
    // update's rollback would then restore the old file with no row.
    await expect(update).resolves.toMatchObject({ mediaType: 'application/pdf' });
    await expect(remove).resolves.toBe(true);
    expect(stores.rows.size).toBe(0);
    expect([...stores.files.keys()]).toEqual([]);
  });

  it('does not serve a get between the file swap and the metadata update', async () => {
    const stores = createMemoryStores([{ artifact: png, bytes: pngBytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    const metadataUpdate = stores.hold('metadataUpdate');

    const update = service.updateArtifact(png.id, toPdf);
    // The old .png is gone and the row still says image/png.
    await metadataUpdate.reached;
    const get = service.getArtifact(png.id);
    metadataUpdate.release();

    await update;
    await expect(get).resolves.toMatchObject({ content: pdfBytes, mediaType: 'application/pdf' });
  });

  it('does not make an operation on one artifact wait for another', async () => {
    const other: Artifact = { ...artifact, id: 'other-id' };
    const stores = createMemoryStores([
      { artifact: png, bytes: pngBytes },
      { artifact: other, bytes: new TextEncoder().encode('other') },
    ]);
    const service = createArtifactService(stores.metadata, stores.content);
    const write = stores.hold('contentWrite');

    const update = service.updateArtifact(png.id, toPdf);
    await write.reached;
    let read = false;
    const get = (async () => {
      await service.getArtifact(other.id);
      read = true;
    })();
    await setImmediate();

    expect(read).toBe(true);
    write.release();
    await Promise.all([update, get]);
  });

  it('resolves a patch from the artifact as an in-flight update leaves it', async () => {
    const stores = createMemoryStores([{ artifact: png, bytes: pngBytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    const write = stores.hold('contentWrite');
    const seen: string[] = [];

    const update = service.updateArtifact(png.id, toPdf);
    await write.reached;
    const retitle = service.updateArtifact(png.id, (current) => {
      seen.push(current.mediaType);
      return { title: 'Retitled' };
    });
    write.release();

    await update;
    await expect(retitle).resolves.toMatchObject({
      mediaType: 'application/pdf',
      title: 'Retitled',
    });
    expect(seen).toEqual(['application/pdf']);
  });

  it('treats a patch resolved to null as no match and changes nothing', async () => {
    const stores = createMemoryStores([{ artifact: png, bytes: pngBytes }]);
    const service = createArtifactService(stores.metadata, stores.content);

    await expect(service.updateArtifact(png.id, () => null)).resolves.toBeNull();
    expect(stores.rows.get(png.id)).toEqual(png);
  });

  it('checks a remove precondition against the artifact as an in-flight update leaves it', async () => {
    const stores = createMemoryStores([{ artifact: png, bytes: pngBytes }]);
    const service = createArtifactService(stores.metadata, stores.content);
    const write = stores.hold('contentWrite');

    const update = service.updateArtifact(png.id, toPdf);
    await write.reached;
    const remove = service.removeArtifact(png.id, (current) => current.mediaType === 'image/png');
    write.release();

    await update;
    await expect(remove).resolves.toBe(false);
    expect(stores.rows.get(png.id)?.mediaType).toBe('application/pdf');
  });
});
