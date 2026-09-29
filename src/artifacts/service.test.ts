import { describe, expect, it, vi } from 'vite-plus/test';

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

// Map-backed stores whose content writes wait for the test to open a gate,
// so a second operation can be started while the first is mid-flight.
function createGatedStores(initial: Artifact, bytes: Uint8Array) {
  const rows = new Map([[initial.id, initial]]);
  const files = new Map([[`${initial.id}:${initial.mediaType}`, bytes]]);
  const writeGate = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  const metadata: ArtifactMetadataStore = {
    create: async (next) => {
      rows.set(next.id, next);
    },
    find: async (id) => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    remove: async (id) => rows.delete(id),
    update: async (next) => rows.has(next.id) && Boolean(rows.set(next.id, next)),
  };
  const content: ArtifactContentStore = {
    read: async (id, mediaType) => {
      const stored = files.get(`${id}:${mediaType}`);
      if (stored === undefined) {
        throw new Error(`ENOENT ${id}:${mediaType}`);
      }
      return stored;
    },
    remove: async (id, mediaType) => files.delete(`${id}:${mediaType}`),
    write: async (id, mediaType, next) => {
      writeStarted.resolve();
      await writeGate.promise;
      files.set(`${id}:${mediaType}`, next);
    },
  };
  return { content, files, metadata, openWrites: writeGate.resolve, rows, writeStarted };
}

describe('ArtifactService concurrent operations', () => {
  it('does not start a remove until an in-flight update has finished', async () => {
    const previous: Artifact = { ...artifact, filename: 'old.png', mediaType: 'image/png' };
    const stores = createGatedStores(previous, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const service = createArtifactService(stores.metadata, stores.content);

    const update = service.updateArtifact(previous.id, {
      content: new TextEncoder().encode('%PDF-1.7'),
      filename: 'new.pdf',
      mediaType: 'application/pdf',
    });
    await stores.writeStarted.promise;
    const remove = service.removeArtifact(previous.id);
    stores.openWrites();

    // Interleaved, the remove would delete the row mid-update, and the
    // update's rollback would then restore the old file with no row.
    await expect(update).resolves.toMatchObject({ mediaType: 'application/pdf' });
    await expect(remove).resolves.toBe(true);
    expect(stores.rows.size).toBe(0);
    expect([...stores.files.keys()]).toEqual([]);
  });
});
