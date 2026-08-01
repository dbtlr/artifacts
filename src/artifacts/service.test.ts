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
    create: () => undefined,
    find: () => artifact,
    list: () => [artifact],
    remove: () => false,
    update: () => false,
  };
  const content: ArtifactContentStore = {
    read: () => new TextEncoder().encode('original'),
    remove: () => {
      removed = true;
      return true;
    },
    write: (_id, _type, bytes) => writes.push(bytes),
  };
  return { content, metadata, removed: () => removed, writes };
}

describe('ArtifactService lost metadata races', () => {
  it('rolls content back and returns null when metadata disappears during update', () => {
    const fixture = createRaceFixture();
    const service = createArtifactService(fixture.metadata, fixture.content);

    expect(
      service.updateArtifact(artifact.id, { content: new TextEncoder().encode('replacement') }),
    ).toBeNull();
    expect(fixture.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      'replacement',
      'original',
    ]);
  });

  it('does not remove content when metadata disappears during removal', () => {
    const fixture = createRaceFixture();
    const service = createArtifactService(fixture.metadata, fixture.content);

    expect(service.removeArtifact(artifact.id)).toBe(false);
    expect(fixture.removed()).toBe(false);
  });

  it('preserves a create error when compensating content cleanup also fails', () => {
    const fixture = createRaceFixture();
    const createError = new Error('metadata create failed');
    const cleanupError = new Error('content cleanup failed');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const service = createArtifactService(
      {
        ...fixture.metadata,
        create: () => {
          throw createError;
        },
        find: () => null,
      },
      {
        ...fixture.content,
        remove: () => {
          throw cleanupError;
        },
      },
    );

    expect(() =>
      service.createArtifact({
        content: new TextEncoder().encode('content'),
        description: 'description',
        mediaType: 'text/plain',
        project: 'artifacts',
        title: 'Title',
      }),
    ).toThrow(createError);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(cleanupError.message));
    stderr.mockRestore();
  });

  it('reports orphan cleanup but returns success after metadata removal commits', () => {
    const fixture = createRaceFixture();
    const cleanupError = new Error('content cleanup failed');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const service = createArtifactService(
      { ...fixture.metadata, remove: () => true },
      {
        ...fixture.content,
        remove: () => {
          throw cleanupError;
        },
      },
    );

    expect(service.removeArtifact(artifact.id)).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(cleanupError.message));
    stderr.mockRestore();
  });

  it('removes replacement content when deleting the old media path fails', () => {
    const previous: Artifact = { ...artifact, filename: 'old.png', mediaType: 'image/png' };
    const writes: string[] = [];
    const removals: string[] = [];
    const service = createArtifactService(
      {
        create: () => undefined,
        find: () => previous,
        list: () => [previous],
        remove: () => false,
        update: () => {
          throw new Error('metadata update must not run');
        },
      },
      {
        read: () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        remove: (_id, mediaType) => {
          removals.push(mediaType);
          if (mediaType === 'image/png') {
            throw new Error('old path removal failed');
          }
          return true;
        },
        write: (_id, mediaType) => writes.push(mediaType),
      },
    );

    expect(() =>
      service.updateArtifact(previous.id, {
        content: new TextEncoder().encode('%PDF-1.7'),
        filename: 'new.pdf',
        mediaType: 'application/pdf',
      }),
    ).toThrow('old path removal failed');
    expect(writes).toEqual(['application/pdf', 'image/png']);
    expect(removals).toEqual(['image/png', 'application/pdf']);
  });
});
