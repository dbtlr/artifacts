import { describe, expect, it } from 'vite-plus/test';

import type { Artifact } from '../artifacts/types.js';
import { createThumbnailQueue } from './queue.js';
import type { ThumbnailRenderer, ThumbnailStore, ThumbnailTarget } from './types.js';

function artifact(id: string): Artifact {
  return {
    createdAt: '2026-09-24T10:00:00.000Z',
    description: 'd',
    id,
    mediaType: 'text/html',
    project: 'p',
    title: id,
    updatedAt: '2026-09-24T10:00:00.000Z',
  };
}

function memoryStore(): ThumbnailStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    has: (id) => files.has(id),
    read: (id) => files.get(id) ?? null,
    remove: (id) => {
      files.delete(id);
    },
    write: (id, bytes) => {
      files.set(id, bytes);
    },
  };
}

function fakeRenderer(
  render: (target: ThumbnailTarget) => Promise<Uint8Array | null>,
): ThumbnailRenderer & { calls: ThumbnailTarget[] } {
  const calls: ThumbnailTarget[] = [];
  return {
    calls,
    close: () => Promise.resolve(),
    render: (target) => {
      calls.push(target);
      return render(target);
    },
  };
}

const bytesFor = (id: string) => new TextEncoder().encode(`jpeg:${id}`);

describe('createThumbnailQueue', () => {
  it('defers rendering until started, then renders each id once in order', async () => {
    const store = memoryStore();
    const artifacts = new Map([
      ['a', artifact('a')],
      ['b', artifact('b')],
    ]);
    const renderer = fakeRenderer((target) => Promise.resolve(bytesFor(target.id)));
    const queue = createThumbnailQueue({ lookup: (id) => artifacts.get(id) ?? null, store });

    queue.enqueue('a');
    queue.enqueue('b');
    await queue.idle();
    expect(renderer.calls).toEqual([]);

    queue.start(renderer, 'http://127.0.0.1:3000');
    await queue.idle();

    expect(renderer.calls.map((call) => call.id)).toEqual(['a', 'b']);
    expect(renderer.calls[0]).toEqual({
      id: 'a',
      mediaType: 'text/html',
      url: 'http://127.0.0.1:3000/a/a',
    });
    expect(store.read('a')).toEqual(bytesFor('a'));
    expect(store.read('b')).toEqual(bytesFor('b'));
  });

  it('coalesces an id enqueued again while it is still pending', async () => {
    const store = memoryStore();
    const renderer = fakeRenderer((target) => Promise.resolve(bytesFor(target.id)));
    const queue = createThumbnailQueue({ lookup: artifact, store });

    queue.enqueue('a');
    queue.enqueue('a');
    queue.start(renderer, 'http://127.0.0.1:3000');
    await queue.idle();

    expect(renderer.calls).toHaveLength(1);
  });

  it('re-renders an id enqueued after its previous render finished', async () => {
    const store = memoryStore();
    const renderer = fakeRenderer((target) => Promise.resolve(bytesFor(target.id)));
    const queue = createThumbnailQueue({ lookup: artifact, store });
    queue.start(renderer, 'http://127.0.0.1:3000');

    queue.enqueue('a');
    await queue.idle();
    queue.enqueue('a');
    await queue.idle();

    expect(renderer.calls).toHaveLength(2);
  });

  it('skips an artifact that was removed before its turn', async () => {
    const store = memoryStore();
    const renderer = fakeRenderer((target) => Promise.resolve(bytesFor(target.id)));
    const queue = createThumbnailQueue({ lookup: () => null, store });
    queue.start(renderer, 'http://127.0.0.1:3000');

    queue.enqueue('gone');
    await queue.idle();

    expect(renderer.calls).toEqual([]);
    expect(store.files.size).toBe(0);
  });

  it('keeps draining after a renderer failure and reports it', async () => {
    const store = memoryStore();
    const reported: string[] = [];
    const renderer = fakeRenderer((target) =>
      target.id === 'bad'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(bytesFor(target.id)),
    );
    const queue = createThumbnailQueue({
      lookup: artifact,
      report: (message) => {
        reported.push(message);
      },
      store,
    });
    queue.start(renderer, 'http://127.0.0.1:3000');

    queue.enqueue('bad');
    queue.enqueue('good');
    await queue.idle();

    expect(store.has('bad')).toBe(false);
    expect(store.read('good')).toEqual(bytesFor('good'));
    expect(reported).toEqual(['Thumbnail render failed for bad: boom']);
  });

  it('writes nothing when the renderer declines with null', async () => {
    const store = memoryStore();
    const renderer = fakeRenderer(() => Promise.resolve(null));
    const queue = createThumbnailQueue({ lookup: artifact, store });
    queue.start(renderer, 'http://127.0.0.1:3000');

    queue.enqueue('a');
    await queue.idle();

    expect(store.files.size).toBe(0);
  });

  it('backfills only artifacts without a stored thumbnail', async () => {
    const store = memoryStore();
    store.write('have', bytesFor('have'));
    const renderer = fakeRenderer((target) => Promise.resolve(bytesFor(target.id)));
    const queue = createThumbnailQueue({ lookup: artifact, store });
    queue.start(renderer, 'http://127.0.0.1:3000');

    queue.backfill([artifact('have'), artifact('need')]);
    await queue.idle();

    expect(renderer.calls.map((call) => call.id)).toEqual(['need']);
  });
});
