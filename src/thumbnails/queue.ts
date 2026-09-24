import type { Artifact } from '../artifacts/types.js';
import type { ThumbnailRenderer, ThumbnailStore } from './types.js';

export type ThumbnailQueue = {
  // Queue every artifact that has no stored preview yet (boot-time catch-up).
  backfill: (artifacts: Artifact[]) => void;
  // Queue one artifact for (re-)rendering. Never throws and never blocks the
  // caller: a create/update returns as soon as the metadata is written.
  enqueue: (id: string) => void;
  // Resolves once nothing is rendering and nothing is waiting. For tests and
  // graceful shutdown; a queue that has not started resolves immediately.
  idle: () => Promise<void>;
  // Rendering needs the server's own address, which is only known after
  // listen — ids queued before this call wait and are rendered on start.
  start: (renderer: ThumbnailRenderer, baseUrl: string) => void;
};

type ThumbnailQueueDeps = {
  // Fresh metadata at render time: an artifact removed while it was waiting
  // is skipped, and an updated one renders its latest media type.
  lookup: (id: string) => Artifact | null;
  report?: (message: string) => void;
  store: ThumbnailStore;
};

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

// One render at a time, in enqueue order, so a burst of uploads never opens a
// pile of browser pages at once. Ids are kept in a Set, so an artifact queued
// twice before its turn renders once; queued again after, it renders again.
export function createThumbnailQueue({
  lookup,
  report = defaultReport,
  store,
}: ThumbnailQueueDeps): ThumbnailQueue {
  const pending = new Set<string>();
  let renderer: ThumbnailRenderer | undefined;
  let baseUrl = '';
  let draining: Promise<void> | undefined;

  async function renderOne(id: string): Promise<void> {
    const artifact = lookup(id);
    if (artifact === null || renderer === undefined) {
      return;
    }
    try {
      const bytes = await renderer.render({
        id,
        mediaType: artifact.mediaType,
        url: `${baseUrl}/a/${id}`,
      });
      if (bytes !== null) {
        store.write(id, bytes);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(`Thumbnail render failed for ${id}: ${message}`);
    }
  }

  // Takes the oldest pending id, renders it, and recurses until the set is
  // empty — sequential on purpose (see above), hence recursion, not a loop
  // of awaits.
  async function drain(): Promise<void> {
    const next = pending.values().next();
    if (next.done) {
      return;
    }
    pending.delete(next.value);
    await renderOne(next.value);
    await drain();
  }

  async function run(): Promise<void> {
    try {
      await drain();
    } finally {
      draining = undefined;
      // Anything enqueued while the last render was in flight.
      schedule();
    }
  }

  function schedule(): void {
    if (renderer === undefined || draining !== undefined || pending.size === 0) {
      return;
    }
    draining = run();
  }

  async function idle(): Promise<void> {
    const current = draining;
    if (current === undefined) {
      return;
    }
    await current;
    await idle();
  }

  return {
    backfill: (artifacts) => {
      for (const artifact of artifacts) {
        if (!store.has(artifact.id)) {
          pending.add(artifact.id);
        }
      }
      schedule();
    },
    enqueue: (id) => {
      pending.add(id);
      schedule();
    },
    idle,
    start: (nextRenderer, nextBaseUrl) => {
      renderer = nextRenderer;
      baseUrl = nextBaseUrl;
      schedule();
    },
  };
}
