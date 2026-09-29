import { describe, expect, it } from 'vite-plus/test';

import type { Artifact, ArtifactService } from '../artifacts/types.js';
import { withThumbnails } from './with-thumbnails.js';

const sample: Artifact = {
  createdAt: '2026-09-24T10:00:00.000Z',
  description: 'd',
  id: 'abc',
  mediaType: 'text/html',
  project: 'p',
  title: 't',
};

function stubService(overrides: Partial<ArtifactService> = {}): ArtifactService {
  return {
    createArtifact: async () => sample,
    findArtifact: async () => sample,
    getArtifact: async () => ({ ...sample, content: new Uint8Array() }),
    getEmbedReferences: async () => [],
    listArtifacts: async () => [sample],
    removeArtifact: async () => true,
    ...overrides,
  };
}

function harness(service: ArtifactService) {
  const enqueued: string[] = [];
  const removed: string[] = [];
  const wrapped = withThumbnails(service, {
    enqueue: (id) => {
      enqueued.push(id);
    },
    remove: async (id) => {
      removed.push(id);
    },
  });
  return { enqueued, removed, wrapped };
}

const input = {
  content: new TextEncoder().encode('<p>x</p>'),
  description: 'd',
  mediaType: 'text/html' as const,
  project: 'p',
  title: 't',
};

describe('withThumbnails', () => {
  it('queues a render after a successful create', async () => {
    const { enqueued, wrapped } = harness(stubService());

    await expect(wrapped.createArtifact(input)).resolves.toEqual(sample);
    expect(enqueued).toEqual(['abc']);
  });

  it('does not queue when create throws', async () => {
    const { enqueued, wrapped } = harness(
      stubService({
        createArtifact: async () => {
          throw new Error('invalid');
        },
      }),
    );

    await expect(wrapped.createArtifact(input)).rejects.toThrow('invalid');
    expect(enqueued).toEqual([]);
  });

  it('drops the stored thumbnail after a successful remove only', async () => {
    const { removed, wrapped } = harness(stubService());
    await expect(wrapped.removeArtifact('abc')).resolves.toBe(true);
    expect(removed).toEqual(['abc']);

    const missing = harness(stubService({ removeArtifact: async () => false }));
    await expect(missing.wrapped.removeArtifact('nope')).resolves.toBe(false);
    expect(missing.removed).toEqual([]);
  });

  it('passes reads straight through', async () => {
    const { wrapped } = harness(stubService());

    await expect(wrapped.findArtifact('abc')).resolves.toEqual(sample);
    await expect(wrapped.listArtifacts()).resolves.toEqual([sample]);
    expect((await wrapped.getArtifact('abc'))?.id).toBe('abc');
  });
});
