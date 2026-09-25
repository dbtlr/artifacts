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
  updatedAt: '2026-09-24T10:00:00.000Z',
};

function stubService(overrides: Partial<ArtifactService> = {}): ArtifactService {
  return {
    createArtifact: () => sample,
    findArtifact: () => sample,
    getArtifact: () => ({ ...sample, content: new Uint8Array() }),
    listArtifacts: () => [sample],
    removeArtifact: () => true,
    updateArtifact: () => sample,
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
    remove: (id) => {
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
  it('queues a render after a successful create', () => {
    const { enqueued, wrapped } = harness(stubService());

    expect(wrapped.createArtifact(input)).toEqual(sample);
    expect(enqueued).toEqual(['abc']);
  });

  it('does not queue when create throws', () => {
    const { enqueued, wrapped } = harness(
      stubService({
        createArtifact: () => {
          throw new Error('invalid');
        },
      }),
    );

    expect(() => wrapped.createArtifact(input)).toThrow('invalid');
    expect(enqueued).toEqual([]);
  });

  it('queues a render after a successful update, but not for an unknown id', () => {
    const { enqueued, wrapped } = harness(stubService());
    expect(wrapped.updateArtifact('abc', { title: 'new' })).toEqual(sample);
    expect(enqueued).toEqual(['abc']);

    const missing = harness(stubService({ updateArtifact: () => null }));
    expect(missing.wrapped.updateArtifact('nope', { title: 'new' })).toBeNull();
    expect(missing.enqueued).toEqual([]);
  });

  it('drops the stored thumbnail after a successful remove only', () => {
    const { removed, wrapped } = harness(stubService());
    expect(wrapped.removeArtifact('abc')).toBe(true);
    expect(removed).toEqual(['abc']);

    const missing = harness(stubService({ removeArtifact: () => false }));
    expect(missing.wrapped.removeArtifact('nope')).toBe(false);
    expect(missing.removed).toEqual([]);
  });

  it('passes reads straight through', () => {
    const { wrapped } = harness(stubService());

    expect(wrapped.findArtifact('abc')).toEqual(sample);
    expect(wrapped.listArtifacts()).toEqual([sample]);
    expect(wrapped.getArtifact('abc')?.id).toBe('abc');
  });
});
